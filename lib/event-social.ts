// lib/event-social.ts
// Push-taro.スタンプラリー の Instagram 投稿キュー基盤（events/{eventId} 配下）。
//
// 仕様（2026-11-14 Ishii 決定）:
// - 投稿の起点は特設サイト／管理画面。主催者が投稿を作ると
//   「投稿待ちキュー」（socialPosts、status='queued'）に入る。
// - 実際の Instagram 投稿は製品ではなく **主催者自身の Muse** が行う
//   （製品に Graph API は組まない）。主催者の Muse が朝・昼・夜に
//   キュー確認 API を叩き、未投稿分を Instagram に投稿して、
//   完了 API で「投稿済み」（status='posted'）を付けに来る。
// - Muse 用 API の認証はプロジェクトごとの「連携キー」。
//   socialQueueKeys/{keyId} にハッシュだけを保存し、平文は発行時の
//   レスポンスで一度だけ返す（api-keys.ts / exhibitor-access.ts の流儀）。
// - キーのハッシュ化・照合は参加店アクセスコードと同じ scrypt 形式
//   （scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>）。
// - socialPosts / socialQueueKeys はリセット・終了削除の対象外
//   （電話番号を含まない台帳。reviews 等と同じ扱い）。
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

export const EVENT_SOCIAL_POSTS_COLLECTION = 'socialPosts';
export const EVENT_SOCIAL_QUEUE_KEYS_COLLECTION = 'socialQueueKeys';

/** 本文の上限。Instagram のキャプション上限（2,200字）に合わせる。 */
export const SOCIAL_POST_TEXT_MAX_LENGTH = 2200;
/** 写真の上限枚数（Instagram のカルーセル投稿を想定）。 */
export const SOCIAL_POST_PHOTO_MAX_COUNT = 4;

// ─── 型 ───

export type SocialPostStatus = 'queued' | 'posted';

export interface SocialPost {
  id: string;
  text: string;
  photoUrls: string[];
  status: SocialPostStatus;
  createdAt: string | null;
  postedAt: string | null;
  postedUrl: string | null;
}

export interface SocialQueueKeySummary {
  id: string;
  createdAt: string | null;
  revokedAt: string | null;
  revoked: boolean;
}

// ─── 純粋関数: 投稿入力の検証 ───

export interface ParsedSocialPostInput {
  text: string;
  photoUrls: string[];
}

export type ParseSocialPostResult =
  | { ok: true; value: ParsedSocialPostInput }
  | { ok: false; error: string };

/**
 * 投稿作成の入力検証（純粋関数）。
 * 本文は必須（空白のみは不可）で上限文字数まで。写真は最大4枚、
 * 各URLは https の文字列のみ。
 */
export function parseSocialPostInput(raw: unknown): ParseSocialPostResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'リクエスト形式が不正です' };
  }
  const source = raw as Record<string, unknown>;

  const text = typeof source.text === 'string' ? source.text.trim() : '';
  if (!text) {
    return { ok: false, error: '本文を入力してください' };
  }
  if (text.length > SOCIAL_POST_TEXT_MAX_LENGTH) {
    return {
      ok: false,
      error: `本文は${SOCIAL_POST_TEXT_MAX_LENGTH}文字以内で入力してください`,
    };
  }

  let photoUrls: string[] = [];
  if (source.photoUrls !== undefined) {
    if (!Array.isArray(source.photoUrls)) {
      return { ok: false, error: 'photoUrls の形式が不正です' };
    }
    if (source.photoUrls.length > SOCIAL_POST_PHOTO_MAX_COUNT) {
      return {
        ok: false,
        error: `写真は${SOCIAL_POST_PHOTO_MAX_COUNT}枚までです`,
      };
    }
    for (const url of source.photoUrls) {
      if (typeof url !== 'string' || !url.startsWith('https://')) {
        return { ok: false, error: 'photoUrls の形式が不正です' };
      }
    }
    photoUrls = source.photoUrls as string[];
  }

  return { ok: true, value: { text, photoUrls } };
}

/**
 * 完了報告（postedUrl）の検証（純粋関数）。postedUrl は任意で、
 * 渡す場合は https の URL 文字列のみ受け付ける。
 */
export function parsePostedUrl(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: null };
  }
  if (typeof raw !== 'string' || !raw.startsWith('https://') || raw.length > 2048) {
    return { ok: false, error: 'postedUrl の形式が不正です' };
  }
  return { ok: true, value: raw };
}

// ─── 純粋関数: 並び替え ───

/** 新しい順（作成日時。無ければ id で安定させる）。管理画面の一覧用。 */
export function sortSocialPostsNewestFirst(posts: SocialPost[]): SocialPost[] {
  return [...posts].sort((a, b) => {
    const aKey = a.createdAt ?? '';
    const bKey = b.createdAt ?? '';
    return bKey.localeCompare(aKey) || b.id.localeCompare(a.id);
  });
}

/** 古い順。Muse 用キューは先入れ先出しで古いものから投稿させる。 */
export function sortSocialPostsOldestFirst(posts: SocialPost[]): SocialPost[] {
  return [...posts].sort((a, b) => {
    const aKey = a.createdAt ?? '';
    const bKey = b.createdAt ?? '';
    return aKey.localeCompare(bKey) || a.id.localeCompare(b.id);
  });
}

// ─── 連携キー: 生成・ハッシュ化・照合 ───

export interface QueueKeyMaterial {
  keyId: string;
  key: string;
}

/** 新しい連携キーの素材を生成する（純粋関数）。平文は一度だけ返す。 */
export function generateQueueKeyMaterial(): QueueKeyMaterial {
  return {
    keyId: `qkey_${randomBytes(9).toString('hex')}`,
    key: randomBytes(32).toString('base64url'),
  };
}

function scryptAsync(
  secret: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

// 保存形式: scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
// 参加店アクセスコード（lib/exhibitor-access.ts）と同一形式・同一パラメータ。
export async function hashQueueKey(key: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scryptAsync(key, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

/**
 * 照合（タイミング安全な比較）。保存値が無い・壊れている場合は false。
 * 保存値側のパラメータが想定外に大きい場合は DoS 回避のため照合しない。
 */
export async function verifyQueueKeyHash(
  key: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || N <= 1 || N > 2 ** 20 || (N & (N - 1)) !== 0) {
    return false;
  }
  if (!Number.isInteger(r) || r < 1 || r > 16) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (salt.length === 0 || salt.length > 64) return false;
  if (expected.length === 0 || expected.length > 64) return false;
  try {
    const derived = (await scryptAsync(key, salt, expected.length, {
      N,
      r,
      p,
    })) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/**
 * キーが1件も無い場合のタイミング均一化用ダミー。照合時間の差で
 * 「キーが発行されているか」を推測されないようにするためのもので、
 * 実際のキーとは一致しない。
 */
const DUMMY_QUEUE_KEY_HASH =
  'scrypt$16384$8$1$mmV4w7GCRl8JUvzfPkJDYw$jAhcM__gqKRn5yNkGFL4mVlGChUCkzzhadXAPOIzvpE';

// ─── 写真 ───

/** 投稿写真の保存先パス。 */
export function socialPhotoStoragePath(
  eventId: string,
  fileName: string,
): string {
  return `events/${eventId}/social-photos/${fileName}`;
}

// ─── Firestore 読み書き ───

function postsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_SOCIAL_POSTS_COLLECTION);
}

function queueKeysRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_SOCIAL_QUEUE_KEYS_COLLECTION);
}

function toIsoString(value: unknown): string | null {
  const timestamp = value as { toDate?: () => Date } | undefined;
  return timestamp?.toDate?.().toISOString() ?? null;
}

function mapSocialPost(
  id: string,
  data: FirebaseFirestore.DocumentData,
): SocialPost {
  const photoUrls = Array.isArray(data.photoUrls)
    ? data.photoUrls.filter((url): url is string => typeof url === 'string')
    : [];
  return {
    id,
    text: String(data.text ?? ''),
    photoUrls,
    status: data.status === 'posted' ? 'posted' : 'queued',
    createdAt: toIsoString(data.createdAt),
    postedAt: toIsoString(data.postedAt),
    postedUrl:
      typeof data.postedUrl === 'string' && data.postedUrl
        ? data.postedUrl
        : null,
  };
}

/** 投稿を作成してキュー（投稿待ち）に入れる。 */
export async function createSocialPost(
  db: Firestore,
  eventId: string,
  value: ParsedSocialPostInput,
): Promise<SocialPost> {
  const ref = postsRef(db, eventId).doc();
  await ref.set({
    text: value.text,
    photoUrls: value.photoUrls,
    status: 'queued',
    createdAt: FieldValue.serverTimestamp(),
    postedAt: null,
    postedUrl: null,
  });
  const snap = await ref.get();
  return mapSocialPost(snap.id, snap.data() ?? {});
}

/** プロジェクトの全投稿（管理画面用、投稿済みも含む、新しい順）。 */
export async function listSocialPosts(
  db: Firestore,
  eventId: string,
): Promise<SocialPost[]> {
  const snap = await postsRef(db, eventId).get();
  return sortSocialPostsNewestFirst(
    snap.docs.map((doc) => mapSocialPost(doc.id, doc.data())),
  );
}

/** 投稿待ち（queued）だけを古い順に返す。Muse 用キューの実体。 */
export async function listQueuedPosts(
  db: Firestore,
  eventId: string,
): Promise<SocialPost[]> {
  const snap = await postsRef(db, eventId)
    .where('status', '==', 'queued')
    .get();
  return sortSocialPostsOldestFirst(
    snap.docs.map((doc) => mapSocialPost(doc.id, doc.data())),
  );
}

export type DeleteSocialPostResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/** 投稿の削除。投稿待ち（queued）のものだけ削除できる。 */
export async function deleteQueuedPost(
  db: Firestore,
  eventId: string,
  postId: string,
): Promise<DeleteSocialPostResult> {
  const ref = postsRef(db, eventId).doc(postId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: '投稿が見つかりません' };
  }
  if (snap.data()?.status === 'posted') {
    return {
      ok: false,
      status: 409,
      error: '投稿済みの投稿は削除できません',
    };
  }
  await ref.delete();
  return { ok: true };
}

export type MarkPostPostedResult =
  | { ok: true; post: SocialPost; alreadyPosted: boolean }
  | { ok: false; status: number; error: string };

/**
 * 投稿を「投稿済み」にする（Muse の完了報告）。
 * 既に投稿済みなら、そのまま成功を返す（冪等。postedAt / postedUrl は
 * 最初の報告のものを保持する）。
 */
export async function markPostPosted(
  db: Firestore,
  eventId: string,
  postId: string,
  postedUrl: string | null,
): Promise<MarkPostPostedResult> {
  const ref = postsRef(db, eventId).doc(postId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: '投稿が見つかりません' };
  }
  const current = mapSocialPost(snap.id, snap.data() ?? {});
  if (current.status === 'posted') {
    return { ok: true, post: current, alreadyPosted: true };
  }
  await ref.update({
    status: 'posted',
    postedAt: FieldValue.serverTimestamp(),
    postedUrl,
  });
  const updated = await ref.get();
  return {
    ok: true,
    post: mapSocialPost(updated.id, updated.data() ?? {}),
    alreadyPosted: false,
  };
}

// ─── 連携キー（Firestore） ───

/**
 * 連携キーを発行する。戻り値の key（平文）はこの一度だけ表示する前提。
 * ドキュメントにはハッシュだけを保存する。
 */
export async function issueQueueKey(
  db: Firestore,
  eventId: string,
): Promise<QueueKeyMaterial> {
  const material = generateQueueKeyMaterial();
  const keyHash = await hashQueueKey(material.key);
  await queueKeysRef(db, eventId).doc(material.keyId).set({
    keyHash,
    createdAt: FieldValue.serverTimestamp(),
    revokedAt: null,
  });
  return material;
}

function mapQueueKeySummary(
  id: string,
  data: FirebaseFirestore.DocumentData,
): SocialQueueKeySummary {
  const revokedAt = toIsoString(data.revokedAt);
  return {
    id,
    createdAt: toIsoString(data.createdAt),
    revokedAt,
    revoked: revokedAt !== null,
  };
}

/** 発行済みキーのメタ情報一覧（平文・ハッシュは出さない、新しい順）。 */
export async function listQueueKeys(
  db: Firestore,
  eventId: string,
): Promise<SocialQueueKeySummary[]> {
  const snap = await queueKeysRef(db, eventId).get();
  return snap.docs
    .map((doc) => mapQueueKeySummary(doc.id, doc.data()))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

/** キーを失効させる。存在しなければ false。 */
export async function revokeQueueKey(
  db: Firestore,
  eventId: string,
  keyId: string,
): Promise<boolean> {
  const ref = queueKeysRef(db, eventId).doc(keyId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (snap.data()?.revokedAt) return true;
  await ref.update({ revokedAt: FieldValue.serverTimestamp() });
  return true;
}

/**
 * Muse 用 API のキー認証。プロジェクトの有効な（未失効の）キーの
 * いずれかと一致すれば true。一致するキーが1件も無い場合はダミー照合で
 * 時間を均し、「キーが発行されているか」を時間差で推測させない。
 */
export async function verifyQueueKey(
  db: Firestore,
  eventId: string,
  presented: string | null | undefined,
): Promise<boolean> {
  const key = typeof presented === 'string' ? presented.trim() : '';
  if (!key) return false;
  const snap = await queueKeysRef(db, eventId).get();
  const candidates = snap.docs.filter((doc) => {
    const data = doc.data();
    return !data.revokedAt && typeof data.keyHash === 'string' && data.keyHash;
  });
  if (candidates.length === 0) {
    await verifyQueueKeyHash(key, DUMMY_QUEUE_KEY_HASH);
    return false;
  }
  for (const doc of candidates) {
    if (await verifyQueueKeyHash(key, doc.data().keyHash as string)) {
      return true;
    }
  }
  return false;
}
