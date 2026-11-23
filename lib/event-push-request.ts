// lib/event-push-request.ts
// Push-taro.スタンプラリー の「参加店からのプッシュ配信申請」。
//
// 仕組み:
// - 参加店が店舗ページで配信のタイトル・本文を作って申請する。
//   文面は作成時に全言語へ自動翻訳して持つ（主催者の配信と同じ作法）。
// - 手数料（プロジェクト設定 pushPrice、1回あたり）:
//   - 無料（0円・未設定）: 申請はそのまま主催者の承認待ちになる。
//   - 有料: 先に主催者自身の Stripe で支払い（lib/event-charges.ts）、
//     支払いが確認できてから承認待ちになる。未払いの申請は主催者の
//     承認キューに出ない。
// - 主催者が承認すると、その場で通常の配信（campaigns）として実行
//   される。却下すると申請は破棄され、状態だけが店に残る。
// - 主催者自身の配信（campaigns API）は従来どおりで、この申請とは別。
import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import { parseLocalizedTexts, type Locale } from './i18n';
import { translateText } from './translate';
import {
  createCampaignRecord,
  executeCampaign,
  getCampaign,
  jstDateTimeString,
} from './event-push';
import { getEvent } from './event-store';

export const EVENT_PUSH_REQUESTS_COLLECTION = 'pushRequests';

/**
 * 申請の状態。
 * - unpaid: 有料で支払い待ち（主催者の承認キューには出ない）
 * - pending: 主催者の承認待ち
 * - sent: 承認され、配信済み
 * - rejected: 主催者に却下された
 * - failed: 承認されたが配信に失敗した
 */
export type ShopPushRequestStatus =
  | 'unpaid'
  | 'pending'
  | 'sent'
  | 'rejected'
  | 'failed';

export interface ShopPushRequest {
  id: string;
  exhibitorId: string;
  exhibitorName: string;
  title: string;
  body: string;
  /** タイトルの言語別マップ（作成時に自動翻訳） */
  titleI18n: Partial<Record<Locale, string>>;
  /** 本文の言語別マップ（同上） */
  bodyI18n: Partial<Record<Locale, string>>;
  status: ShopPushRequestStatus;
  /** 作成時点の手数料スナップショット（円）。0 は無料 */
  feeAmount: number;
  /** 支払い用 Checkout セッションID（有料・発行済みのとき） */
  chargeSessionId: string | null;
  /** 承認時に作られた配信（campaigns）のID。未送信は null */
  campaignId: string | null;
  /** 送信時点の購読者数。未送信は null */
  sentCount: number | null;
  /** 配信失敗の理由。失敗時以外は null */
  error: string | null;
  createdAt: string;
  /** 承認・却下の日時。未決定は null */
  decidedAt: string | null;
  /** 送信日時。未送信は null */
  sentAt: string | null;
}

// ─── 純粋関数: 状態遷移 ───

/** 保存済みの状態を防御的に読む（読み取り用）。未知の値は 'pending' に倒す。 */
export function parsePushRequestStatus(value: unknown): ShopPushRequestStatus {
  return value === 'unpaid' ||
    value === 'sent' ||
    value === 'rejected' ||
    value === 'failed'
    ? value
    : 'pending';
}

/** 作成直後の状態（純粋関数）。手数料が有料なら支払い待ち、無料なら承認待ち。 */
export function initialPushRequestStatus(feeAmount: number): ShopPushRequestStatus {
  return feeAmount > 0 ? 'unpaid' : 'pending';
}

/**
 * 支払い確認後の遷移（純粋関数）。
 * 'unpaid' のときだけ 'pending' になり、それ以外は null（遷移しない）。
 * 既に承認待ち・送信済み等への二重適用を防ぐための判定。
 */
export function paidPushRequestStatus(
  current: ShopPushRequestStatus,
): ShopPushRequestStatus | null {
  return current === 'unpaid' ? 'pending' : null;
}

/**
 * 却下の遷移（純粋関数）。承認待ちのときだけ却下できる。
 * 未払いの申請は承認キューの対象外なので却下もできない。
 */
export function rejectedPushRequestStatus(
  current: ShopPushRequestStatus,
): ShopPushRequestStatus | null {
  return current === 'pending' ? 'rejected' : null;
}

/** 主催者の承認キューに出すかどうか（純粋関数）。支払い済み・無料の承認待ちだけ。 */
export function isPushRequestApprovable(status: ShopPushRequestStatus): boolean {
  return status === 'pending';
}

/** 保存済みドキュメントを防御的に読む（読み取り用。throw しない）。 */
export function parsePushRequest(
  id: string,
  data: Record<string, unknown>,
): ShopPushRequest {
  const timestamp = (value: unknown): string | null => {
    if (typeof value === 'string' && value) return value;
    const asDate = (value as { toDate?: () => Date } | null)?.toDate?.();
    return asDate ? asDate.toISOString() : null;
  };
  return {
    id,
    exhibitorId: String(data.exhibitorId ?? ''),
    exhibitorName: String(data.exhibitorName ?? ''),
    title: String(data.title ?? ''),
    body: String(data.body ?? ''),
    titleI18n: parseLocalizedTexts(data.titleI18n),
    bodyI18n: parseLocalizedTexts(data.bodyI18n),
    status: parsePushRequestStatus(data.status),
    feeAmount: typeof data.feeAmount === 'number' ? data.feeAmount : 0,
    chargeSessionId:
      typeof data.chargeSessionId === 'string' && data.chargeSessionId
        ? data.chargeSessionId
        : null,
    campaignId:
      typeof data.campaignId === 'string' && data.campaignId
        ? data.campaignId
        : null,
    sentCount: typeof data.sentCount === 'number' ? data.sentCount : null,
    error: typeof data.error === 'string' && data.error ? data.error : null,
    createdAt: timestamp(data.createdAt) ?? '',
    decidedAt: timestamp(data.decidedAt),
    sentAt: timestamp(data.sentAt),
  };
}

// ─── Firestore ───

function pushRequestsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_PUSH_REQUESTS_COLLECTION);
}

function pushRequestRef(db: Firestore, eventId: string, requestId: string) {
  return pushRequestsRef(db, eventId).doc(requestId);
}

export interface CreatePushRequestInput {
  exhibitorId: string;
  exhibitorName: string;
  title: string;
  body: string;
  /** 作成時点の手数料（円）。0 は無料 */
  feeAmount: number;
}

/**
 * 申請を作る。文面は作成時に翻訳を揃える（主催者の配信と同じ作法）。
 * 状態は手数料で決まる（有料=支払い待ち／無料=承認待ち）。
 */
export async function createPushRequest(
  db: Firestore,
  eventId: string,
  input: CreatePushRequestInput,
): Promise<ShopPushRequest> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title) throw new Error('タイトルが必要です');
  if (!body) throw new Error('本文が必要です');
  const feeAmount = Math.max(0, Math.floor(input.feeAmount));
  const [titleI18n, bodyI18n] = await Promise.all([
    translateText(title),
    translateText(body),
  ]);
  const ref = pushRequestsRef(db, eventId).doc();
  const status = initialPushRequestStatus(feeAmount);
  await ref.set({
    exhibitorId: input.exhibitorId,
    exhibitorName: input.exhibitorName,
    title,
    body,
    titleI18n,
    bodyI18n,
    status,
    feeAmount,
    chargeSessionId: null,
    campaignId: null,
    sentCount: null,
    error: null,
    createdAt: FieldValue.serverTimestamp(),
    decidedAt: null,
    sentAt: null,
  });
  const created = await ref.get();
  return parsePushRequest(ref.id, created.data() ?? {});
}

export async function getPushRequest(
  db: Firestore,
  eventId: string,
  requestId: string,
): Promise<ShopPushRequest | null> {
  const snap = await pushRequestRef(db, eventId, requestId).get();
  if (!snap.exists) return null;
  return parsePushRequest(snap.id, snap.data() ?? {});
}

/** 自店の申請一覧（新しい順）。 */
export async function listPushRequestsForShop(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<ShopPushRequest[]> {
  const snap = await pushRequestsRef(db, eventId)
    .where('exhibitorId', '==', exhibitorId)
    .get();
  return snap.docs
    .map((doc) => parsePushRequest(doc.id, doc.data()))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * 管理画面用: 申請の一覧。
 * 承認待ち（古い順）を先に、次に未払い、それ以外は新しい順に並べる。
 */
export async function listPushRequestsForAdmin(
  db: Firestore,
  eventId: string,
): Promise<ShopPushRequest[]> {
  const snap = await pushRequestsRef(db, eventId).get();
  const requests = snap.docs.map((doc) => parsePushRequest(doc.id, doc.data()));
  const rank = (r: ShopPushRequest): number =>
    r.status === 'pending' ? 0 : r.status === 'unpaid' ? 1 : 2;
  return requests.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (rank(a) === 0) return a.createdAt.localeCompare(b.createdAt);
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * 支払い用 Checkout セッションIDを申請に控える（再開できるように）。
 * 支払い待ちの申請だけが対象。
 */
export async function setPushRequestChargeSession(
  db: Firestore,
  eventId: string,
  requestId: string,
  sessionId: string,
): Promise<void> {
  await pushRequestRef(db, eventId, requestId).update({
    chargeSessionId: sessionId,
  });
}

/**
 * 支払いの確認を反映する（純粋遷移 paidPushRequestStatus に従う）。
 * 既に承認待ち以降なら何もしない（冪等）。戻り値は遷移後の申請。
 */
export async function markPushRequestPaid(
  db: Firestore,
  eventId: string,
  requestId: string,
): Promise<ShopPushRequest | null> {
  const ref = pushRequestRef(db, eventId, requestId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const current = parsePushRequest(snap.id, snap.data() ?? {});
  const next = paidPushRequestStatus(current.status);
  if (!next) return current;
  await ref.update({ status: next });
  return { ...current, status: next };
}

/** 主催者の却下。承認待ちでなければ 409 相当のエラーを返す。 */
export type RejectPushRequestResult =
  | { ok: true; request: ShopPushRequest }
  | { ok: false; status: number; error: string };

export async function rejectPushRequest(
  db: Firestore,
  eventId: string,
  requestId: string,
): Promise<RejectPushRequestResult> {
  const ref = pushRequestRef(db, eventId, requestId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: '申請が見つかりません' };
  }
  const current = parsePushRequest(snap.id, snap.data() ?? {});
  const next = rejectedPushRequestStatus(current.status);
  if (!next) {
    return { ok: false, status: 409, error: '承認待ちの申請だけを却下できます' };
  }
  const decidedAt = new Date().toISOString();
  await ref.update({ status: next, decidedAt });
  return { ok: true, request: { ...current, status: next, decidedAt } };
}

export type ApprovePushRequestResult =
  | { ok: true; request: ShopPushRequest }
  | { ok: false; status: number; error: string };

/**
 * 主催者の承認: 申請を通常の配信（campaigns）として作り、その場で
 * 実行する。配信できたら申請は 'sent'、失敗したら 'failed'（理由付き）
 * になる。どちらも申請としては「決定済み」として扱う。
 * 二重送信防止は campaigns 側の executeCampaign の確保に任せる。
 */
export async function approveAndSendPushRequest(
  db: Firestore,
  eventId: string,
  requestId: string,
): Promise<ApprovePushRequestResult> {
  const ref = pushRequestRef(db, eventId, requestId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: '申請が見つかりません' };
  }
  const current = parsePushRequest(snap.id, snap.data() ?? {});
  if (!isPushRequestApprovable(current.status)) {
    return { ok: false, status: 409, error: '承認待ちの申請だけを承認できます' };
  }
  const event = await getEvent(eventId);
  if (!event) {
    return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  }
  const decidedAt = new Date().toISOString();
  const campaign = await createCampaignRecord(eventId, {
    title: current.title,
    body: current.body,
    kind: 'instant',
    scheduledAt: jstDateTimeString(new Date()),
    ownerUid: event.ownerUid,
    attachment: null,
  });
  const result = await executeCampaign(eventId, campaign.id);
  if (!result.sent) {
    await ref.update({
      status: 'failed',
      campaignId: campaign.id,
      error: result.reason,
      decidedAt,
    });
    const updated = await getPushRequest(db, eventId, requestId);
    return { ok: true, request: updated ?? current };
  }
  const executed = await getCampaign(eventId, campaign.id);
  await ref.update({
    status: 'sent',
    campaignId: campaign.id,
    sentCount: result.sentCount,
    sentAt: executed?.sentAt ?? decidedAt,
    error: null,
    decidedAt,
  });
  const updated = await getPushRequest(db, eventId, requestId);
  return { ok: true, request: updated ?? current };
}
