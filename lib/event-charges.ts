// lib/event-charges.ts
// Push-taro.スタンプラリー の「参加店の単発課金」レール（クーポン発行・
// プッシュ配信申請の手数料）。
//
// 仕組み:
// - 手数料はプロジェクト設定（couponIssuePrice / pushPrice、1件・
//   1回あたり）。未設定・0円は無料で、課金自体が発生しない。
// - 有料のときは「主催者自身の Stripe」（lib/event-billing.ts）で
//   都度払い（Checkout・mode: 'payment'）にする。月額のトップ掲載・
//   広告（サブスクリプション）とは metadata.kind で区別する:
//   'coupon-issue'（クーポン発行）/ 'push-send'（プッシュ配信申請）。
// - 支払いの確定は2経路で冪等に反映する:
//   1. 店が Checkout から戻ったときにサーバーがセッションを照会して
//      検証する（verifyAndApplyCharge）。
//   2. Webhook の checkout.session.completed（applyChargeWebhookEffect）。
//   支払い記録は共用の billingPayments に kind を付けて残す
//   （ドキュメントID = Checkout セッションID で両経路を冪等化する）。
// - 反映先: クーポンは支払い待ち→有効化（lib/event-coupon.ts の
//   activatePaidCoupon）、プッシュ申請は支払い待ち→承認待ち
//   （lib/event-push-request.ts の markPushRequestPaid）。
import type { Firestore } from 'firebase-admin/firestore';
import { resolveAppOrigin } from './app-origin';
import {
  BILLING_PAYMENTS_COLLECTION,
  createStripeClient,
  getStripeBillingSettings,
  type StripeWebhookEventLike,
} from './event-billing';
import {
  EVENT_COUPONS_COLLECTION,
  EVENT_EXHIBITORS_COLLECTION,
  activatePaidCoupon,
  getCoupon,
} from './event-coupon';
import { getPushRequest, markPushRequestPaid } from './event-push-request';
import { isShopPubliclyListed, parseShopProfile } from './event-shop';
import type { EventConfig } from './event';

/** Checkout / 支払い記録の metadata.kind（クーポン発行）。 */
export const COUPON_ISSUE_KIND = 'coupon-issue';
/** Checkout / 支払い記録の metadata.kind（プッシュ配信申請）。 */
export const PUSH_SEND_KIND = 'push-send';

export type ChargeKind = typeof COUPON_ISSUE_KIND | typeof PUSH_SEND_KIND;

export function isChargeKind(value: unknown): value is ChargeKind {
  return value === COUPON_ISSUE_KIND || value === PUSH_SEND_KIND;
}

// ─── 純粋関数: 手数料の解決 ───

/**
 * クーポン発行手数料の実効値（円）。未設定（null）は無料（0円）。
 * 料金の検証・正規化は lib/event.ts の parse/normalize が担う。
 */
export function couponIssueFeeOf(
  event: Pick<EventConfig, 'couponIssuePrice'>,
): number {
  return event.couponIssuePrice ?? 0;
}

/** プッシュ配信手数料の実効値（円）。未設定（null）は無料（0円）。 */
export function pushFeeOf(event: Pick<EventConfig, 'pushPrice'>): number {
  return event.pushPrice ?? 0;
}

/** 手数料が有料かどうか（Checkout が必要か）。 */
export function chargeRequiresPayment(feeAmount: number): boolean {
  return feeAmount > 0;
}

// ─── 純粋関数: Checkout セッションの解釈 ───

export interface InterpretedCheckoutSession {
  sessionId: string;
  kind: ChargeKind;
  eventId: string;
  exhibitorId: string;
  /** 課金対象のID（クーポンID または プッシュ申請ID） */
  targetId: string;
  /** セッションの請求額（円） */
  amountTotal: number;
  /** 支払いが完了しているか（payment_status = 'paid'） */
  paid: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Stripe Checkout セッション（mode: 'payment'）を、こちらの単発課金
 * として解釈する。metadata.kind が単発課金のものでない、または
 * 対象の特定に必要な metadata が欠けていれば null。
 * 照会（verify）と Webhook の両経路で共用する。
 */
export function interpretCheckoutSession(
  session: unknown,
): InterpretedCheckoutSession | null {
  const record = asRecord(session);
  if (!record || record.mode !== 'payment') return null;
  const metadata = asRecord(record.metadata);
  const kind = metadata?.kind;
  if (!isChargeKind(kind)) return null;
  const sessionId = stringOrNull(record.id);
  const eventId = metadata ? stringOrNull(metadata.eventId) : null;
  const exhibitorId = metadata ? stringOrNull(metadata.exhibitorId) : null;
  const targetId = metadata ? stringOrNull(metadata.targetId) : null;
  if (!sessionId || !eventId || !exhibitorId || !targetId) return null;
  return {
    sessionId,
    kind,
    eventId,
    exhibitorId,
    targetId,
    amountTotal: numberOrZero(record.amount_total),
    paid: record.payment_status === 'paid',
  };
}

// ─── 純粋関数: Webhook イベントの効果 ───

export interface ChargeWebhookEffect extends InterpretedCheckoutSession {
  occurredAt: string;
}

function unixToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/**
 * 単発課金宛の Webhook イベントを効果に変換する。
 * checkout.session.completed（mode: 'payment'、kind が単発課金、
 * payment_status が 'paid'）だけが対象。それ以外は null。
 */
export function effectFromStripeEventForCharge(
  event: StripeWebhookEventLike,
): ChargeWebhookEffect | null {
  if (event.type !== 'checkout.session.completed') return null;
  const interpreted = interpretCheckoutSession(event.data?.object);
  if (!interpreted || !interpreted.paid) return null;
  return {
    ...interpreted,
    occurredAt: unixToIso(event.created) ?? new Date().toISOString(),
  };
}

// ─── 店の利用可否（掲載状態） ───

/**
 * 課金つき機能（クーポン発行・プッシュ申請）を使える店かどうか。
 * 既存の公開判定と同じ規則: プロフィールが掲載中（published）で、
 * 店舗課金による掲載停止（billingSuspended）を受けていないこと。
 * 協賛（広告専用）アカウントの遮断は呼び出し側（ルート）が kind で行う。
 */
export async function isShopListedForCharges(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<boolean> {
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId)
    .get();
  if (!snap.exists) return false;
  const profile = parseShopProfile(snap.data()?.profile);
  return isShopPubliclyListed(profile, snap.data()?.billingSuspended);
}

// ─── Checkout セッション発行（都度払い） ───

export interface StartOneTimeChargeInput {
  contractId: string;
  eventId: string;
  exhibitorId: string;
  kind: ChargeKind;
  /** 課金対象のID（クーポンID または プッシュ申請ID） */
  targetId: string;
  /** 手数料（円）。呼び出し時点のスナップショットと一致させること */
  amount: number;
}

export type StartOneTimeChargeResult =
  | { ok: true; sessionId: string; checkoutUrl: string }
  | { ok: false; status: number; error: string };

const CHARGE_PRODUCT_NAMES: Record<ChargeKind, string> = {
  [COUPON_ISSUE_KIND]: 'Push-taro.スタンプラリー クーポン発行手数料',
  [PUSH_SEND_KIND]: 'Push-taro.スタンプラリー プッシュ配信手数料',
};

/**
 * 都度払いの Checkout セッションを発行する（主催者自身の Stripe）。
 * 戻り先は店舗ページ（?charge=success&session_id=...）。戻った店が
 * 照会 API を叩くことで支払いが反映される（Webhook でも冪等に反映）。
 */
export async function startOneTimeCharge(
  db: Firestore,
  input: StartOneTimeChargeInput,
): Promise<StartOneTimeChargeResult> {
  const settings = await getStripeBillingSettings(db, input.contractId);
  if (!settings) {
    return {
      ok: false,
      status: 400,
      error: 'Stripe設定が未完了のため、現在お支払いできません',
    };
  }
  const stripe = createStripeClient(settings.secretKey);
  const origin = resolveAppOrigin();
  const metadata = {
    kind: input.kind,
    contractId: input.contractId,
    eventId: input.eventId,
    exhibitorId: input.exhibitorId,
    targetId: input.targetId,
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'jpy',
          unit_amount: input.amount,
          product_data: { name: CHARGE_PRODUCT_NAMES[input.kind] },
        },
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${origin}/e/${input.eventId}/shop?charge=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/e/${input.eventId}/shop?charge=canceled`,
  });
  if (!session.url) {
    return { ok: false, status: 502, error: '支払いページの発行に失敗しました' };
  }
  return { ok: true, sessionId: session.id, checkoutUrl: session.url };
}

/** クーポンに支払い用セッションIDを控える（支払いの再開・照合用）。 */
export async function setCouponChargeSession(
  db: Firestore,
  eventId: string,
  couponId: string,
  sessionId: string,
): Promise<void> {
  await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_COUPONS_COLLECTION)
    .doc(couponId)
    .update({ chargeSessionId: sessionId });
}

// ─── 支払いの反映（記録＋有効化） ───

export interface ApplyChargeEffectInput {
  eventId: string;
  kind: ChargeKind;
  exhibitorId: string;
  targetId: string;
  sessionId: string;
  amount: number;
  paidAt: string;
  /** Webhook 経由のときの Stripe イベントID。照会経由は null */
  stripeEventId: string | null;
}

export interface ApplyChargeEffectResult {
  applied: boolean;
  /** 支払い記録が既にあった（両経路の二重反映） */
  duplicate: boolean;
  reason?: string;
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

/**
 * 支払いをローカルへ反映する: 支払い記録を作り（冪等）、対象を
 * 支払い済みの状態へ進める。
 * - coupon-issue: クーポンの feeAmount スナップショットと金額を
 *   突き合わせ、一致すれば有効化する。
 * - push-send: 申請の feeAmount と突き合わせ、一致すれば承認待ちにする。
 * 金額が一致しない場合は記録だけ残し、有効化しない（applied: false）。
 */
export async function applyChargeEffect(
  db: Firestore,
  input: ApplyChargeEffectInput,
): Promise<ApplyChargeEffectResult> {
  // 対象と金額スナップショットの確認
  let expectedAmount: number | null;
  if (input.kind === COUPON_ISSUE_KIND) {
    const coupon = await getCoupon(input.eventId, input.targetId);
    if (!coupon || coupon.exhibitorId !== input.exhibitorId) {
      return { applied: false, duplicate: false, reason: 'target-not-found' };
    }
    expectedAmount = coupon.feeAmount;
  } else {
    const pushRequest = await getPushRequest(db, input.eventId, input.targetId);
    if (!pushRequest || pushRequest.exhibitorId !== input.exhibitorId) {
      return { applied: false, duplicate: false, reason: 'target-not-found' };
    }
    expectedAmount = pushRequest.feeAmount;
  }

  // 支払い記録（ドキュメントID = セッションID で両経路を冪等化）
  let duplicate = false;
  const paymentRef = db
    .collection('events')
    .doc(input.eventId)
    .collection(BILLING_PAYMENTS_COLLECTION)
    .doc(input.sessionId);
  try {
    await paymentRef.create({
      exhibitorId: input.exhibitorId,
      kind: input.kind,
      targetId: input.targetId,
      amount: input.amount,
      status: 'paid',
      paidAt: input.paidAt,
      occurredAt: input.paidAt,
      stripeEventId: input.stripeEventId,
      stripeInvoiceId: null,
      stripeCheckoutSessionId: input.sessionId,
    });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    duplicate = true;
  }

  if (expectedAmount !== null && expectedAmount !== input.amount) {
    return { applied: false, duplicate, reason: 'amount-mismatch' };
  }

  // 対象を支払い済みの状態へ（どちらも冪等）
  if (input.kind === COUPON_ISSUE_KIND) {
    await activatePaidCoupon(input.eventId, input.targetId);
    const coupon = await getCoupon(input.eventId, input.targetId);
    const done = coupon !== null && coupon.active && !coupon.paymentPending;
    return { applied: done, duplicate, ...(done ? {} : { reason: 'not-pending' }) };
  }
  const request = await markPushRequestPaid(db, input.eventId, input.targetId);
  const done = request !== null && request.status !== 'unpaid';
  return { applied: done, duplicate, ...(done ? {} : { reason: 'not-pending' }) };
}

// ─── 照会による検証と反映（Checkout からの戻り） ───

export type VerifyChargeResult =
  | { ok: true; applied: boolean; duplicate: boolean; kind: ChargeKind; targetId: string }
  | { ok: false; status: number; error: string };

/**
 * 店が Checkout から戻ったときの検証: 主催者の Stripe でセッションを
 * 照会し、支払い済みで、metadata の所属（プロジェクト・参加店）が
 * 呼び出し側と一致することを確認してから反映する。
 * 未払い（決済を完了していない）場合は 402 で返す。
 */
export async function verifyAndApplyCharge(
  db: Firestore,
  input: {
    contractId: string;
    sessionId: string;
    eventId: string;
    exhibitorId: string;
  },
): Promise<VerifyChargeResult> {
  const settings = await getStripeBillingSettings(db, input.contractId);
  if (!settings) {
    return { ok: false, status: 400, error: 'Stripe設定が未完了です' };
  }
  let session: unknown;
  try {
    session = await createStripeClient(
      settings.secretKey,
    ).checkout.sessions.retrieve(input.sessionId);
  } catch {
    return { ok: false, status: 404, error: '支払い情報が見つかりません' };
  }
  const interpreted = interpretCheckoutSession(session);
  if (!interpreted) {
    return { ok: false, status: 400, error: '支払い情報が不正です' };
  }
  if (
    interpreted.eventId !== input.eventId ||
    interpreted.exhibitorId !== input.exhibitorId
  ) {
    return { ok: false, status: 403, error: 'この支払いはあなたのものではありません' };
  }
  if (!interpreted.paid) {
    return { ok: false, status: 402, error: 'お支払いが完了していません' };
  }
  const result = await applyChargeEffect(db, {
    eventId: interpreted.eventId,
    kind: interpreted.kind,
    exhibitorId: interpreted.exhibitorId,
    targetId: interpreted.targetId,
    sessionId: interpreted.sessionId,
    amount: interpreted.amountTotal,
    paidAt: new Date().toISOString(),
    stripeEventId: null,
  });
  return {
    ok: true,
    applied: result.applied,
    duplicate: result.duplicate,
    kind: interpreted.kind,
    targetId: interpreted.targetId,
  };
}

// ─── Webhook による反映 ───

export interface ApplyChargeWebhookResult {
  applied: boolean;
  duplicate: boolean;
}

/**
 * 単発課金宛の Webhook イベントをローカル記録へ反映する。
 * 照会経由の反映と対象・金額の突き合わせまで含めて同じ処理
 * （applyChargeEffect）に寄せ、両経路で結果が一致するようにする。
 */
export async function applyChargeWebhookEffect(
  db: Firestore,
  event: StripeWebhookEventLike,
): Promise<ApplyChargeWebhookResult> {
  const effect = effectFromStripeEventForCharge(event);
  if (!effect) return { applied: false, duplicate: false };
  const result = await applyChargeEffect(db, {
    eventId: effect.eventId,
    kind: effect.kind,
    exhibitorId: effect.exhibitorId,
    targetId: effect.targetId,
    sessionId: effect.sessionId,
    amount: effect.amountTotal,
    paidAt: effect.occurredAt,
    stripeEventId: event.id,
  });
  return { applied: result.applied, duplicate: result.duplicate };
}
