// lib/stamp-rotating.ts
// 回転QR（固定ディスプレイ型）のコードと表示リンク（サーバー専用）。
//
// チェックポイントに固定したタブレット等が、数秒ごとに切り替わる QR を
// 表示する。コードは「チェックポイントID＋時刻ウィンドウ＋署名」で、
// 署名鍵はチェックポイントごとの秘密（Firestore の exhibitor ドキュメント
// の rotatingSecret。マッピング済みオブジェクトや公開APIには出さない）。
// 写真を撮っても次のウィンドウでは無効になるため、写真の持ち帰り・
// 共有による不正を防ぐ。
//
// 表示ページはログインなしで開くため、表示専用トークン（表示リンク）で
// 守る。トークンはそのチェックポイントの現在のコード取得だけに使え、
// ハッシュで保存する。再発行すると旧リンクは即無効になる。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { EVENT_EXHIBITORS_COLLECTION } from './event-coupon';
import { STAMP_CODE_ALPHABET } from './stamp-qr';

/** 回転QRの切り替え間隔（秒）。検証は現在＋1つ前のウィンドウまで許容。 */
export const ROTATING_WINDOW_SECONDS = 10;

/** 時刻（ミリ秒）からウィンドウ番号を作る。 */
export function rotatingWindowIndex(nowMs: number): number {
  return Math.floor(nowMs / 1000 / ROTATING_WINDOW_SECONDS);
}

/** 指定ウィンドウの終わりまでの残り秒数（表示ページの更新タイミング用）。 */
export function rotatingWindowRemainingSeconds(nowMs: number): number {
  const windowMs = ROTATING_WINDOW_SECONDS * 1000;
  const elapsedInWindow = nowMs % windowMs;
  return Math.max(1, Math.ceil((windowMs - elapsedInWindow) / 1000));
}

function rotatingSignature(
  secret: string,
  eventId: string,
  exhibitorId: string,
  windowIndex: number,
): string {
  return createHmac('sha256', secret)
    .update(`${eventId}.${exhibitorId}.${windowIndex}`)
    .digest('base64url');
}

/**
 * 回転QRのコード文字列を作る。
 * 形式: {exhibitorId}.{windowIndex}.{署名}
 * （exhibitorId は Firestore のドキュメントIDで '.' を含まない前提）
 */
export function buildRotatingCode(
  secret: string,
  eventId: string,
  exhibitorId: string,
  windowIndex: number,
): string {
  const signature = rotatingSignature(secret, eventId, exhibitorId, windowIndex);
  return `${exhibitorId}.${windowIndex}.${signature}`;
}

export interface ParsedRotatingCode {
  exhibitorId: string;
  windowIndex: number;
  signature: string;
}

/** 回転QRのコード文字列を分解する。形式が違うものは null。 */
export function parseRotatingCode(token: unknown): ParsedRotatingCode | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [exhibitorId, windowText, signature] = parts;
  if (!exhibitorId || !signature) return null;
  if (!/^\d+$/.test(windowText)) return null;
  const windowIndex = Number(windowText);
  if (!Number.isSafeInteger(windowIndex) || windowIndex < 0) return null;
  return { exhibitorId, windowIndex, signature };
}

/**
 * 回転QRのコードを検証する。現在のウィンドウと1つ前のウィンドウだけを
 * 受け付ける（読み取り・通信の遅れを吸収するため）。署名が合わない、
 * 形式が違う、古いコードはすべて null。
 */
export function verifyRotatingCode(
  secret: string,
  eventId: string,
  token: unknown,
  nowMs: number,
): { exhibitorId: string } | null {
  const parsed = parseRotatingCode(token);
  if (!parsed) return null;
  const currentWindow = rotatingWindowIndex(nowMs);
  if (
    parsed.windowIndex !== currentWindow &&
    parsed.windowIndex !== currentWindow - 1
  ) {
    return null;
  }
  const expected = rotatingSignature(
    secret,
    eventId,
    parsed.exhibitorId,
    parsed.windowIndex,
  );
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(parsed.signature);
  if (expectedBuffer.length !== actualBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, actualBuffer)) return null;
  return { exhibitorId: parsed.exhibitorId };
}

// ─── Firestore: 秘密と表示トークン ───

function exhibitorRef(db: Firestore, eventId: string, exhibitorId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId);
}

/**
 * チェックポイントの回転QR用秘密を読む（無ければ null）。
 * 秘密は exhibitor ドキュメントの rotatingSecret フィールドが正で、
 * mapExhibitor は拾わないため、画面やAPIに漏れることはない。
 */
export async function readExhibitorRotatingSecret(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<string | null> {
  const snap = await exhibitorRef(db, eventId, exhibitorId).get();
  if (!snap.exists) return null;
  const secret = snap.data()?.rotatingSecret;
  return typeof secret === 'string' && secret.length > 0 ? secret : null;
}

/** 回転QR用秘密を用意する（無ければ生成して保存する）。 */
export async function ensureExhibitorRotatingSecret(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<string | null> {
  const existing = await readExhibitorRotatingSecret(db, eventId, exhibitorId);
  if (existing) return existing;
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const secret = randomBytes(32).toString('hex');
  await ref.update({ rotatingSecret: secret });
  return secret;
}

/** 表示トークンの保存用ハッシュ。平文は保存しない。 */
export function hashDisplayToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const DISPLAY_TOKEN_LENGTH = 32;

/** 表示トークン（平文）を生成する。スタンプコードと同じ読みにくい文字集合。 */
export function generateDisplayToken(
  random: (size: number) => Buffer = randomBytes,
): string {
  const alphabet = STAMP_CODE_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let token = '';
  while (token.length < DISPLAY_TOKEN_LENGTH) {
    const bytes = random(DISPLAY_TOKEN_LENGTH - token.length + 8);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      token += alphabet[byte % alphabet.length];
      if (token.length >= DISPLAY_TOKEN_LENGTH) break;
    }
  }
  return token;
}

/**
 * 表示リンクを発行（再発行）する。平文トークンを返し、保存はハッシュだけ。
 * 再発行すると以前のトークンは使えなくなる。
 */
export async function issueExhibitorDisplayToken(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<string | null> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const token = generateDisplayToken();
  await ref.update({ displayTokenHash: hashDisplayToken(token) });
  return token;
}

/** 表示リンクが発行済みかどうか。 */
export async function hasExhibitorDisplayToken(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<boolean> {
  const snap = await exhibitorRef(db, eventId, exhibitorId).get();
  if (!snap.exists) return false;
  const hash = snap.data()?.displayTokenHash;
  return typeof hash === 'string' && hash.length > 0;
}

/** 表示トークンを検証する（ハッシュ同士の定数時間比較）。 */
export async function verifyExhibitorDisplayToken(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  token: unknown,
): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const snap = await exhibitorRef(db, eventId, exhibitorId).get();
  if (!snap.exists) return false;
  const stored = snap.data()?.displayTokenHash;
  if (typeof stored !== 'string' || !stored) return false;
  const expected = Buffer.from(stored);
  const actual = Buffer.from(hashDisplayToken(token));
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
