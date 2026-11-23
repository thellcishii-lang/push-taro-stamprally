// lib/event-apply.ts
// Push-taro.スタンプラリー の自己申込（公開の申込ページ）。
//
// 2026-11-17 Ishii の仕様: 申込の形は Push-taro 自身の申込と同じ
// （申し込む → 払う → ログイン情報がメールで届く）。入口は2つ:
// - 参加店登録ページ: 店が店名＋メール（店舗課金オプションが有効な
//   契約では住所も必須）で申し込み、プロジェクトの月額
//   （shopMonthlyPrice）を主催者自身の Stripe で払う。支払いの確認が
//   取れてから参加店レコードが作られ、アクセスコードの招待メールが
//   届く。店はログインしてプロフィールを整えると掲載される。
// - 広告申込ページ: 外部の事業者が申し込み、プロジェクトの広告料金
//   （adsPrice）を払う。確認が取れてから協賛（advertiser）レコードが
//   作られ、広告編集画面へのログイン情報がメールで届く。あとは既存の
//   広告の仕組み（申請 → 主催者の承認 → 掲載）に乗る。
// 主催者発行（管理画面からの登録）は従来どおり残り、両入口が併存する。
// 自己申込のレコードには source: 'self' が付く。
//
// 支払い確認前の申込は「申込レコード」（events/{eventId}/applications）
// にだけ保持し、ログイン可能な参加店レコードは作らない。確認は2経路:
// 1. Webhook の checkout.session.completed（applyApplicationWebhookEffect）
// 2. Checkout からの戻りでサーバーがセッションを照会する
//    （verifyAndApplyApplication）
// どちらの経路も materializeApplication に寄せ、申込レコードの
// 状態遷移（pending → completed）で冪等化する。アクセスコードの
// メールは実体化のときに1回だけ送られる。
//
// 課金レコードは申込時点で「予定 ID」（plannedExhibitorId）で先に作る:
// - 店舗課金: shopBillings/{plannedId}（startShopBilling と同じ形。
//   サブスクリプションの metadata は店舗課金の形＝kind なしにし、
//   以後の請求書イベントは既存の店舗課金 Webhook が処理する）
// - 広告: adPlacements/{plannedId}（startAdPlacement と同じ形。
//   サブスクリプションの metadata.kind は 'ad-placement' にし、
//   以後のイベントは既存の広告 Webhook が処理する）
// Checkout セッション側の metadata.kind だけを申込用
// （'shop-registration' / 'ad-application'）にして、完了イベントを
// このモジュールへ振り分ける。
import type { Firestore } from 'firebase-admin/firestore';
import { resolveAppOrigin } from './app-origin';
import {
  createStripeClient,
  getStripeBillingSettings,
  SHOP_BILLINGS_COLLECTION,
  type StripeWebhookEventLike,
} from './event-billing';
import {
  AD_PLACEMENTS_COLLECTION,
  isAdsActionAllowed,
  resolveAdAvailability,
  resolveAdsOptionEnabled,
  type AdAvailability,
} from './event-ads';
import {
  EVENT_EXHIBITORS_COLLECTION,
  parseExhibitorKind,
  type ExhibitorKind,
} from './event-coupon';
import {
  ExhibitorAccessError,
  isValidExhibitorEmail,
  normalizeExhibitorEmail,
  parseRegistrationAddress,
  registerExhibitor,
  type RegisterExhibitorResult,
} from './exhibitor-access';
import { normalizeLocale, type Locale } from './i18n';
import { parseAdsPrice, parseShopMonthlyPrice } from './event';

export const APPLICATIONS_COLLECTION = 'applications';
/** Checkout セッションの metadata.kind（参加店の自己登録）。 */
export const SHOP_REGISTRATION_KIND = 'shop-registration';
/** Checkout セッションの metadata.kind（広告の自己申込）。 */
export const AD_APPLICATION_KIND = 'ad-application';

export type ApplicationKind =
  | typeof SHOP_REGISTRATION_KIND
  | typeof AD_APPLICATION_KIND;

export function isApplicationKind(value: unknown): value is ApplicationKind {
  return value === SHOP_REGISTRATION_KIND || value === AD_APPLICATION_KIND;
}

/** 申込の種類。'shop' = 参加店登録、'advertiser' = 広告申込（協賛）。 */
export type ApplicationType = 'shop' | 'advertiser';
export type ApplicationStatus = 'pending' | 'completed';

/** 掲載停止から閉店扱いになるまでの保持期間（月）。 */
export const DELISTED_RETENTION_MONTHS = 3;

/** 実体化の claim が古いとみなすまでの時間（ms）。処理が落ちた申込の再開用。 */
const CLAIM_STALE_MS = 10 * 60 * 1000;

export interface PendingApplication {
  id: string;
  type: ApplicationType;
  name: string;
  email: string;
  /** 登録時の住所（参加店のみ。店舗課金オプション ON のとき必須で収集し、実体化時に参加店ドキュメントのトップレベル address へ渡す） */
  address: string | null;
  lang: Locale;
  status: ApplicationStatus;
  /** 申込時点で固定した月額（円）。料金変更後もこの金額で契約する */
  amount: number;
  /** 支払い確認後に作る参加店レコードの ID（申込時点で採番） */
  plannedExhibitorId: string;
  checkoutSessionId: string | null;
  stripeCustomerId: string | null;
  /** 実体化で作られた参加店レコードの ID。未完了は null */
  exhibitorId: string | null;
  /** アクセスコードの招待メールを送れたかどうか */
  mailSent: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ─── 純粋関数: 申込入力の検証 ───

export type ParseApplicationInputResult =
  | { ok: true; value: { name: string; email: string } }
  | { ok: false; error: string };

/** 申込フォームの入力（名前＋メール）を検証して正規化する。 */
export function parseApplicationInput(
  raw: unknown,
): ParseApplicationInputResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'リクエスト形式が不正です' };
  }
  const source = raw as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name.trim() : '';
  if (!name) return { ok: false, error: '名前を入力してください' };
  const rawEmail = typeof source.email === 'string' ? source.email.trim() : '';
  if (!rawEmail) {
    return { ok: false, error: 'メールアドレスを入力してください' };
  }
  const email = normalizeExhibitorEmail(rawEmail);
  if (!isValidExhibitorEmail(email)) {
    return { ok: false, error: 'メールアドレスの形式が正しくありません' };
  }
  return { ok: true, value: { name, email } };
}

// ─── 純粋関数: 掲載停止の3ヶ月ルール ───

/**
 * 掲載停止日時から保持期間（3ヶ月）が過ぎているかどうか。
 * 月末日（1/31 など）からの加算は翌々月への繰り越しになる
 * （Date の月加算の仕様。その分だけ保持が長くなる＝安全側）。
 * 日時が解釈できない・未設定なら false（閉店扱いにしない）。
 */
export function isDelistedExpired(
  delistedAt: string | null,
  now: Date,
): boolean {
  if (!delistedAt) return false;
  const start = new Date(delistedAt);
  if (Number.isNaN(start.getTime())) return false;
  const expiry = new Date(start.getTime());
  expiry.setUTCMonth(expiry.getUTCMonth() + DELISTED_RETENTION_MONTHS);
  return now.getTime() >= expiry.getTime();
}

// ─── 純粋関数: 既存レコードに対する申込の判断（参加店） ───

export interface ExistingExhibitorState {
  id: string;
  kind: ExhibitorKind;
  billingSuspended: boolean;
  delistedAt: string | null;
  closedAt: string | null;
}

export type ExistingDecision =
  /** 登録なし（または閉店済み）: そのまま進める */
  | { action: 'none' }
  /** 既に登録されている／掲載停止中: 申込を断る */
  | { action: 'reject'; reason: 'already-registered' | 'delisted' }
  /** 掲載停止から3ヶ月経過: 旧レコードを閉店にして新規登録を進める */
  | { action: 'close-and-proceed'; exhibitorId: string };

/**
 * 参加店の自己登録で、同じメールの既存レコードをどう扱うか。
 * - 閉店済みレコードは存在しないものとして扱う。
 * - 掲載停止から3ヶ月を過ぎていれば閉店にして新規登録を通す。
 * - 掲載停止中（3ヶ月未満）は断る（店は主催者へ連絡して復旧する）。
 * - それ以外（通常の登録済み）も重複として断る。
 */
export function decideExistingExhibitor(
  existing: ExistingExhibitorState | null,
  now: Date,
): ExistingDecision {
  if (!existing) return { action: 'none' };
  if (existing.closedAt) return { action: 'none' };
  if (isDelistedExpired(existing.delistedAt, now)) {
    return { action: 'close-and-proceed', exhibitorId: existing.id };
  }
  if (existing.billingSuspended || existing.delistedAt) {
    return { action: 'reject', reason: 'delisted' };
  }
  return { action: 'reject', reason: 'already-registered' };
}

// ─── 純粋関数: Checkout セッションの解釈 ───

export interface InterpretedApplicationSession {
  sessionId: string;
  kind: ApplicationKind;
  type: ApplicationType;
  eventId: string;
  applicationId: string;
  plannedExhibitorId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  /** 初回支払いまで完了しているか（payment_status = 'paid'） */
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

/** customer は文字列 ID のことも、展開されたオブジェクトのこともある。 */
function customerIdOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  const record = asRecord(value);
  return record ? stringOrNull(record.id) : null;
}

/**
 * 申込宛の Checkout セッション（mode: 'subscription'）を解釈する。
 * metadata.kind が申込用でない、または申込の特定に必要な metadata が
 * 欠けていれば null。照会（verify）と Webhook の両経路で共用する。
 */
export function interpretApplicationCheckoutSession(
  session: unknown,
): InterpretedApplicationSession | null {
  const record = asRecord(session);
  if (!record || record.mode !== 'subscription') return null;
  const metadata = asRecord(record.metadata);
  const kind = metadata?.kind;
  if (!isApplicationKind(kind)) return null;
  const sessionId = stringOrNull(record.id);
  const eventId = metadata ? stringOrNull(metadata.eventId) : null;
  const applicationId = metadata ? stringOrNull(metadata.applicationId) : null;
  if (!sessionId || !eventId || !applicationId) return null;
  return {
    sessionId,
    kind,
    type: kind === SHOP_REGISTRATION_KIND ? 'shop' : 'advertiser',
    eventId,
    applicationId,
    plannedExhibitorId: metadata
      ? stringOrNull(metadata.exhibitorId)
      : null,
    customerId: customerIdOf(record.customer),
    subscriptionId: stringOrNull(record.subscription),
    paid: record.payment_status === 'paid',
  };
}

export interface ApplicationWebhookEffect extends InterpretedApplicationSession {
  occurredAt: string;
}

function unixToIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return new Date(value * 1000).toISOString();
}

/**
 * 申込宛の Webhook イベントを効果に変換する。
 * checkout.session.completed（mode: 'subscription'、kind が申込用、
 * payment_status が 'paid'）だけが対象。それ以外は null。
 */
export function effectFromStripeEventForApplication(
  event: StripeWebhookEventLike,
): ApplicationWebhookEffect | null {
  if (event.type !== 'checkout.session.completed') return null;
  const interpreted = interpretApplicationCheckoutSession(event.data?.object);
  if (!interpreted || !interpreted.paid) return null;
  return {
    ...interpreted,
    occurredAt: unixToIso(event.created) ?? new Date().toISOString(),
  };
}

// ─── Stripe クライアントの最小形（テストで差し替え可能にする） ───

export interface StripeCheckoutClient {
  customers: {
    create: (
      params: Record<string, unknown>,
    ) => Promise<{ id: string }>;
  };
  checkout: {
    sessions: {
      create: (
        params: Record<string, unknown>,
      ) => Promise<{ id: string; url: string | null }>;
      retrieve: (id: string) => Promise<unknown>;
    };
  };
}

/** 申込フローの差し替え可能な依存（テスト用）。既定は実物。 */
export interface ApplyDeps {
  resolveAvailability: (
    db: Firestore,
    ownerUid: string,
  ) => Promise<AdAvailability>;
  resolveAdsOption: (ownerUid: string) => Promise<boolean>;
  stripeFactory: (secretKey: string) => StripeCheckoutClient;
  register: (input: {
    eventId: string;
    name: string;
    email: string;
    lang?: Locale;
    eventName?: string | null;
    kind?: ExhibitorKind;
    source?: 'admin' | 'self';
    exhibitorId?: string;
    address?: string;
  }) => Promise<RegisterExhibitorResult>;
}

const defaultDeps: ApplyDeps = {
  resolveAvailability: (db, ownerUid) => resolveAdAvailability(db, ownerUid),
  resolveAdsOption: (ownerUid) => resolveAdsOptionEnabled(ownerUid),
  stripeFactory: (secretKey) =>
    createStripeClient(secretKey) as unknown as StripeCheckoutClient,
  register: (input) => registerExhibitor(input),
};

function withDeps(deps?: Partial<ApplyDeps>): ApplyDeps {
  return { ...defaultDeps, ...deps };
}

// ─── プロジェクト情報（申込に必要な最小項目） ───

export interface ApplyEventInfo {
  id: string;
  name: string;
  ownerUid: string;
  defaultLocale: Locale;
  shopMonthlyPrice: number | null;
  adsEnabled: boolean;
  adsPrice: number | null;
}

async function getApplyEventInfo(
  db: Firestore,
  eventId: string,
): Promise<ApplyEventInfo | null> {
  const snap = await db.collection('events').doc(eventId).get();
  if (!snap.exists) return null;
  const data = snap.data() ?? {};
  return {
    id: eventId,
    name: typeof data.name === 'string' ? data.name : '',
    ownerUid: typeof data.ownerUid === 'string' ? data.ownerUid : '',
    defaultLocale: normalizeLocale(data.defaultLocale),
    shopMonthlyPrice: parseShopMonthlyPrice(data.shopMonthlyPrice),
    adsEnabled: data.adsEnabled === true,
    adsPrice: parseAdsPrice(data.adsPrice),
  };
}

// ─── Firestore: 申込レコード ───

function applicationsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(APPLICATIONS_COLLECTION);
}

function applicationRef(db: Firestore, eventId: string, applicationId: string) {
  return applicationsRef(db, eventId).doc(applicationId);
}

function toApplication(
  id: string,
  data: FirebaseFirestore.DocumentData,
): PendingApplication {
  return {
    id,
    type: data.type === 'advertiser' ? 'advertiser' : 'shop',
    name: String(data.name ?? ''),
    email: String(data.email ?? ''),
    address: stringOrNull(data.address),
    lang: normalizeLocale(data.lang),
    status: data.status === 'completed' ? 'completed' : 'pending',
    amount: typeof data.amount === 'number' ? data.amount : 0,
    plannedExhibitorId: String(data.plannedExhibitorId ?? ''),
    checkoutSessionId: stringOrNull(data.checkoutSessionId),
    stripeCustomerId: stringOrNull(data.stripeCustomerId),
    exhibitorId: stringOrNull(data.exhibitorId),
    mailSent: data.mailSent === true,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : '',
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    completedAt: stringOrNull(data.completedAt),
  };
}

export async function getApplication(
  db: Firestore,
  eventId: string,
  applicationId: string,
): Promise<PendingApplication | null> {
  const snap = await applicationRef(db, eventId, applicationId).get();
  if (!snap.exists) return null;
  return toApplication(snap.id, snap.data()!);
}

/** 同じメール・種類で支払い待ちの申込があれば返す（再開用）。 */
async function findPendingApplication(
  db: Firestore,
  eventId: string,
  type: ApplicationType,
  email: string,
): Promise<PendingApplication | null> {
  const snap = await applicationsRef(db, eventId)
    .where('type', '==', type)
    .where('email', '==', email)
    .where('status', '==', 'pending')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return toApplication(snap.docs[0].id, snap.docs[0].data());
}

async function createApplicationRecord(
  db: Firestore,
  eventId: string,
  input: {
    type: ApplicationType;
    name: string;
    email: string;
    address: string | null;
    lang: Locale;
    amount: number;
    plannedExhibitorId: string;
  },
): Promise<PendingApplication> {
  const ref = applicationsRef(db, eventId).doc();
  const now = new Date().toISOString();
  await ref.set({
    type: input.type,
    name: input.name,
    email: input.email,
    address: input.address,
    lang: input.lang,
    status: 'pending',
    amount: input.amount,
    plannedExhibitorId: input.plannedExhibitorId,
    checkoutSessionId: null,
    stripeCustomerId: null,
    exhibitorId: null,
    mailSent: false,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    claimedAt: null,
  });
  const created = await getApplication(db, eventId, ref.id);
  return created!;
}

async function patchApplication(
  db: Firestore,
  eventId: string,
  applicationId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await applicationRef(db, eventId, applicationId).update({
    ...fields,
    updatedAt: new Date().toISOString(),
  });
}

// ─── Firestore: 既存レコードの状態 ───

function exhibitorsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION);
}

/**
 * メールで既存レコードを引く（lib/exhibitor-access.ts の findByEmail と
 * 同じ倒し方: 閉店レコードは存在しないものとして扱い、それ以外が
 * あれば最初の1件を返す）。
 */
async function findExhibitorStateByEmail(
  db: Firestore,
  eventId: string,
  email: string,
): Promise<ExistingExhibitorState | null> {
  const snap = await exhibitorsRef(db, eventId)
    .where('email', '==', email)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const state: ExistingExhibitorState = {
      id: doc.id,
      kind: parseExhibitorKind(data.kind),
      billingSuspended: data.billingSuspended === true,
      delistedAt: stringOrNull(data.delistedAt),
      closedAt: stringOrNull(data.closedAt),
    };
    if (!state.closedAt) return state;
  }
  return null;
}

/** 旧レコードに閉店印を付ける（内容は消さない）。 */
async function markExhibitorClosed(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<void> {
  await exhibitorsRef(db, eventId)
    .doc(exhibitorId)
    .update({ closedAt: new Date().toISOString() });
}

// ─── 実体化（pending → completed） ───

export type MaterializeResult =
  | { ok: true; exhibitorId: string; alreadyCompleted: boolean }
  | { ok: false; status: number; error: string };

/**
 * 申込を実体化する: 参加店／協賛レコードを作り、アクセスコードの
 * 招待メールを送り、申込を完了にする。Webhook と戻り照会の両経路が
 * ここに寄る。冪等性は申込レコードの claim（claimedAt）＋状態で担保し、
 * メールは実体化のときに1回だけ送られる。
 * - 既に完了していれば何もしない（alreadyCompleted）。
 * - 別の経路が処理中（claim が新しい）なら、その経路に任せる。
 * - 実体化の途中で落ちた場合は、予定 ID のレコードがあれば作り直さず
 *   完了だけを記録する（メールは主催者の再発行で補える）。
 */
export async function materializeApplication(
  db: Firestore,
  eventId: string,
  applicationId: string,
  stripeLink?: {
    customerId: string | null;
    subscriptionId: string | null;
  },
  depsArg?: Partial<ApplyDeps>,
): Promise<MaterializeResult> {
  const deps = withDeps(depsArg);
  const ref = applicationRef(db, eventId, applicationId);

  type Claim =
    | { state: 'missing' }
    | { state: 'completed'; app: PendingApplication }
    | { state: 'busy'; app: PendingApplication }
    | { state: 'claimed'; app: PendingApplication };
  const claim = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { state: 'missing' } as Claim;
    const app = toApplication(snap.id, snap.data()!);
    if (app.status === 'completed') return { state: 'completed', app } as Claim;
    const claimedAt = stringOrNull(snap.data()?.claimedAt);
    if (
      claimedAt &&
      Date.now() - new Date(claimedAt).getTime() < CLAIM_STALE_MS
    ) {
      return { state: 'busy', app } as Claim;
    }
    tx.update(ref, {
      claimedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { state: 'claimed', app } as Claim;
  });

  if (claim.state === 'missing') {
    return { ok: false, status: 404, error: '申込が見つかりません' };
  }
  if (claim.state === 'completed') {
    return {
      ok: true,
      exhibitorId: claim.app.exhibitorId ?? claim.app.plannedExhibitorId,
      alreadyCompleted: true,
    };
  }
  if (claim.state === 'busy') {
    // もう一方の経路が実体化している。呼び出し側には受付済みとして返す。
    return {
      ok: true,
      exhibitorId: claim.app.plannedExhibitorId,
      alreadyCompleted: false,
    };
  }
  const app = claim.app;

  // 参加店／協賛レコードの作成（既にあれば作り直さない）。
  let mailSent = false;
  const plannedSnap = await exhibitorsRef(db, eventId)
    .doc(app.plannedExhibitorId)
    .get();
  if (!plannedSnap.exists) {
    const event = await getApplyEventInfo(db, eventId);
    try {
      const result = await deps.register({
        eventId,
        name: app.name,
        email: app.email,
        lang: app.lang,
        eventName: event?.name ?? null,
        kind: app.type === 'advertiser' ? 'advertiser' : 'shop',
        source: 'self',
        exhibitorId: app.plannedExhibitorId,
        // 参加店の住所は申込レコードから引き継ぎ、参加店ドキュメントの
        // トップレベル address（管理用）に保存する。広告申込は対象外。
        ...(app.type === 'shop' && app.address
          ? { address: app.address }
          : {}),
      });
      mailSent = result.mailSent;
    } catch (error) {
      if (error instanceof ExhibitorAccessError) {
        // 申込後に同じメールで別のレコードが作られていた等。
        // 申込は pending のまま残し（claim は古くなれば再試行できる）、
        // 呼び出し側へ衝突を返す。
        console.error('[event-apply] materialize conflict:', error.message);
        return { ok: false, status: error.status, error: error.message };
      }
      throw error;
    }
  }

  // 課金レコード側の仕上げ。
  if (app.type === 'shop') {
    const billingRef = db
      .collection('events')
      .doc(eventId)
      .collection(SHOP_BILLINGS_COLLECTION)
      .doc(app.plannedExhibitorId);
    if (app.amount === 0) {
      // 無料の登録: 契約なしで掲載可能な状態を記録する。
      await billingRef.set(
        {
          monthlyAmount: 0,
          status: 'active',
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          checkoutUrl: null,
          checkoutSessionId: null,
          canceledByAdmin: false,
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    } else if (stripeLink?.subscriptionId || stripeLink?.customerId) {
      await billingRef.set(
        {
          ...(stripeLink.customerId
            ? { stripeCustomerId: stripeLink.customerId }
            : {}),
          ...(stripeLink.subscriptionId
            ? { stripeSubscriptionId: stripeLink.subscriptionId }
            : {}),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
    }
  } else if (stripeLink?.subscriptionId || stripeLink?.customerId) {
    await db
      .collection('events')
      .doc(eventId)
      .collection(AD_PLACEMENTS_COLLECTION)
      .doc(app.plannedExhibitorId)
      .set(
        {
          ...(stripeLink.customerId
            ? { stripeCustomerId: stripeLink.customerId }
            : {}),
          ...(stripeLink.subscriptionId
            ? { stripeSubscriptionId: stripeLink.subscriptionId }
            : {}),
          updatedAt: new Date().toISOString(),
        },
        { merge: true },
      );
  }

  await patchApplication(db, eventId, applicationId, {
    status: 'completed',
    exhibitorId: app.plannedExhibitorId,
    mailSent,
    completedAt: new Date().toISOString(),
    claimedAt: null,
  });
  return { ok: true, exhibitorId: app.plannedExhibitorId, alreadyCompleted: false };
}

// ─── 申込の開始（共通部品） ───

export type StartApplicationResult =
  | {
      ok: true;
      status: 'pending' | 'completed';
      applicationId: string;
      checkoutUrl: string | null;
      exhibitorId: string | null;
    }
  | { ok: false; status: number; error: string };

/**
 * 支払い待ちの申込を再開する: 以前のセッションが支払い済みなら
 * 実体化し、そうでなければ呼び出し側が新しいセッションを発行する。
 * - 'paid': 支払い済みで実体化まで完了した
 * - 'unpaid': まだ支払われていない（新しいセッションを発行してよい）
 * - 'unknown': 照会できなかった（安全側で新しいセッションを発行する）
 * - 'conflict': 支払い済みだが実体化で衝突した（二重に課金しないよう、
 *   新しいセッションは発行せず主催者の対応に回す）
 */
async function resumeIfAlreadyPaid(
  db: Firestore,
  event: ApplyEventInfo,
  app: PendingApplication,
  organizer: { contractId: string },
  deps: ApplyDeps,
): Promise<'paid' | 'unpaid' | 'unknown' | 'conflict'> {
  if (!app.checkoutSessionId) return 'unpaid';
  const settings = await getStripeBillingSettings(db, organizer.contractId);
  if (!settings) return 'unknown';
  try {
    const session = await deps
      .stripeFactory(settings.secretKey)
      .checkout.sessions.retrieve(app.checkoutSessionId);
    const interpreted = interpretApplicationCheckoutSession(session);
    if (!interpreted || interpreted.applicationId !== app.id) return 'unknown';
    if (!interpreted.paid) return 'unpaid';
    const result = await materializeApplication(
      db,
      event.id,
      app.id,
      {
        customerId: interpreted.customerId,
        subscriptionId: interpreted.subscriptionId,
      },
      deps,
    );
    return result.ok ? 'paid' : 'conflict';
  } catch {
    return 'unknown';
  }
}

const APPLY_CONFLICT_ERROR =
  'お支払いは確認できましたが、登録の完了に問題が発生しました。プロジェクトの主催者へお問い合わせください';

// ─── 参加店の自己登録 ───

const SHOP_NOT_AVAILABLE_ERROR = '現在参加店の登録は受け付けていません';

/**
 * 参加店の自己登録を始める。
 * - 前提: プロジェクトに月額が設定され、主催者の店舗課金オプションと
 *   Stripe が使える状態であること（charges/ads と同じ可用性解決）。
 * - 同じメールの既存レコードは decideExistingExhibitor で捌く
 *   （重複拒否／掲載停止中は拒否／3ヶ月経過は閉店にして通す）。
 * - 料金 0 は支払いなしでそのまま実体化する。
 * - 有料は申込レコード＋店舗課金のレコードを予定 ID で作り、
 *   Checkout（subscription）の URL を返す。
 */
export async function startShopApplication(
  db: Firestore,
  eventId: string,
  rawInput: unknown,
  depsArg?: Partial<ApplyDeps>,
): Promise<StartApplicationResult> {
  const deps = withDeps(depsArg);
  const parsed = parseApplicationInput(rawInput);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const { name, email } = parsed.value;

  const event = await getApplyEventInfo(db, eventId);
  if (!event) return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  if (event.shopMonthlyPrice === null) {
    return { ok: false, status: 404, error: SHOP_NOT_AVAILABLE_ERROR };
  }
  const availability = await deps.resolveAvailability(db, event.ownerUid);
  if (!availability.available || !availability.organizer) {
    return { ok: false, status: 404, error: SHOP_NOT_AVAILABLE_ERROR };
  }
  const organizer = availability.organizer;

  // 住所: 店舗課金オプションが有効な契約では必須（主催者発行と共通の
  // parseRegistrationAddress で検証する）。検証した住所は申込レコードに
  // 保持し、実体化時に参加店ドキュメントのトップレベル address へ渡す。
  const addressResult = parseRegistrationAddress(
    (rawInput as Record<string, unknown>).address,
    organizer.billingOptionEnabled === true,
  );
  if (!addressResult.ok) {
    return { ok: false, status: 400, error: addressResult.error };
  }
  const address = addressResult.value || null;

  const existing = await findExhibitorStateByEmail(db, eventId, email);
  const decision = decideExistingExhibitor(existing, new Date());
  if (decision.action === 'reject') {
    return {
      ok: false,
      status: 400,
      error:
        decision.reason === 'delisted'
          ? 'このメールアドレスは現在ご登録いただけません。プロジェクトの主催者へお問い合わせください'
          : 'そのメールアドレスはこのプロジェクトで既に登録されています',
    };
  }
  if (decision.action === 'close-and-proceed') {
    await markExhibitorClosed(db, eventId, decision.exhibitorId);
  }

  // 支払い待ちの申込があれば再開する（金額は申込時点のまま）。
  const pending = await findPendingApplication(db, eventId, 'shop', email);
  if (pending) {
    // 住所の必須化より前に作られた申込など、今回の入力と異なる場合は
    // 実体化で使われるよう、申込レコード側を今回の住所に合わせる。
    if (pending.address !== address) {
      await patchApplication(db, eventId, pending.id, { address });
    }
    const resumed = await resumeIfAlreadyPaid(db, event, pending, organizer, deps);
    if (resumed === 'paid') {
      return {
        ok: true,
        status: 'completed',
        applicationId: pending.id,
        checkoutUrl: null,
        exhibitorId: pending.plannedExhibitorId,
      };
    }
    if (resumed === 'conflict') {
      return { ok: false, status: 409, error: APPLY_CONFLICT_ERROR };
    }
    if (pending.amount === 0) {
      const result = await materializeApplication(db, eventId, pending.id, undefined, deps);
      if (!result.ok) return result;
      return {
        ok: true,
        status: 'completed',
        applicationId: pending.id,
        checkoutUrl: null,
        exhibitorId: result.exhibitorId,
      };
    }
    return issueShopCheckout(db, event, pending, organizer, deps);
  }

  const plannedExhibitorId = exhibitorsRef(db, eventId).doc().id;
  const app = await createApplicationRecord(db, eventId, {
    type: 'shop',
    name,
    email,
    address,
    lang: event.defaultLocale,
    amount: event.shopMonthlyPrice,
    plannedExhibitorId,
  });

  if (event.shopMonthlyPrice === 0) {
    const result = await materializeApplication(db, eventId, app.id, undefined, deps);
    if (!result.ok) return result;
    return {
      ok: true,
      status: 'completed',
      applicationId: app.id,
      checkoutUrl: null,
      exhibitorId: result.exhibitorId,
    };
  }
  return issueShopCheckout(db, event, app, organizer, deps);
}

/** 参加店申込の Checkout を発行し、店舗課金のレコードを予定 ID で作る。 */
async function issueShopCheckout(
  db: Firestore,
  event: ApplyEventInfo,
  app: PendingApplication,
  organizer: { contractId: string },
  deps: ApplyDeps,
): Promise<StartApplicationResult> {
  const settings = await getStripeBillingSettings(db, organizer.contractId);
  if (!settings) {
    return { ok: false, status: 404, error: SHOP_NOT_AVAILABLE_ERROR };
  }
  const stripe = deps.stripeFactory(settings.secretKey);

  let customerId = app.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: app.name,
      metadata: {
        contractId: organizer.contractId,
        eventId: event.id,
        applicationId: app.id,
        exhibitorId: app.plannedExhibitorId,
      },
    });
    customerId = customer.id;
  }

  const origin = resolveAppOrigin();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'jpy',
          unit_amount: app.amount,
          recurring: { interval: 'month' },
          product_data: { name: 'Push-taro.スタンプラリー 参加店 月額料金' },
        },
      },
    ],
    // セッション側は申込用 kind（完了イベントの振り分け用）。
    metadata: {
      kind: SHOP_REGISTRATION_KIND,
      contractId: organizer.contractId,
      eventId: event.id,
      applicationId: app.id,
      exhibitorId: app.plannedExhibitorId,
    },
    // サブスクリプション側は店舗課金の形（kind なし）。以後の請求書・
    // 契約イベントは既存の店舗課金 Webhook が処理する。
    subscription_data: {
      metadata: {
        contractId: organizer.contractId,
        eventId: event.id,
        exhibitorId: app.plannedExhibitorId,
      },
    },
    success_url: `${origin}/e/${event.id}/apply?apply=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/e/${event.id}/apply?apply=canceled`,
  });
  if (!session.url) {
    return { ok: false, status: 502, error: '支払いページの発行に失敗しました' };
  }

  // 店舗課金のレコードを予定 ID で先に作る（startShopBilling と同じ形。
  // 再開時は既存の状態を潰さない）。
  const billingRef = db
    .collection('events')
    .doc(event.id)
    .collection(SHOP_BILLINGS_COLLECTION)
    .doc(app.plannedExhibitorId);
  const existingBilling = await billingRef.get();
  const existingStatus = existingBilling.data()?.status;
  await billingRef.set(
    {
      monthlyAmount: app.amount,
      stripeCustomerId: customerId,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      status:
        typeof existingStatus === 'string' && existingStatus !== 'canceled'
          ? existingStatus
          : 'none',
      canceledByAdmin: false,
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  await patchApplication(db, event.id, app.id, {
    checkoutSessionId: session.id,
    stripeCustomerId: customerId,
  });
  return {
    ok: true,
    status: 'pending',
    applicationId: app.id,
    checkoutUrl: session.url,
    exhibitorId: null,
  };
}

// ─── 広告の自己申込 ───

const AD_NOT_AVAILABLE_ERROR = '現在広告のお申し込みは受け付けていません';

/**
 * 広告の自己申込を始める。
 * - 前提: 広告オプション（主催者の契約）が有効で、プロジェクトの
 *   広告が有効（adsEnabled）で、料金が設定されていること。
 *   有料の間は課金レール（店舗課金オプション＋Stripe）も必要。
 *   料金 0 は支払いなしでそのまま実体化する（既存の広告の無料運用と
 *   同じく、Stripe が無くても申し込める）。
 * - 同じメールの既存レコードがあれば断る（協賛はログインへ案内）。
 */
export async function startAdApplication(
  db: Firestore,
  eventId: string,
  rawInput: unknown,
  depsArg?: Partial<ApplyDeps>,
): Promise<StartApplicationResult> {
  const deps = withDeps(depsArg);
  const parsed = parseApplicationInput(rawInput);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const { name, email } = parsed.value;

  const event = await getApplyEventInfo(db, eventId);
  if (!event) return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };

  const adsOptionEnabled = await deps.resolveAdsOption(event.ownerUid);
  if (
    !isAdsActionAllowed('checkout', {
      adsOptionEnabled,
      adsEnabled: event.adsEnabled,
    }) ||
    event.adsPrice === null
  ) {
    return { ok: false, status: 404, error: AD_NOT_AVAILABLE_ERROR };
  }

  let organizer: { contractId: string } | null = null;
  if (event.adsPrice > 0) {
    const availability = await deps.resolveAvailability(db, event.ownerUid);
    if (!availability.available || !availability.organizer) {
      return { ok: false, status: 404, error: AD_NOT_AVAILABLE_ERROR };
    }
    organizer = availability.organizer;
  }

  const existing = await findExhibitorStateByEmail(db, eventId, email);
  if (existing) {
    if (existing.kind === 'advertiser') {
      return {
        ok: false,
        status: 409,
        error:
          'そのメールアドレスは広告主として登録済みです。店舗ページからログインしてください',
      };
    }
    return {
      ok: false,
      status: 400,
      error: 'そのメールアドレスはこのプロジェクトで既に登録されています',
    };
  }

  const pending = await findPendingApplication(db, eventId, 'advertiser', email);
  if (pending) {
    if (pending.amount === 0) {
      const result = await materializeApplication(db, eventId, pending.id, undefined, deps);
      if (!result.ok) return result;
      return {
        ok: true,
        status: 'completed',
        applicationId: pending.id,
        checkoutUrl: null,
        exhibitorId: result.exhibitorId,
      };
    }
    if (!organizer) {
      return { ok: false, status: 404, error: AD_NOT_AVAILABLE_ERROR };
    }
    const resumed = await resumeIfAlreadyPaid(db, event, pending, organizer, deps);
    if (resumed === 'paid') {
      return {
        ok: true,
        status: 'completed',
        applicationId: pending.id,
        checkoutUrl: null,
        exhibitorId: pending.plannedExhibitorId,
      };
    }
    if (resumed === 'conflict') {
      return { ok: false, status: 409, error: APPLY_CONFLICT_ERROR };
    }
    return issueAdCheckout(db, event, pending, organizer, deps);
  }

  const plannedExhibitorId = exhibitorsRef(db, eventId).doc().id;
  const app = await createApplicationRecord(db, eventId, {
    type: 'advertiser',
    name,
    email,
    address: null,
    lang: event.defaultLocale,
    amount: event.adsPrice,
    plannedExhibitorId,
  });

  if (event.adsPrice === 0) {
    const result = await materializeApplication(db, eventId, app.id, undefined, deps);
    if (!result.ok) return result;
    return {
      ok: true,
      status: 'completed',
      applicationId: app.id,
      checkoutUrl: null,
      exhibitorId: result.exhibitorId,
    };
  }
  // adsPrice > 0 のときは上で organizer を解決済み。
  return issueAdCheckout(db, event, app, organizer!, deps);
}

/** 広告申込の Checkout を発行し、広告契約のレコードを予定 ID で作る。 */
async function issueAdCheckout(
  db: Firestore,
  event: ApplyEventInfo,
  app: PendingApplication,
  organizer: { contractId: string },
  deps: ApplyDeps,
): Promise<StartApplicationResult> {
  const settings = await getStripeBillingSettings(db, organizer.contractId);
  if (!settings) {
    return { ok: false, status: 404, error: AD_NOT_AVAILABLE_ERROR };
  }
  const stripe = deps.stripeFactory(settings.secretKey);

  let customerId = app.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: app.name,
      metadata: {
        kind: AD_APPLICATION_KIND,
        contractId: organizer.contractId,
        eventId: event.id,
        applicationId: app.id,
        exhibitorId: app.plannedExhibitorId,
      },
    });
    customerId = customer.id;
  }

  const origin = resolveAppOrigin();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'jpy',
          unit_amount: app.amount,
          recurring: { interval: 'month' },
          product_data: { name: 'Push-taro.スタンプラリー 特設サイト 広告掲載' },
        },
      },
    ],
    // セッション側は申込用 kind（完了イベントの振り分け用）。
    metadata: {
      kind: AD_APPLICATION_KIND,
      contractId: organizer.contractId,
      eventId: event.id,
      applicationId: app.id,
      exhibitorId: app.plannedExhibitorId,
    },
    // サブスクリプション側は広告契約の形（kind = 'ad-placement'）。
    // 以後の請求書・契約イベントは既存の広告 Webhook が処理する。
    subscription_data: {
      metadata: {
        kind: 'ad-placement',
        contractId: organizer.contractId,
        eventId: event.id,
        exhibitorId: app.plannedExhibitorId,
      },
    },
    success_url: `${origin}/e/${event.id}/ad-apply?apply=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/e/${event.id}/ad-apply?apply=canceled`,
  });
  if (!session.url) {
    return { ok: false, status: 502, error: '支払いページの発行に失敗しました' };
  }

  // 広告契約のレコードを予定 ID で先に作る（startAdPlacement と同じ形。
  // 再開時は既存の状態を潰さない）。
  const placementRef = db
    .collection('events')
    .doc(event.id)
    .collection(AD_PLACEMENTS_COLLECTION)
    .doc(app.plannedExhibitorId);
  const existingPlacement = await placementRef.get();
  const existingPlacementStatus = existingPlacement.data()?.status;
  await placementRef.set(
    {
      monthlyAmount: app.amount,
      stripeCustomerId: customerId,
      checkoutSessionId: session.id,
      checkoutUrl: session.url,
      status:
        typeof existingPlacementStatus === 'string' &&
        existingPlacementStatus !== 'canceled'
          ? existingPlacementStatus
          : 'unpaid',
      updatedAt: new Date().toISOString(),
    },
    { merge: true },
  );
  await patchApplication(db, event.id, app.id, {
    checkoutSessionId: session.id,
    stripeCustomerId: customerId,
  });
  return {
    ok: true,
    status: 'pending',
    applicationId: app.id,
    checkoutUrl: session.url,
    exhibitorId: null,
  };
}

// ─── 照会による検証と反映（Checkout からの戻り） ───

export type VerifyApplicationResult =
  | {
      ok: true;
      type: ApplicationType;
      exhibitorId: string;
      alreadyCompleted: boolean;
    }
  | { ok: false; status: number; error: string };

/**
 * 申込者が Checkout から戻ったときの検証: 主催者の Stripe でセッションを
 * 照会し、支払い済みで、metadata の所属（プロジェクト・申込）が
 * 対象の申込と一致することを確認してから実体化する。
 * セッション ID 自体が申込者だけに渡る控えになる（店舗の単発課金の
 * 照会と同じ考え方）。未払いは 402。
 */
export async function verifyAndApplyApplication(
  db: Firestore,
  input: { eventId: string; sessionId: string },
  depsArg?: Partial<ApplyDeps>,
): Promise<VerifyApplicationResult> {
  const deps = withDeps(depsArg);
  const event = await getApplyEventInfo(db, input.eventId);
  if (!event) {
    return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  }
  const availability = await deps.resolveAvailability(db, event.ownerUid);
  if (!availability.available || !availability.organizer) {
    return { ok: false, status: 400, error: 'Stripe設定が未完了です' };
  }
  const settings = await getStripeBillingSettings(
    db,
    availability.organizer.contractId,
  );
  if (!settings) {
    return { ok: false, status: 400, error: 'Stripe設定が未完了です' };
  }
  let session: unknown;
  try {
    session = await deps
      .stripeFactory(settings.secretKey)
      .checkout.sessions.retrieve(input.sessionId);
  } catch {
    return { ok: false, status: 404, error: '支払い情報が見つかりません' };
  }
  const interpreted = interpretApplicationCheckoutSession(session);
  if (!interpreted) {
    return { ok: false, status: 400, error: '支払い情報が不正です' };
  }
  if (interpreted.eventId !== input.eventId) {
    return { ok: false, status: 403, error: 'この支払いはこのプロジェクトのものではありません' };
  }
  const app = await getApplication(db, input.eventId, interpreted.applicationId);
  if (!app || app.type !== interpreted.type) {
    return { ok: false, status: 404, error: '申込が見つかりません' };
  }
  if (!interpreted.paid) {
    return { ok: false, status: 402, error: 'お支払いが完了していません' };
  }
  const result = await materializeApplication(
    db,
    input.eventId,
    app.id,
    {
      customerId: interpreted.customerId,
      subscriptionId: interpreted.subscriptionId,
    },
    deps,
  );
  if (!result.ok) return result;
  return {
    ok: true,
    type: app.type,
    exhibitorId: result.exhibitorId,
    alreadyCompleted: result.alreadyCompleted,
  };
}

// ─── Webhook による反映 ───

export interface ApplyApplicationWebhookResult {
  applied: boolean;
  duplicate: boolean;
}

/**
 * 申込宛の Webhook イベントをローカル記録へ反映する（実体化）。
 * 照会経由の反映と同じ materializeApplication に寄せ、両経路で
 * 結果が一致するようにする。
 */
export async function applyApplicationWebhookEffect(
  db: Firestore,
  event: StripeWebhookEventLike,
  depsArg?: Partial<ApplyDeps>,
): Promise<ApplyApplicationWebhookResult> {
  const effect = effectFromStripeEventForApplication(event);
  if (!effect) return { applied: false, duplicate: false };
  const app = await getApplication(db, effect.eventId, effect.applicationId);
  if (!app) return { applied: false, duplicate: false };
  const result = await materializeApplication(
    db,
    effect.eventId,
    effect.applicationId,
    {
      customerId: effect.customerId,
      subscriptionId: effect.subscriptionId,
    },
    depsArg,
  );
  if (!result.ok) {
    console.error('[event-apply] webhook materialize failed:', result.error);
    return { applied: false, duplicate: false };
  }
  return { applied: !result.alreadyCompleted, duplicate: result.alreadyCompleted };
}

// ─── 申込ページ向けの公開情報 ───

export interface ApplyPageInfo {
  eventName: string;
  defaultLocale: Locale;
  shop: {
    available: boolean;
    fee: number | null;
    /** 店舗課金オプション ON のとき、登録フォームで住所が必須になる */
    billingAddressRequired: boolean;
  };
  ad: { available: boolean; fee: number | null };
}

/**
 * 申込ページの表示に必要な公開情報（受付可否と料金）。
 * 受付可否はサーバー側で判定し、ページは結果だけを見る。
 */
export async function getApplyPageInfo(
  db: Firestore,
  eventId: string,
  depsArg?: Partial<ApplyDeps>,
): Promise<ApplyPageInfo | null> {
  const deps = withDeps(depsArg);
  const event = await getApplyEventInfo(db, eventId);
  if (!event) return null;
  const availability = await deps.resolveAvailability(db, event.ownerUid);
  const adsOptionEnabled = await deps.resolveAdsOption(event.ownerUid);
  const shopAvailable =
    event.shopMonthlyPrice !== null && availability.available;
  const adAvailable =
    isAdsActionAllowed('checkout', {
      adsOptionEnabled,
      adsEnabled: event.adsEnabled,
    }) &&
    event.adsPrice !== null &&
    (event.adsPrice === 0 || availability.available);
  return {
    eventName: event.name,
    defaultLocale: event.defaultLocale,
    shop: {
      available: shopAvailable,
      fee: event.shopMonthlyPrice,
      billingAddressRequired:
        availability.organizer?.billingOptionEnabled === true,
    },
    ad: { available: adAvailable, fee: event.adsPrice },
  };
}
