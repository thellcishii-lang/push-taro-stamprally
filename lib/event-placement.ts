// lib/event-placement.ts
// Push-taro.スタンプラリー のトップ掲載課金（特設サイトの先頭5枠）。
//
// 仕組み:
// - 特設サイト（本家）のプロジェクトトップに表示される参加店は5件だけ。
//   参加店は月額（プロジェクトの topPlacementPrice）を払うと、その5枠に
//   優先表示される（表示側の選定は本家が行う。ここは課金の正を持つ）。
// - 決済レールは店舗課金オプションと共用: 「主催者自身の Stripe」
//   （lib/event-billing.ts の設定・Webhook 受信口）を使い、Checkout の
//   metadata.kind = 'top-placement' で店舗課金と区別する。
// - 掲載状態は参加店ドキュメントのトップレベル項目 `topFeatured` に
//   非正規化して持つ（billingSuspended と同じ考え方。プロフィール保存で
//   消えたり店が付け替えたりはできない）。公開APIはこのフラグを返す。
// - 状態遷移は店舗課金に揃える: 支払い失敗（past_due）の間は掲載を続け、
//   未払い確定（unpaid）・解約（canceled）で掲載を止める。
import type { Firestore } from 'firebase-admin/firestore';
import {
  findOrganizerByOwnerUid,
  getOrganizer,
  type Organizer,
} from './organizers';
import { listEventsByOwner } from './event-store';
import { setShopTopFeatured } from './event-shop';
import { resolveAppOrigin } from './app-origin';
import {
  BILLING_PAYMENTS_COLLECTION,
  createStripeClient,
  getStripeBillingSettings,
  type BillingPaymentDraft,
  type StripeWebhookEventLike,
} from './event-billing';

export const TOP_PLACEMENTS_COLLECTION = 'topPlacements';
/** Checkout / サブスクリプションの metadata.kind（店舗課金との区別）。 */
export const TOP_PLACEMENT_KIND = 'top-placement';

/** トップ掲載の契約状態。 */
export type TopPlacementStatus =
  | 'active' // 支払い済み・掲載中
  | 'past_due' // 支払い失敗・Stripe のリトライ中（掲載は継続）
  | 'canceled' // 解約済み
  | 'unpaid'; // 未払い確定（または Checkout 発行済みで未払い）

export interface TopPlacement {
  exhibitorId: string;
  status: TopPlacementStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** 申込時点の月額（円）。料金変更後も既存契約はこの金額のまま */
  monthlyAmount: number;
  /** 店に渡す支払いページ（Checkout）の URL。発行時のみ */
  checkoutUrl: string | null;
  checkoutSessionId: string | null;
  updatedAt: string;
}

// ─── 純粋関数: 状態と掲載判定 ───

export function parseTopPlacementStatus(value: unknown): TopPlacementStatus {
  return value === 'active' ||
    value === 'past_due' ||
    value === 'canceled'
    ? value
    : 'unpaid';
}

/**
 * 掲載状態 → トップ掲載（topFeatured）にするかどうか（純粋関数）。
 * 支払いが回っている間（active）と、失敗のリトライ中（past_due）は
 * 掲載を続ける。未払い確定（unpaid）と解約（canceled）は掲載しない。
 */
export function isTopFeaturedForStatus(status: TopPlacementStatus): boolean {
  return status === 'active' || status === 'past_due';
}

/**
 * Stripe のサブスクリプション状態 → ローカルの状態と掲載への効果。
 * 店舗課金（shopBillingTransitionForSubscriptionStatus）と揃える:
 * - active / trialing: active・掲載する
 * - past_due / paused: past_due（掲載フラグには触らない）
 * - unpaid: unpaid・掲載を止める
 * - canceled / incomplete_expired: canceled・掲載を止める
 * - incomplete: 初回支払い未完了。記録は Checkout 発行時点の unpaid の
 *   ままにするため、ここでは対象外（null）。
 * 未知の状態も null（何もしない）。
 */
export function placementTransitionForSubscriptionStatus(
  stripeStatus: unknown,
): { status: TopPlacementStatus; featured: boolean | null } | null {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return { status: 'active', featured: true };
    case 'past_due':
    case 'paused':
      return { status: 'past_due', featured: null };
    case 'unpaid':
      return { status: 'unpaid', featured: false };
    case 'canceled':
    case 'incomplete_expired':
      return { status: 'canceled', featured: false };
    case 'incomplete':
      return null;
    default:
      return null;
  }
}

// ─── 純粋関数: Webhook イベントの振り分けと効果 ───

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
function subscriptionIdFromInvoice(
  invoice: Record<string, unknown>,
): string | null {
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

/**
 * Webhook イベントの metadata.kind を取り出す（振り分け用・純粋関数）。
 * 店舗課金の Checkout / サブスクリプションには kind が無いため null に
 * なり、呼び出し側は null を店舗課金として処理する。
 */
export function stripeEventKind(
  event: StripeWebhookEventLike,
): string | null {
  const object = asRecord(event.data?.object) ?? {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const metadata =
        asRecord(object.metadata) ??
        asRecord(asRecord(object.subscription_details)?.metadata);
      return metadataString(metadata, 'kind');
    }
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return metadataString(metadataFromInvoice(object), 'kind');
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return metadataString(asRecord(object.metadata), 'kind');
    default:
      return null;
  }
}

export interface TopPlacementEffect {
  subscriptionId: string | null;
  customerId: string | null;
  /** Checkout / サブスクリプションの metadata から得た所属（無ければ null） */
  metadataEventId: string | null;
  metadataExhibitorId: string | null;
  placementPatch: {
    status?: TopPlacementStatus;
    stripeSubscriptionId?: string;
    stripeCustomerId?: string;
  };
  /** null = 掲載フラグに触らない / true = 掲載する / false = 掲載を止める */
  featured: boolean | null;
  payment: BillingPaymentDraft | null;
}

/**
 * トップ掲載宛の Webhook イベントを、ローカル記録への効果に変換する。
 * metadata.kind が 'top-placement' でないイベントは null
 * （店舗課金側の処理対象）。
 */
export function effectFromStripeEventForPlacement(
  event: StripeWebhookEventLike,
): TopPlacementEffect | null {
  if (stripeEventKind(event) !== TOP_PLACEMENT_KIND) return null;
  const object = asRecord(event.data?.object) ?? {};
  const occurredAt = unixToIso(event.created) ?? new Date().toISOString();

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
        placementPatch: {
          ...(subscriptionId ? { stripeSubscriptionId: subscriptionId } : {}),
          ...(customerId ? { stripeCustomerId: customerId } : {}),
        },
        featured: null,
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
        placementPatch: { status: 'active' },
        featured: isTopFeaturedForStatus('active'),
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
        // Stripe のリトライを尊重し、掲載はこの時点では止めない。
        placementPatch: { status: 'past_due' },
        featured: null,
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
      const transition = placementTransitionForSubscriptionStatus(
        object.status,
      );
      if (!transition) return null;
      const metadata = asRecord(object.metadata);
      return {
        subscriptionId: stringOrNull(object.id),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        placementPatch: { status: transition.status },
        featured: transition.featured,
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
        placementPatch: { status: 'canceled' },
        featured: isTopFeaturedForStatus('canceled'),
        payment: null,
      };
    }
    default:
      return null;
  }
}

// ─── Firestore: トップ掲載レコード ───

function topPlacementRef(db: Firestore, eventId: string, exhibitorId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(TOP_PLACEMENTS_COLLECTION)
    .doc(exhibitorId);
}

function topPlacementsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(TOP_PLACEMENTS_COLLECTION);
}

function toTopPlacement(
  exhibitorId: string,
  data: FirebaseFirestore.DocumentData,
): TopPlacement {
  return {
    exhibitorId,
    status: parseTopPlacementStatus(data.status),
    stripeCustomerId: stringOrNull(data.stripeCustomerId),
    stripeSubscriptionId: stringOrNull(data.stripeSubscriptionId),
    monthlyAmount:
      typeof data.monthlyAmount === 'number' ? data.monthlyAmount : 0,
    checkoutUrl: stringOrNull(data.checkoutUrl),
    checkoutSessionId: stringOrNull(data.checkoutSessionId),
    updatedAt:
      typeof data.updatedAt === 'string'
        ? data.updatedAt
        : (data.updatedAt?.toDate?.().toISOString() ?? ''),
  };
}

export async function getTopPlacement(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<TopPlacement | null> {
  const snap = await topPlacementRef(db, eventId, exhibitorId).get();
  if (!snap.exists) return null;
  return toTopPlacement(exhibitorId, snap.data()!);
}

async function writeTopPlacement(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  fields: Record<string, unknown>,
): Promise<TopPlacement> {
  await topPlacementRef(db, eventId, exhibitorId).set(
    { ...fields, updatedAt: new Date().toISOString() },
    { merge: true },
  );
  const placement = await getTopPlacement(db, eventId, exhibitorId);
  return placement!;
}

// ─── 購入条件の解決 ───

/**
 * プロジェクトのトップ掲載が「今買える」状態かどうかと、その理由。
 * 店舗ページの表示判定と購入 API の検証で共用する。
 * 契約者レコードが無い・店舗課金オプション OFF・Stripe 未設定の
 * いずれかなら買えない（店舗課金のレールを使うため）。
 */
export interface TopPlacementAvailability {
  available: boolean;
  organizer: Organizer | null;
  stripeConfigured: boolean;
}

export async function resolveTopPlacementAvailability(
  db: Firestore,
  ownerUid: string,
): Promise<TopPlacementAvailability> {
  const organizer = await findOrganizerByOwnerUid(ownerUid);
  if (!organizer || !organizer.billingOptionEnabled) {
    return { available: false, organizer: null, stripeConfigured: false };
  }
  const settings = await getStripeBillingSettings(db, organizer.contractId);
  return {
    available: settings !== null,
    organizer,
    stripeConfigured: settings !== null,
  };
}

// ─── 申込（Checkout セッション発行） ───

export interface StartTopPlacementInput {
  contractId: string;
  eventId: string;
  exhibitorId: string;
  exhibitorName: string;
  monthlyAmount: number;
}

export type StartTopPlacementResult =
  | { ok: true; placement: TopPlacement; checkoutUrl: string }
  | { ok: false; status: number; error: string };

/**
 * トップ掲載の申込を始める: Stripe 顧客（無ければ作成）＋金額を直接
 * 指定して Checkout セッション（subscription モード）を発行する。
 * 店舗課金との区別は metadata.kind = 'top-placement'（セッションと
 * サブスクリプションの両方に付ける）。支払い完了後の戻り先は店舗
 * ページ。料金は申込時点のプロジェクト設定で固定され、主催者が
 * 後から料金を変えても既存契約の金額は変わらない（Stripe の仕様）。
 */
export async function startTopPlacement(
  db: Firestore,
  input: StartTopPlacementInput,
): Promise<StartTopPlacementResult> {
  const settings = await getStripeBillingSettings(db, input.contractId);
  if (!settings) {
    return {
      ok: false,
      status: 400,
      error: 'Stripe設定が未完了のため、現在お申し込みできません',
    };
  }
  const stripe = createStripeClient(settings.secretKey);
  const existing = await getTopPlacement(db, input.eventId, input.exhibitorId);

  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: input.exhibitorName,
      metadata: {
        kind: TOP_PLACEMENT_KIND,
        contractId: input.contractId,
        eventId: input.eventId,
        exhibitorId: input.exhibitorId,
      },
    });
    customerId = customer.id;
  }

  const metadata = {
    kind: TOP_PLACEMENT_KIND,
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
          product_data: { name: 'Push-taro.スタンプラリー 特設サイト トップ掲載' },
        },
      },
    ],
    metadata,
    subscription_data: { metadata },
    success_url: `${origin}/e/${input.eventId}/shop?placement=success`,
    cancel_url: `${origin}/e/${input.eventId}/shop?placement=canceled`,
  });
  if (!session.url) {
    return {
      ok: false,
      status: 502,
      error: '支払いページの発行に失敗しました',
    };
  }

  const placement = await writeTopPlacement(db, input.eventId, input.exhibitorId, {
    monthlyAmount: input.monthlyAmount,
    stripeCustomerId: customerId,
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    status:
      existing && existing.status !== 'canceled' ? existing.status : 'unpaid',
  });
  return { ok: true, placement, checkoutUrl: session.url };
}

// ─── 解約 ───

export type CancelTopPlacementResult =
  | { ok: true; placement: TopPlacement }
  | { ok: false; status: number; error: string };

/**
 * トップ掲載を解約する（店舗課金の解約と同じ作法: Stripe 側を即時
 * 解約し、ローカル記録と掲載フラグもその場で止める。Webhook の
 * customer.subscription.deleted が後から届いても同じ結果になる）。
 */
export async function cancelTopPlacement(
  db: Firestore,
  contractId: string,
  eventId: string,
  exhibitorId: string,
): Promise<CancelTopPlacementResult> {
  const existing = await getTopPlacement(db, eventId, exhibitorId);
  if (!existing) {
    return { ok: false, status: 404, error: 'トップ掲載の契約が見つかりません' };
  }

  if (existing.stripeSubscriptionId) {
    const settings = await getStripeBillingSettings(db, contractId);
    if (!settings) {
      return {
        ok: false,
        status: 400,
        error: 'Stripe設定が未完了のため、解約処理ができません',
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

  const placement = await writeTopPlacement(db, eventId, exhibitorId, {
    status: 'canceled',
    checkoutUrl: null,
    checkoutSessionId: null,
  });
  await setShopTopFeatured(db, eventId, exhibitorId, false);
  return { ok: true, placement };
}

// ─── Webhook の適用 ───

async function findTopPlacementByStripeIds(
  db: Firestore,
  eventIds: string[],
  ids: { subscriptionId: string | null; customerId: string | null },
): Promise<{ eventId: string; placement: TopPlacement } | null> {
  for (const eventId of eventIds) {
    if (ids.subscriptionId) {
      const snap = await topPlacementsRef(db, eventId)
        .where('stripeSubscriptionId', '==', ids.subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return {
          eventId,
          placement: toTopPlacement(snap.docs[0].id, snap.docs[0].data()),
        };
      }
    }
    if (ids.customerId) {
      const snap = await topPlacementsRef(db, eventId)
        .where('stripeCustomerId', '==', ids.customerId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return {
          eventId,
          placement: toTopPlacement(snap.docs[0].id, snap.docs[0].data()),
        };
      }
    }
  }
  return null;
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 6 || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

export interface ApplyTopPlacementWebhookResult {
  applied: boolean;
  duplicate: boolean;
}

/**
 * トップ掲載宛の Webhook イベントをローカル記録へ反映する。
 * 店舗課金の applyStripeWebhookEffect と同じ作法:
 * - 対象の特定は metadata の所属を優先し、無ければ契約者の全
 *   プロジェクトから Stripe の顧客／サブスクリプション ID で引く。
 * - 支払い記録は店舗課金と共用の billingPayments に kind を付けて
 *   記録する。ドキュメントID = Stripe イベントID の create で冪等化。
 * - 掲載フラグ（参加店ドキュメントの topFeatured）は effect.featured
 *   が null でないときだけ付け替える。
 */
export async function applyTopPlacementWebhookEffect(
  db: Firestore,
  contractId: string,
  event: StripeWebhookEventLike,
): Promise<ApplyTopPlacementWebhookResult> {
  const effect = effectFromStripeEventForPlacement(event);
  if (!effect) return { applied: false, duplicate: false };
  const occurredAt = unixToIso(event.created) ?? new Date().toISOString();

  let target: { eventId: string; placement: TopPlacement } | null = null;
  if (effect.metadataEventId && effect.metadataExhibitorId) {
    const placement = await getTopPlacement(
      db,
      effect.metadataEventId,
      effect.metadataExhibitorId,
    );
    if (placement) target = { eventId: effect.metadataEventId, placement };
  }
  if (!target) {
    const organizer = await getOrganizer(contractId);
    if (organizer?.ownerUid) {
      const events = await listEventsByOwner(organizer.ownerUid);
      const found = await findTopPlacementByStripeIds(
        db,
        events.map((e) => e.id),
        {
          subscriptionId: effect.subscriptionId,
          customerId: effect.customerId,
        },
      );
      if (found) target = found;
    }
  }
  if (!target) return { applied: false, duplicate: false };
  const { eventId, placement } = target;
  const exhibitorId = placement.exhibitorId;

  if (effect.payment) {
    const ref = db
      .collection('events')
      .doc(eventId)
      .collection(BILLING_PAYMENTS_COLLECTION)
      .doc(event.id);
    try {
      await ref.create({
        exhibitorId,
        kind: TOP_PLACEMENT_KIND,
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

  await writeTopPlacement(db, eventId, exhibitorId, {
    ...effect.placementPatch,
  });
  if (effect.featured !== null) {
    await setShopTopFeatured(db, eventId, exhibitorId, effect.featured);
  }
  return { applied: true, duplicate: false };
}
