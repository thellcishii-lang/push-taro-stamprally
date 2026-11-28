// lib/event-billing.ts
// Push-taro.スタンプラリー の店舗課金システム（別料金オプション）。
//
// 設計の柱:
// - データ元は Firestore のみ。このモジュールが課金の正を持つ。
// - 使うのは「主催者自身の Stripe」。主催者が自分の Stripe の
//   APIキー（シークレットキー）と Webhook シークレットを管理画面から
//   登録し、サーバー専用ドキュメント organizers/{contractId}/billing/stripe
//   にだけ保持する。キーの値は UI・API レスポンスに一切出さない。
// - Stripe の商品・価格は事前に作らない。店ごとの月額は主催者が決め、
//   決済のたびに金額を API で指定して Checkout セッションを作る。
// - 支払い状態は Stripe Webhook のローカル記録が正。Stripe API への
//   都度問い合わせには依存しない。
// - 未払い確定で掲載停止: 参加店ドキュメントの billingSuspended
//   （profile.published とは別のフラグ。lib/event-shop.ts 参照）を立て、
//   公開一覧から外す。スタンプ・レビューの記録には触れない。
//   支払いが復旧したら自動でフラグを下ろす。
// - このオプションは契約ごとに ON/OFF（organizers の
//   billingOptionEnabled）。OFF の契約では呼び出し側（API）が存在自体を
//   隠し、このモジュールの処理は動かない。
import Stripe from 'stripe';
import type { Firestore } from 'firebase-admin/firestore';
import { jstDateString } from './event';
import { getOrganizer, findOrganizerByOwnerUid, type Organizer } from './organizers';
import { listEventsByOwner } from './event-store';
import { setShopBillingSuspended, setShopDelistedAt } from './event-shop';
import { EVENT_EXHIBITORS_COLLECTION } from './event-coupon';
import { sendEmail } from './mailer';
import { resolveAppOrigin } from './app-origin';

export const SHOP_BILLINGS_COLLECTION = 'shopBillings';
export const BILLING_PAYMENTS_COLLECTION = 'billingPayments';
/** 支払い失敗の主催者通知の送信済みマーカー（請求書IDがドキュメントID）。 */
export const BILLING_FAILURE_NOTICES_COLLECTION = 'billingFailureNotices';
const BILLING_SETTINGS_SUBCOLLECTION = 'billing';
const BILLING_SETTINGS_DOC_ID = 'stripe';

/** 店ごとの課金状態。 */
export type ShopBillingStatus =
  | 'none' // プラン未作成（または Checkout 未完了）
  | 'active' // 支払い済み
  | 'past_due' // 支払い失敗・Stripe のリトライ中
  | 'suspended' // 未払い確定で掲載停止中
  | 'canceled'; // 解約済み

export interface ShopBilling {
  exhibitorId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** 月額（円）。主催者が店ごとに設定する */
  monthlyAmount: number;
  status: ShopBillingStatus;
  /** 現在の課金期間の終了（ISO文字列）。不明なら null */
  currentPeriodEnd: string | null;
  /** 店に渡す支払いページ（Checkout）の URL。発行時のみ */
  checkoutUrl: string | null;
  checkoutSessionId: string | null;
  /** 主催者が解約操作をした記録。Webhook の deleted で誤停止しないため */
  canceledByAdmin: boolean;
  updatedAt: string;
}

/** 支払い記録の種別。月額サブスクリプションの請求が基本。 */
export type BillingPaymentKind = 'subscription' | 'coupon-issue' | 'push-send';

/** 種別の表示ラベル（CSV・管理画面で共通に使う）。 */
export const BILLING_PAYMENT_KIND_LABELS: Record<BillingPaymentKind, string> = {
  subscription: '月額',
  'coupon-issue': 'クーポン発行',
  'push-send': 'プッシュ送信',
};

export function parseBillingPaymentKind(value: unknown): BillingPaymentKind {
  return value === 'coupon-issue' || value === 'push-send'
    ? value
    : 'subscription';
}

export interface BillingPaymentRecord {
  /** ドキュメントID = Stripe イベントID（冪等キー）。手動記録は 'manual_' で始まる */
  id: string;
  exhibitorId: string;
  /** 種別。旧ドキュメント（項目なし）は月額として扱う */
  kind: BillingPaymentKind;
  /** 金額（円） */
  amount: number;
  status: 'paid' | 'failed';
  /** 支払いが完了した日時（ISO）。失敗時は null */
  paidAt: string | null;
  /** イベント発生日時（ISO） */
  occurredAt: string;
  stripeEventId: string;
  stripeInvoiceId: string | null;
  /** 記録の経路。旧ドキュメント（項目なし）は 'stripe' として扱う */
  source: 'stripe' | 'manual';
  /** 手動記録の対象（クーポン／プッシュ申請のID）。無ければ null */
  targetId: string | null;
  /** 手動記録のメモ（任意）。Stripe 経由は null */
  note: string | null;
}

/** サーバー専用ドキュメントに保持する Stripe 設定（値は外に出さない）。 */
export interface StripeBillingSettings {
  secretKey: string;
  webhookSecret: string;
}

/** 設定の「保存済みかどうか」だけを表す状態（値は含まない）。 */
export interface StripeBillingSettingsState {
  secretKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
}

// ─── 純粋関数: 設定入力の検証 ───

export function isValidStripeSecretKey(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/.test(value.trim())
  );
}

export function isValidStripeWebhookSecret(value: unknown): boolean {
  return typeof value === 'string' && /^whsec_[A-Za-z0-9]{16,}$/.test(value.trim());
}

export type ParseBillingSettingsInputResult =
  | { ok: true; value: { secretKey?: string; webhookSecret?: string } }
  | { ok: false; error: string };

/**
 * Stripe 設定の保存入力を検証する。渡された項目だけを更新対象とし、
 * 未指定の項目は既存の値を維持する（片方だけの差し替えができる）。
 * 値は trim したものを保存する。どちらも無ければエラー。
 */
export function parseBillingSettingsInput(
  raw: unknown,
): ParseBillingSettingsInputResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'リクエスト形式が不正です' };
  }
  const source = raw as Record<string, unknown>;
  const value: { secretKey?: string; webhookSecret?: string } = {};
  if (source.secretKey !== undefined) {
    if (!isValidStripeSecretKey(source.secretKey)) {
      return {
        ok: false,
        error: 'APIキー（シークレットキー）の形式が不正です',
      };
    }
    value.secretKey = (source.secretKey as string).trim();
  }
  if (source.webhookSecret !== undefined) {
    if (!isValidStripeWebhookSecret(source.webhookSecret)) {
      return {
        ok: false,
        error: 'Webhookシークレットの形式が不正です（whsec_ で始まる値です）',
      };
    }
    value.webhookSecret = (source.webhookSecret as string).trim();
  }
  if (value.secretKey === undefined && value.webhookSecret === undefined) {
    return { ok: false, error: '保存する項目がありません' };
  }
  return { ok: true, value };
}

// ─── 純粋関数: 月額の検証 ───

export const MONTHLY_AMOUNT_MIN = 50;
export const MONTHLY_AMOUNT_MAX = 10_000_000;

export type ParseMonthlyAmountResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/** 店ごとの月額（円・整数）の入力検証。 */
export function parseMonthlyAmount(raw: unknown): ParseMonthlyAmountResult {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, error: '月額は円単位の整数で指定してください' };
  }
  if (raw < MONTHLY_AMOUNT_MIN || raw > MONTHLY_AMOUNT_MAX) {
    return {
      ok: false,
      error: `月額は${MONTHLY_AMOUNT_MIN}円から${MONTHLY_AMOUNT_MAX}円の間で指定してください`,
    };
  }
  return { ok: true, value: raw };
}

// ─── 純粋関数: JST の月キーと収支集計 ───

/** ISO文字列の属する JST の月キー（'YYYY-MM'）。解釈できなければ ''。 */
export function monthKeyJst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return jstDateString(date).slice(0, 7);
}

/** 基準日（JST）の今月と先月の月キー。 */
export function currentAndPreviousMonthKeys(now: Date): {
  current: string;
  previous: string;
} {
  const current = jstDateString(now).slice(0, 7);
  const [year, month] = current.split('-').map(Number);
  const prev = new Date(Date.UTC(year, month - 2, 1));
  const previous = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  return { current, previous };
}

export interface BillingMonthlySummary {
  currentMonthKey: string;
  currentMonthTotal: number;
  previousMonthKey: string;
  previousMonthTotal: number;
}

/**
 * 支払い記録から今月・先月（JST）の入金合計を出す。
 * 数えるのは支払い完了（paid）だけ。月は paidAt（無ければ occurredAt）
 * の JST 月で判定する。
 */
export function summarizePaymentsByMonth(
  payments: Array<
    Pick<BillingPaymentRecord, 'amount' | 'status' | 'paidAt' | 'occurredAt'>
  >,
  now: Date,
): BillingMonthlySummary {
  const { current, previous } = currentAndPreviousMonthKeys(now);
  let currentMonthTotal = 0;
  let previousMonthTotal = 0;
  for (const payment of payments) {
    if (payment.status !== 'paid') continue;
    const key = monthKeyJst(payment.paidAt ?? payment.occurredAt);
    if (key === current) currentMonthTotal += payment.amount;
    else if (key === previous) previousMonthTotal += payment.amount;
  }
  return {
    currentMonthKey: current,
    currentMonthTotal,
    previousMonthKey: previous,
    previousMonthTotal,
  };
}

// ─── 純粋関数: Stripe Webhook イベント → ローカルへの効果 ───

/**
 * Webhook イベントの最小構造（テスト容易性のため Stripe 型に依存しない）。
 * Stripe.Event は構造的にこれを満たす。
 */
export interface StripeWebhookEventLike {
  id: string;
  type: string;
  created?: number;
  data: { object: Record<string, unknown> };
}

export interface BillingPaymentDraft {
  amount: number;
  status: 'paid' | 'failed';
  invoiceId: string | null;
  paidAt: string | null;
}

export interface StripeWebhookEffect {
  subscriptionId: string | null;
  customerId: string | null;
  /** Checkout / サブスクリプションの metadata から得た所属（無ければ null） */
  metadataEventId: string | null;
  metadataExhibitorId: string | null;
  billingPatch: {
    status?: ShopBillingStatus;
    currentPeriodEnd?: string | null;
    stripeSubscriptionId?: string;
    stripeCustomerId?: string;
  };
  /** null = 掲載状態に触らない / true = 掲載停止 / false = 掲載に復旧 */
  suspend: boolean | null;
  payment: BillingPaymentDraft | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** customer は文字列 ID のことも、展開されたオブジェクトのこともある。 */
function customerIdOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const record = asRecord(value);
  return record ? stringOrNull(record.id) : null;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function unixToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

function metadataString(
  metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  return metadata ? stringOrNull(metadata[key]) : null;
}

/** 請求書からサブスクリプションIDを引く（旧API形式と現行形式の両対応）。 */
function subscriptionIdFromInvoice(invoice: Record<string, unknown>): string | null {
  const direct = stringOrNull(invoice.subscription);
  if (direct) return direct;
  const parent = asRecord(invoice.parent);
  const details = parent ? asRecord(parent.subscription_details) : null;
  return details ? stringOrNull(details.subscription) : null;
}

function metadataFromInvoice(
  invoice: Record<string, unknown>,
): Record<string, unknown> | null {
  const parent = asRecord(invoice.parent);
  const details = parent ? asRecord(parent.subscription_details) : null;
  const fromDetails = details ? asRecord(details.metadata) : null;
  if (fromDetails) return fromDetails;
  return asRecord(invoice.metadata);
}

/** 請求書の対象期間の終わり（最初の明細の period.end）。 */
function periodEndFromInvoice(invoice: Record<string, unknown>): string | null {
  const lines = asRecord(invoice.lines);
  const data = lines && Array.isArray(lines.data) ? lines.data : [];
  for (const line of data) {
    const period = asRecord(asRecord(line)?.period);
    const iso = period ? unixToIso(period.end) : null;
    if (iso) return iso;
  }
  return null;
}

/** サブスクリプションの現在の期間終了（旧形式・現行形式の両対応）。 */
function periodEndFromSubscription(
  subscription: Record<string, unknown>,
): string | null {
  const direct = unixToIso(subscription.current_period_end);
  if (direct) return direct;
  const items = asRecord(subscription.items);
  const data = items && Array.isArray(items.data) ? items.data : [];
  for (const item of data) {
    const iso = unixToIso(asRecord(item)?.current_period_end);
    if (iso) return iso;
  }
  return null;
}

/**
 * Stripe のサブスクリプション状態 → ローカルの状態と掲載への効果。
 * - active / trialing: 支払いが回っている → active・掲載に復旧
 * - past_due: リトライ中 → past_due（まだ停止しない）
 * - unpaid: リトライ尽きて未払い確定 → suspended・掲載停止
 * - canceled / incomplete_expired: 終了 → canceled・掲載停止
 * - incomplete: 初回支払い未完了 → none（掲載には触らない）
 * - paused: 課金一時停止 → past_due 扱い（停止まではしない）
 * 未知の状態は null（何もしない）。
 */
export function shopBillingTransitionForSubscriptionStatus(
  stripeStatus: unknown,
): { status: ShopBillingStatus; suspend: boolean | null } | null {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return { status: 'active', suspend: false };
    case 'past_due':
    case 'paused':
      return { status: 'past_due', suspend: null };
    case 'unpaid':
      return { status: 'suspended', suspend: true };
    case 'canceled':
    case 'incomplete_expired':
      return { status: 'canceled', suspend: true };
    case 'incomplete':
      return { status: 'none', suspend: null };
    default:
      return null;
  }
}

/**
 * Webhook イベントを、ローカル記録への効果（課金レコードの更新・掲載の
 * 停止/復旧・支払い記録）に変換する。対象外のイベントは null。
 */
export function effectFromStripeEvent(
  event: StripeWebhookEventLike,
): StripeWebhookEffect | null {
  const object = asRecord(event.data?.object) ?? {};
  const occurredAt =
    unixToIso(event.created) ?? new Date().toISOString();

  switch (event.type) {
    case 'checkout.session.completed': {
      if (object.mode !== 'subscription') return null;
      const metadata =
        asRecord(object.metadata) ??
        asRecord(asRecord(object.subscription_details)?.metadata);
      const subscriptionId = stringOrNull(object.subscription);
      const customerId = customerIdOf(object.customer);
      return {
        subscriptionId,
        customerId,
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        billingPatch: {
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(customerId ? { stripeCustomerId: customerId } : {}),
        },
        suspend: null,
        payment: null,
      };
    }
    case 'invoice.paid': {
      const metadata = metadataFromInvoice(object);
      return {
        subscriptionId: subscriptionIdFromInvoice(object),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        billingPatch: {
          status: 'active',
          currentPeriodEnd: periodEndFromInvoice(object),
        },
        suspend: false,
        payment: {
          amount: numberOrZero(object.amount_paid),
          status: 'paid',
          invoiceId: stringOrNull(object.id),
          paidAt:
            unixToIso(asRecord(object.status_transitions)?.paid_at) ??
            occurredAt,
        },
      };
    }
    case 'invoice.payment_failed': {
      const metadata = metadataFromInvoice(object);
      return {
        subscriptionId: subscriptionIdFromInvoice(object),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        // Stripe のリトライを尊重し、この時点では停止しない。
        billingPatch: { status: 'past_due' },
        suspend: null,
        payment: {
          amount: numberOrZero(object.amount_due),
          status: 'failed',
          invoiceId: stringOrNull(object.id),
          paidAt: null,
        },
      };
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const transition = shopBillingTransitionForSubscriptionStatus(object.status);
      if (!transition) return null;
      const metadata = asRecord(object.metadata);
      return {
        subscriptionId: stringOrNull(object.id),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        billingPatch: {
          status: transition.status,
          currentPeriodEnd: periodEndFromSubscription(object),
        },
        suspend: transition.suspend,
        payment: null,
      };
    }
    case 'customer.subscription.deleted': {
      const metadata = asRecord(object.metadata);
      return {
        subscriptionId: stringOrNull(object.id),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        billingPatch: { status: 'canceled', currentPeriodEnd: null },
        suspend: true,
        payment: null,
      };
    }
    default:
      return null;
  }
}

// ─── Stripe クライアント ───

/** 主催者の保存キーから Stripe クライアントを作る。 */
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

/**
 * Webhook の署名検証。生ボディと stripe-signature ヘッダで検証し、
 * 不正なら throw する（呼び出し側が 400 を返す）。
 */
export function verifyStripeWebhookEvent(
  secretKey: string,
  webhookSecret: string,
  rawBody: string,
  signature: string,
): Stripe.Event {
  return createStripeClient(secretKey).webhooks.constructEvent(
    rawBody,
    signature,
    webhookSecret,
  );
}

// ─── Firestore: Stripe 設定（サーバー専用） ───

function stripeSettingsRef(db: Firestore, contractId: string) {
  return db
    .collection('organizers')
    .doc(contractId)
    .collection(BILLING_SETTINGS_SUBCOLLECTION)
    .doc(BILLING_SETTINGS_DOC_ID);
}

/**
 * 保存済みの Stripe 設定を読む。キーと Webhook シークレットの両方が
 * 揃っていなければ null（未完了）。返す値はサーバー内でのみ使うこと。
 */
export async function getStripeBillingSettings(
  db: Firestore,
  contractId: string,
): Promise<StripeBillingSettings | null> {
  const snap = await stripeSettingsRef(db, contractId).get();
  if (!snap.exists) return null;
  const secretKey = snap.data()?.secretKey;
  const webhookSecret = snap.data()?.webhookSecret;
  if (typeof secretKey !== 'string' || !secretKey) return null;
  if (typeof webhookSecret !== 'string' || !webhookSecret) return null;
  return { secretKey, webhookSecret };
}

/** 設定の保存状態だけを読む（値は返さない）。 */
export async function getStripeBillingSettingsState(
  db: Firestore,
  contractId: string,
): Promise<StripeBillingSettingsState> {
  const snap = await stripeSettingsRef(db, contractId).get();
  const data = snap.data() ?? {};
  return {
    secretKeyConfigured:
      typeof data.secretKey === 'string' && data.secretKey.length > 0,
    webhookSecretConfigured:
      typeof data.webhookSecret === 'string' && data.webhookSecret.length > 0,
  };
}

/** 設定を保存する（渡された項目だけを上書き）。 */
export async function saveStripeBillingSettings(
  db: Firestore,
  contractId: string,
  patch: { secretKey?: string; webhookSecret?: string },
): Promise<void> {
  await stripeSettingsRef(db, contractId).set(
    { ...patch, updatedAt: new Date().toISOString() },
    { merge: true },
  );
}

// ─── Firestore: 店ごとの課金レコード ───

function shopBillingRef(db: Firestore, eventId: string, exhibitorId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(SHOP_BILLINGS_COLLECTION)
    .doc(exhibitorId);
}

function shopBillingsRef(db: Firestore, eventId: string) {
  return db.collection('events').doc(eventId).collection(SHOP_BILLINGS_COLLECTION);
}

function parseShopBillingStatus(value: unknown): ShopBillingStatus {
  return value === 'active' ||
    value === 'past_due' ||
    value === 'suspended' ||
    value === 'canceled'
    ? value
    : 'none';
}

function toShopBilling(
  exhibitorId: string,
  data: FirebaseFirestore.DocumentData,
): ShopBilling {
  return {
    exhibitorId,
    stripeCustomerId: stringOrNull(data.stripeCustomerId),
    stripeSubscriptionId: stringOrNull(data.stripeSubscriptionId),
    monthlyAmount:
      typeof data.monthlyAmount === 'number' ? data.monthlyAmount : 0,
    status: parseShopBillingStatus(data.status),
    currentPeriodEnd: stringOrNull(data.currentPeriodEnd),
    checkoutUrl: stringOrNull(data.checkoutUrl),
    checkoutSessionId: stringOrNull(data.checkoutSessionId),
    canceledByAdmin: data.canceledByAdmin === true,
    updatedAt:
      typeof data.updatedAt === 'string'
        ? data.updatedAt
        : (data.updatedAt?.toDate?.().toISOString() ?? ''),
  };
}

export async function getShopBilling(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<ShopBilling | null> {
  const snap = await shopBillingRef(db, eventId, exhibitorId).get();
  if (!snap.exists) return null;
  return toShopBilling(exhibitorId, snap.data()!);
}

export async function listShopBillings(
  db: Firestore,
  eventId: string,
): Promise<ShopBilling[]> {
  const snap = await shopBillingsRef(db, eventId).get();
  return snap.docs.map((doc) => toShopBilling(doc.id, doc.data()));
}

/**
 * 手動入金（月額分）を受けたときの課金レコード反映。
 * - 解約済み（canceled）の店は復活させない（何もせず現在の状態を返す）。
 * - それ以外は支払い済みにし、期間の終わりを「現在の期間終了と支払日の
 *   遅い方から1ヶ月後」まで延ばす。掲載停止中なら停止を解除する。
 * - 月額が未設定（0）の店は、記録した金額を月額として残す。
 */
export async function markShopBillingPaidManually(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  input: { amount: number; currentPeriodEnd: string },
): Promise<ShopBilling | null> {
  const existing = await getShopBilling(db, eventId, exhibitorId);
  if (existing?.status === 'canceled') return existing;
  const billing = await writeShopBilling(db, eventId, exhibitorId, {
    status: 'active',
    currentPeriodEnd: input.currentPeriodEnd,
    ...(existing && existing.monthlyAmount > 0
      ? {}
      : { monthlyAmount: input.amount }),
  });
  await setShopBillingSuspended(db, eventId, exhibitorId, false);
  await setShopDelistedAt(db, eventId, exhibitorId, null);
  return billing;
}

async function writeShopBilling(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  fields: Record<string, unknown>,
): Promise<ShopBilling> {
  await shopBillingRef(db, eventId, exhibitorId).set(
    { ...fields, updatedAt: new Date().toISOString() },
    { merge: true },
  );
  const billing = await getShopBilling(db, eventId, exhibitorId);
  return billing!;
}

// ─── Firestore: 支払い記録 ───

export async function listBillingPayments(
  db: Firestore,
  eventId: string,
  limit = 50,
): Promise<BillingPaymentRecord[]> {
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(BILLING_PAYMENTS_COLLECTION)
    .orderBy('occurredAt', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      exhibitorId: String(data.exhibitorId ?? ''),
      kind: parseBillingPaymentKind(data.kind),
      amount: typeof data.amount === 'number' ? data.amount : 0,
      status: data.status === 'failed' ? ('failed' as const) : ('paid' as const),
      paidAt: stringOrNull(data.paidAt),
      occurredAt: typeof data.occurredAt === 'string' ? data.occurredAt : '',
      stripeEventId: String(data.stripeEventId ?? doc.id),
      stripeInvoiceId: stringOrNull(data.stripeInvoiceId),
      source: data.source === 'manual' ? ('manual' as const) : ('stripe' as const),
      targetId: stringOrNull(data.targetId),
      note: stringOrNull(data.note),
    };
  });
}

// ─── 純粋関数: 入金一覧 CSV ───

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * ISO文字列を JST の ISO 表記（'YYYY-MM-DDTHH:mm:ss+09:00'）にする。
 * 解釈できなければ空文字。
 */
export function formatJstDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19) + '+09:00';
}

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface BillingCsvExhibitor {
  id: string;
  name: string;
  /** 登録住所（管理用）。無ければ null / undefined */
  address?: string | null;
}

export const BILLING_PAYMENTS_CSV_HEADER = [
  '日時',
  '店名',
  '住所',
  '種別',
  '金額',
  '状態',
  'Stripe請求書ID',
  'チェックアウトセッションID',
  'サブスクリプションID',
] as const;

/**
 * 入金一覧の CSV を組み立てる（純粋関数）。
 * - 店名・登録住所は参加店から、サブスクリプションIDとチェックアウト
 *   セッションIDは店ごとの課金レコードから引く（支払い記録自体には
 *   持っていないため。セッションIDはその店の直近の発行セッション）。
 * - 行は発生日時の昇順（経理で読みやすい時系列）。
 * - 先頭に BOM を付け、Excel でそのまま開けるようにする。
 */
export function buildBillingPaymentsCsv(
  payments: BillingPaymentRecord[],
  exhibitors: BillingCsvExhibitor[],
  billings: ShopBilling[],
): string {
  const exhibitorById = new Map(exhibitors.map((e) => [e.id, e]));
  const billingByExhibitor = new Map(billings.map((b) => [b.exhibitorId, b]));
  const sorted = [...payments].sort((a, b) =>
    a.occurredAt.localeCompare(b.occurredAt),
  );
  const lines: string[] = [BILLING_PAYMENTS_CSV_HEADER.join(',')];
  for (const payment of sorted) {
    const exhibitor = exhibitorById.get(payment.exhibitorId);
    const billing = billingByExhibitor.get(payment.exhibitorId);
    const row = [
      formatJstDateTime(payment.paidAt ?? payment.occurredAt),
      exhibitor?.name ?? payment.exhibitorId,
      exhibitor?.address ?? '',
      BILLING_PAYMENT_KIND_LABELS[payment.kind],
      String(payment.amount),
      payment.status === 'paid' ? '支払い済み' : '失敗',
      payment.stripeInvoiceId ?? '',
      billing?.checkoutSessionId ?? '',
      billing?.stripeSubscriptionId ?? '',
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ─── 入金の集計（集計CSV・集計レポート用） ───
//
// 明細CSVが「他のソフトへ読み込ませる生データ」なのに対し、こちらは
// 集計ソフトのレポートのように期間で畳んだ集計。日付の区切りは明細CSVと
// 同じく JST（formatJstDateTime の日付部分）でそろえる。

/** 期間ごとの集計（日次・月次・年次で共用）。 */
export interface BillingSummaryBucket {
  /** 'YYYY-MM-DD'（日次）/ 'YYYY-MM'（月次）/ 'YYYY'（年次） */
  period: string;
  paidCount: number;
  paidAmount: number;
  failedCount: number;
}

/** 店舗別月次の集計。 */
export interface BillingShopMonthlyBucket {
  /** 'YYYY-MM' */
  month: string;
  exhibitorId: string;
  shopName: string;
  paidCount: number;
  paidAmount: number;
  failedCount: number;
}

export interface BillingSummary {
  daily: BillingSummaryBucket[];
  monthly: BillingSummaryBucket[];
  yearly: BillingSummaryBucket[];
  shopMonthly: BillingShopMonthlyBucket[];
  totalPaidCount: number;
  totalPaidAmount: number;
  totalFailedCount: number;
}

/**
 * 支払い記録を日次・月次・年次・店舗別月次に集計する（純粋関数）。
 * 日付は明細CSVと同じ基準（paidAt、無ければ occurredAt、JST）。
 * 日付として読めない記録は集計から除く。
 */
export function summarizeBillingPayments(
  payments: BillingPaymentRecord[],
  exhibitors: BillingCsvExhibitor[],
): BillingSummary {
  const exhibitorById = new Map(exhibitors.map((e) => [e.id, e]));
  const daily = new Map<string, BillingSummaryBucket>();
  const monthly = new Map<string, BillingSummaryBucket>();
  const yearly = new Map<string, BillingSummaryBucket>();
  const shopMonthly = new Map<string, BillingShopMonthlyBucket>();
  let totalPaidCount = 0;
  let totalPaidAmount = 0;
  let totalFailedCount = 0;

  const bucketFor = (
    map: Map<string, BillingSummaryBucket>,
    period: string,
  ): BillingSummaryBucket => {
    let bucket = map.get(period);
    if (!bucket) {
      bucket = { period, paidCount: 0, paidAmount: 0, failedCount: 0 };
      map.set(period, bucket);
    }
    return bucket;
  };

  for (const payment of payments) {
    const date = formatJstDateTime(payment.paidAt ?? payment.occurredAt).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const buckets = [
      bucketFor(daily, date),
      bucketFor(monthly, date.slice(0, 7)),
      bucketFor(yearly, date.slice(0, 4)),
    ];
    const shopKey = `${date.slice(0, 7)}|${payment.exhibitorId}`;
    let shopBucket = shopMonthly.get(shopKey);
    if (!shopBucket) {
      shopBucket = {
        month: date.slice(0, 7),
        exhibitorId: payment.exhibitorId,
        shopName: exhibitorById.get(payment.exhibitorId)?.name ?? payment.exhibitorId,
        paidCount: 0,
        paidAmount: 0,
        failedCount: 0,
      };
      shopMonthly.set(shopKey, shopBucket);
    }
    if (payment.status === 'paid') {
      for (const bucket of buckets) {
        bucket.paidCount += 1;
        bucket.paidAmount += payment.amount;
      }
      shopBucket.paidCount += 1;
      shopBucket.paidAmount += payment.amount;
      totalPaidCount += 1;
      totalPaidAmount += payment.amount;
    } else {
      for (const bucket of buckets) bucket.failedCount += 1;
      shopBucket.failedCount += 1;
      totalFailedCount += 1;
    }
  }

  const byPeriod = (a: BillingSummaryBucket, b: BillingSummaryBucket) =>
    a.period.localeCompare(b.period);
  return {
    daily: [...daily.values()].sort(byPeriod),
    monthly: [...monthly.values()].sort(byPeriod),
    yearly: [...yearly.values()].sort(byPeriod),
    shopMonthly: [...shopMonthly.values()].sort(
      (a, b) =>
        a.month.localeCompare(b.month) ||
        b.paidAmount - a.paidAmount ||
        a.shopName.localeCompare(b.shopName),
    ),
    totalPaidCount,
    totalPaidAmount,
    totalFailedCount,
  };
}

/** 集計CSVの組み立て（純粋関数）。明細CSVと同じ BOM + CRLF。 */
export function buildBillingSummaryCsv(summary: BillingSummary): string {
  const lines: string[] = [];
  const section = (
    title: string,
    header: string[],
    rows: string[][],
  ): void => {
    lines.push(title);
    lines.push(header.map(csvEscape).join(','));
    for (const row of rows) lines.push(row.map(csvEscape).join(','));
    lines.push('');
  };
  const bucketRow = (bucket: BillingSummaryBucket): string[] => [
    bucket.period,
    String(bucket.paidCount),
    String(bucket.paidAmount),
    String(bucket.failedCount),
  ];
  const periodHeader = ['期間', '入金件数', '入金額', '失敗件数'];
  section('【日次集計】', periodHeader, summary.daily.map(bucketRow));
  section('【月次集計】', periodHeader, summary.monthly.map(bucketRow));
  section('【年次集計】', periodHeader, summary.yearly.map(bucketRow));
  section(
    '【店舗別月次集計】',
    ['月', '店名', '入金件数', '入金額', '失敗件数'],
    summary.shopMonthly.map((bucket) => [
      bucket.month,
      bucket.shopName,
      String(bucket.paidCount),
      String(bucket.paidAmount),
      String(bucket.failedCount),
    ]),
  );
  section('【総合計】', ['入金件数', '入金額', '失敗件数'], [
    [
      String(summary.totalPaidCount),
      String(summary.totalPaidAmount),
      String(summary.totalFailedCount),
    ],
  ]);
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

// ─── 支払い失敗の主催者通知 ───
//
// 運用（2026-11-17 Ishii の仕様）: 店の月額の支払いが期日に失敗したら、
// 主催者にメールで知らせる。主催者はそれを見て店へ連絡し、期限までに
// 払われなければ掲載が止まる（掲載停止自体は Stripe のリトライが尽きた
// 時点で Webhook が自動で行う）。通知は請求書ごとに1回だけ:
// billingFailureNotices/{invoiceId} を create できた場合だけ送る
// （Stripe のリトライで同じ請求書の失敗イベントが複数届いても1回）。

function escapeNoticeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 支払い失敗通知メールの文面（純粋関数）。 */
export function buildBillingFailureNoticeEmail(input: {
  shopName: string;
  eventName?: string | null;
  amount: number;
}): { subject: string; html: string } {
  const eventPart = input.eventName
    ? `プロジェクト「${escapeNoticeHtml(input.eventName)}」`
    : 'Push-taro.スタンプラリー のプロジェクト';
  return {
    subject: '【Push-taro.スタンプラリー】参加店のお支払い失敗のお知らせ',
    html: `
<p>${eventPart}の参加店「${escapeNoticeHtml(input.shopName)}」様の月額料金のお支払いが失敗しました。</p>
<p>請求額: ${input.amount.toLocaleString()}円</p>
<p>カードの有効期限切れや残高不足などが考えられます。お店へご連絡のうえ、お支払い方法のご確認をお願いいたします。</p>
<p>このままお支払いが完了しない場合、そのお店の掲載は自動的に停止します（掲載が止まっても、お店の情報はそのまま保存されます）。</p>
<p>お支払い状況は管理画面の「店舗課金」ページでご確認いただけます。</p>
`,
  };
}

export type BillingFailureMailSender = (args: {
  to: string;
  subject: string;
  html: string;
}) => Promise<{ success: boolean; error?: string }>;

/**
 * 支払い失敗を主催者へ通知する（請求書ごとに1回だけ）。
 * 送信できたら true、既に通知済みなら false を返す。
 * メール送信に失敗した場合はマーカーを取り消し、次の失敗イベントで
 * 再度通知できるようにする（通知の取りこぼし防止）。
 */
export async function notifyBillingFailureOnce(
  db: Firestore,
  input: {
    eventId: string;
    invoiceId: string;
    exhibitorId: string;
    to: string;
    shopName: string;
    eventName?: string | null;
    amount: number;
  },
  send: BillingFailureMailSender = (args) => sendEmail(args),
): Promise<boolean> {
  const ref = db
    .collection('events')
    .doc(input.eventId)
    .collection(BILLING_FAILURE_NOTICES_COLLECTION)
    .doc(input.invoiceId);
  try {
    await ref.create({
      exhibitorId: input.exhibitorId,
      notifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (isAlreadyExistsError(error)) return false;
    throw error;
  }
  const mail = buildBillingFailureNoticeEmail({
    shopName: input.shopName,
    eventName: input.eventName,
    amount: input.amount,
  });
  try {
    const result = await send({
      to: input.to,
      subject: mail.subject,
      html: mail.html,
    });
    if (!result.success) {
      console.error('[event-billing] failure notice email failed:', result.error);
      await ref.delete().catch(() => undefined);
      return false;
    }
  } catch (error) {
    console.error('[event-billing] failure notice email error:', error);
    await ref.delete().catch(() => undefined);
    return false;
  }
  return true;
}

// ─── オプション有効な契約者の解決 ───

/**
 * ログイン中の主催者（ownerUid）から、店舗課金オプションが有効な
 * 契約者レコードを引く。契約者でない／オプション OFF なら null。
 * API 側は null のとき 404 にして機能の存在自体を隠す。
 */
export async function findEnabledBillingOrganizer(
  ownerUid: string,
): Promise<Organizer | null> {
  const organizer = await findOrganizerByOwnerUid(ownerUid);
  if (!organizer || !organizer.billingOptionEnabled) return null;
  return organizer;
}

// ─── 課金の開始（Checkout セッション発行） ───

export interface StartShopBillingInput {
  contractId: string;
  eventId: string;
  exhibitorId: string;
  exhibitorName: string;
  monthlyAmount: number;
}

export type StartShopBillingResult =
  | { ok: true; billing: ShopBilling; checkoutUrl: string }
  | { ok: false; status: number; error: string };

/**
 * 店の課金を始める: Stripe 顧客（無ければ作成）＋価格は金額を直接
 * 指定して Checkout セッション（subscription モード）を発行し、
 * 店に渡す支払い URL を返す。サブスクリプション自体は店が Checkout で
 * 支払いを完了した時点で Stripe 側に作られ、Webhook で紐づく。
 * 既存の Checkout 未完了セッションがある場合は新しいセッションを
 * 発行し直す（古い URL は失効する）。
 */
export async function startShopBilling(
  db: Firestore,
  input: StartShopBillingInput,
): Promise<StartShopBillingResult> {
  const settings = await getStripeBillingSettings(db, input.contractId);
  if (!settings) {
    return {
      ok: false,
      status: 400,
      error: 'Stripe設定が未完了です。先にAPIキーとWebhookシークレットを保存してください',
    };
  }
  const stripe = createStripeClient(settings.secretKey);
  const existing = await getShopBilling(db, input.eventId, input.exhibitorId);

  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: input.exhibitorName,
      metadata: {
        contractId: input.contractId,
        eventId: input.eventId,
        exhibitorId: input.exhibitorId,
      },
    });
    customerId = customer.id;
  }

  const metadata = {
    contractId: input.contractId,
    eventId: input.eventId,
    exhibitorId: input.exhibitorId,
  };
  const origin = resolveAppOrigin();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'jpy',
          unit_amount: input.monthlyAmount,
          recurring: { interval: 'month' },
          product_data: { name: 'Push-taro.スタンプラリー 参加店 月額料金' },
        },
      },
    ],
    metadata,
    subscription_data: { metadata },
    success_url: `${origin}/event-admin/${input.eventId}/billing?checkout=success`,
    cancel_url: `${origin}/event-admin/${input.eventId}/billing?checkout=canceled`,
  });
  if (!session.url) {
    return {
      ok: false,
      status: 502,
      error: '支払いページの発行に失敗しました',
    };
  }

  const billing = await writeShopBilling(db, input.eventId, input.exhibitorId, {
    monthlyAmount: input.monthlyAmount,
    stripeCustomerId: customerId,
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    status:
      existing && existing.status !== 'canceled' ? existing.status : 'none',
    canceledByAdmin: false,
  });
  return { ok: true, billing, checkoutUrl: session.url };
}

// ─── 解約 ───

export type CancelShopBillingResult =
  | { ok: true; billing: ShopBilling }
  | { ok: false; status: number; error: string };

/**
 * 店の課金を解約する。先に canceledByAdmin を立ててから Stripe 側を
 * 止める（Webhook の customer.subscription.deleted が届いても、
 * 主催者の操作による解約では掲載停止にしないため）。
 * 主催者の解約では掲載は止めない（未払い確定による停止とは扱いが違う）。
 */
export async function cancelShopBilling(
  db: Firestore,
  contractId: string,
  eventId: string,
  exhibitorId: string,
): Promise<CancelShopBillingResult> {
  const existing = await getShopBilling(db, eventId, exhibitorId);
  if (!existing) {
    return { ok: false, status: 404, error: '課金が見つかりません' };
  }
  await writeShopBilling(db, eventId, exhibitorId, { canceledByAdmin: true });

  if (existing.stripeSubscriptionId) {
    const settings = await getStripeBillingSettings(db, contractId);
    if (!settings) {
      return {
        ok: false,
        status: 400,
        error: 'Stripe設定が未完了です。先にAPIキーとWebhookシークレットを保存してください',
      };
    }
    try {
      await createStripeClient(settings.secretKey).subscriptions.cancel(
        existing.stripeSubscriptionId,
      );
    } catch (error) {
      // 既に Stripe 側で解約済みの場合は成功扱いにする。
      const code = (error as { code?: string })?.code;
      if (code !== 'resource_missing') {
        return {
          ok: false,
          status: 502,
          error: 'Stripe側の解約に失敗しました。時間をおいて再度お試しください',
        };
      }
    }
  }

  const billing = await writeShopBilling(db, eventId, exhibitorId, {
    status: 'canceled',
    checkoutUrl: null,
    checkoutSessionId: null,
  });
  return { ok: true, billing };
}

// ─── Webhook の適用 ───

async function findShopBillingByStripeIds(
  db: Firestore,
  eventIds: string[],
  ids: { subscriptionId: string | null; customerId: string | null },
): Promise<{ eventId: string; billing: ShopBilling } | null> {
  for (const eventId of eventIds) {
    if (ids.subscriptionId) {
      const snap = await shopBillingsRef(db, eventId)
        .where('stripeSubscriptionId', '==', ids.subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return { eventId, billing: toShopBilling(snap.docs[0].id, snap.docs[0].data()) };
      }
    }
    if (ids.customerId) {
      const snap = await shopBillingsRef(db, eventId)
        .where('stripeCustomerId', '==', ids.customerId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return { eventId, billing: toShopBilling(snap.docs[0].id, snap.docs[0].data()) };
      }
    }
  }
  return null;
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

export interface ApplyStripeWebhookResult {
  applied: boolean;
  duplicate: boolean;
}

/**
 * 署名検証済みの Webhook イベントをローカル記録へ反映する。
 * - 対象の特定: metadata の所属を優先し、無ければ契約者の全プロジェクト
 *   から Stripe の顧客／サブスクリプション ID で引く。
 * - 冪等性: 支払い記録は Stripe イベントIDをドキュメントIDにして
 *   create するため、同じイベントの再送では二重に記録・適用しない。
 * - 主催者が解約操作をしたサブスクリプションの canceled では、
 *   掲載停止にしない（未払い確定による終了と区別する）。
 */
export async function applyStripeWebhookEffect(
  db: Firestore,
  contractId: string,
  event: StripeWebhookEventLike,
): Promise<ApplyStripeWebhookResult> {
  const effect = effectFromStripeEvent(event);
  if (!effect) return { applied: false, duplicate: false };
  const occurredAt = unixToIso(event.created) ?? new Date().toISOString();

  let target: { eventId: string; billing: ShopBilling } | null = null;
  if (effect.metadataEventId && effect.metadataExhibitorId) {
    const billing = await getShopBilling(
      db,
      effect.metadataEventId,
      effect.metadataExhibitorId,
    );
    if (billing) target = { eventId: effect.metadataEventId, billing };
  }
  if (!target) {
    const organizer = await getOrganizer(contractId);
    if (organizer?.ownerUid) {
      const events = await listEventsByOwner(organizer.ownerUid);
      const found = await findShopBillingByStripeIds(
        db,
        events.map((e) => e.id),
        {
          subscriptionId: effect.subscriptionId,
          customerId: effect.customerId,
        },
      );
      if (found) target = { eventId: found.eventId, billing: found.billing };
    }
  }
  if (!target) return { applied: false, duplicate: false };
  const { eventId, billing } = target;
  const exhibitorId = billing.exhibitorId;

  if (effect.payment) {
    const ref = db
      .collection('events')
      .doc(eventId)
      .collection(BILLING_PAYMENTS_COLLECTION)
      .doc(event.id);
    try {
      await ref.create({
        exhibitorId,
        amount: effect.payment.amount,
        status: effect.payment.status,
        paidAt: effect.payment.paidAt,
        occurredAt,
        stripeEventId: event.id,
        stripeInvoiceId: effect.payment.invoiceId,
      });
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        return { applied: false, duplicate: true };
      }
      throw error;
    }
  }

  let suspend = effect.suspend;
  if (effect.billingPatch.status === 'canceled' && billing.canceledByAdmin) {
    suspend = null;
  }

  await writeShopBilling(db, eventId, exhibitorId, {
    ...effect.billingPatch,
  });
  if (suspend !== null) {
    await setShopBillingSuspended(db, eventId, exhibitorId, suspend);
  }
  // 掲載停止の日時を参加店レコードに残す（停止の起算点。3ヶ月ルールの
  // 判定に使う）。復旧したら取り除く。内容（プロフィール等）は消さない。
  if (suspend === true) {
    await setShopDelistedAt(db, eventId, exhibitorId, occurredAt);
  } else if (suspend === false) {
    await setShopDelistedAt(db, eventId, exhibitorId, null);
  }

  // 支払い失敗は主催者へメールで知らせる（請求書ごとに1回だけ）。
  // 通知の失敗で Webhook の処理自体は失敗にしない。
  if (
    event.type === 'invoice.payment_failed' &&
    effect.payment?.status === 'failed' &&
    effect.payment.invoiceId
  ) {
    try {
      const organizer = await getOrganizer(contractId);
      if (organizer?.email) {
        const [eventSnap, exhibitorSnap] = await Promise.all([
          db.collection('events').doc(eventId).get(),
          db
            .collection('events')
            .doc(eventId)
            .collection(EVENT_EXHIBITORS_COLLECTION)
            .doc(exhibitorId)
            .get(),
        ]);
        await notifyBillingFailureOnce(db, {
          eventId,
          invoiceId: effect.payment.invoiceId,
          exhibitorId,
          to: organizer.email,
          shopName: String(exhibitorSnap.data()?.name ?? exhibitorId),
          eventName:
            typeof eventSnap.data()?.name === 'string'
              ? eventSnap.data()!.name
              : null,
          amount: effect.payment.amount,
        });
      }
    } catch (error) {
      console.error('[event-billing] failure notice failed:', error);
    }
  }
  return { applied: true, duplicate: false };
}
