// lib/event-ads.ts
// Push-taro.スタンプラリー の特設サイト広告（参加店の広告枠）。
//
// 仕組み:
// - 主催者が特設サイト編集で広告を有効にし、枠数（adsSlots）と月額
//   （adsPrice）を決める。参加店は月額を払って（料金 0 の間は無料で）
//   広告を出せる。広告はラリーと無関係でよい、店の自由な宣伝。
// - 広告の内容は参加店ドキュメント（exhibitors/{id}）のトップレベル
//   項目 `ad` に持つ（プロフィールの外: プロフィール保存で消えない
//   ように。topFeatured / billingSuspended と同じ考え方）。
// - 承認制: 店が保存すると「申請中（pending）」版になり、掲載中
//   （live）版は主催者が承認するまで変わらない。承認で pending が
//   live に繰り上がり、却下すると pending は破棄される（live は不変）。
// - 課金のレールはトップ掲載と共用: 「主催者自身の Stripe」
//   （lib/event-billing.ts）を使い、Checkout の metadata.kind =
//   'ad-placement' で区別する。契約記録はトップ掲載と同じ形で
//   adPlacements/{exhibitorId} に持つ。
// - 前提条件として、主催者の契約に「広告オプション」（本家との別料金
//   契約、organizers.adsOptionEnabled）が必要。オプションが無効な間は
//   プロジェクト設定（adsEnabled）が ON でも、設定の有効化・申請・
//   申込・承認・掲載のすべてが止まる（判定は isAdsActionAllowed）。
//   既存の広告・契約データは消さず、表示だけが止まる。
// - 掲載可否（公開API）はここで算出する: 有料の間は契約状態
//   （active / past_due）が必要、無料（料金 0）の間は承認だけでよい。
import type { Firestore } from 'firebase-admin/firestore';
import {
  findOrganizerByOwnerUid,
  getOrganizer,
  type Organizer,
} from './organizers';
import { getEvent, listEventsByOwner } from './event-store';
import {
  EVENT_EXHIBITORS_COLLECTION,
  parseExhibitorKind,
  type ExhibitorKind,
} from './event-coupon';
import {
  isShopPubliclyListed,
  parseShopProfile,
} from './event-shop';
import { isHttpsUrl, type EventConfig } from './event';
import { resolveAppOrigin } from './app-origin';
import {
  BILLING_PAYMENTS_COLLECTION,
  createStripeClient,
  getStripeBillingSettings,
  type BillingPaymentDraft,
  type StripeWebhookEventLike,
} from './event-billing';

export const AD_PLACEMENTS_COLLECTION = 'adPlacements';
/** Checkout / サブスクリプションの metadata.kind（店舗課金・トップ掲載との区別）。 */
export const AD_PLACEMENT_KIND = 'ad-placement';

export const AD_CONTENT_LIMITS = {
  title: 40,
  text: 200,
  linkUrl: 500,
} as const;

// ─── 広告の内容と承認状態 ───

/** 広告1件の内容（掲載版・申請版で共通の形）。 */
export interface ShopAdContent {
  /** 広告画像の公開URL。未設定は null */
  imageUrl: string | null;
  title: string;
  text: string;
  /** 遷移先リンク（任意、https のみ） */
  linkUrl: string | null;
}

/**
 * 参加店ドキュメントに持つ広告の状態。
 * - live: 掲載中の版。承認されるまで変わらない。
 * - pending: 承認待ちの版。店が保存するたびに差し替わる。
 */
export interface ShopAd {
  live: ShopAdContent | null;
  pending: ShopAdContent | null;
  /** 申請日時（ISO）。枠の並び順（承認が早い順）には approvedAt を使う */
  pendingSubmittedAt: string | null;
  /** 掲載版が承認された日時（ISO）。公開一覧の並び順に使う */
  approvedAt: string | null;
  /** 最後に却下された日時（ISO）。店への表示用 */
  lastRejectedAt: string | null;
}

export type ShopAdStatus = 'none' | 'pending' | 'live';

export function emptyShopAd(): ShopAd {
  return {
    live: null,
    pending: null,
    pendingSubmittedAt: null,
    approvedAt: null,
    lastRejectedAt: null,
  };
}

function readAdContent(value: unknown): ShopAdContent | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const title =
    typeof record.title === 'string'
      ? record.title.trim().slice(0, AD_CONTENT_LIMITS.title)
      : '';
  if (!title) return null;
  const text =
    typeof record.text === 'string'
      ? record.text.trim().slice(0, AD_CONTENT_LIMITS.text)
      : '';
  const imageUrl =
    typeof record.imageUrl === 'string' && isHttpsUrl(record.imageUrl)
      ? record.imageUrl
      : null;
  const linkUrl =
    typeof record.linkUrl === 'string' && isHttpsUrl(record.linkUrl)
      ? record.linkUrl
      : null;
  return { imageUrl, title, text, linkUrl };
}

function readIsoOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** 保存済みの広告状態を防御的に読む（読み取り用。throw しない）。 */
export function parseShopAd(value: unknown): ShopAd {
  if (typeof value !== 'object' || value === null) return emptyShopAd();
  const record = value as Record<string, unknown>;
  return {
    live: readAdContent(record.live),
    pending: readAdContent(record.pending),
    pendingSubmittedAt: readIsoOrNull(record.pendingSubmittedAt),
    approvedAt: readIsoOrNull(record.approvedAt),
    lastRejectedAt: readIsoOrNull(record.lastRejectedAt),
  };
}

/** 店・主催者向けの状態表示（申請中があれば申請中を優先して見せる）。 */
export function adStatusOf(ad: ShopAd): ShopAdStatus {
  if (ad.pending) return 'pending';
  if (ad.live) return 'live';
  return 'none';
}

export type ValidateAdContentResult =
  | { ok: true; value: ShopAdContent }
  | { ok: false; error: string };

/**
 * 広告内容の保存入力を検証して正規化する（書き込み用）。
 * タイトルは必須（最大40字）、本文は最大200字、画像とリンクは
 * 任意で https のみ。
 */
export function validateAdContentInput(raw: unknown): ValidateAdContentResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'リクエスト形式が不正です' };
  }
  const record = raw as Record<string, unknown>;
  const titleRaw = record.title === undefined ? '' : record.title;
  const textRaw = record.text === undefined ? '' : record.text;
  const imageRaw = record.imageUrl === undefined ? null : record.imageUrl;
  const linkRaw = record.linkUrl === undefined ? null : record.linkUrl;
  if (typeof titleRaw !== 'string' || typeof textRaw !== 'string') {
    return { ok: false, error: '広告の形式が不正です' };
  }
  if (
    (imageRaw !== null && typeof imageRaw !== 'string') ||
    (linkRaw !== null && typeof linkRaw !== 'string')
  ) {
    return { ok: false, error: '広告の形式が不正です' };
  }
  const title = titleRaw.trim();
  const text = textRaw.trim();
  const imageUrl = typeof imageRaw === 'string' ? imageRaw.trim() : null;
  const linkUrl = typeof linkRaw === 'string' ? linkRaw.trim() : null;
  if (!title) {
    return { ok: false, error: '広告のタイトルを入力してください' };
  }
  if (title.length > AD_CONTENT_LIMITS.title) {
    return {
      ok: false,
      error: `広告のタイトルは${AD_CONTENT_LIMITS.title}文字以内で入力してください`,
    };
  }
  if (text.length > AD_CONTENT_LIMITS.text) {
    return {
      ok: false,
      error: `広告の本文は${AD_CONTENT_LIMITS.text}文字以内で入力してください`,
    };
  }
  if (imageUrl && !isHttpsUrl(imageUrl)) {
    return {
      ok: false,
      error: '広告の画像は https:// で始まる必要があります',
    };
  }
  if (linkUrl && !isHttpsUrl(linkUrl)) {
    return {
      ok: false,
      error: '広告のリンクは https:// で始まる必要があります',
    };
  }
  if (linkUrl && linkUrl.length > AD_CONTENT_LIMITS.linkUrl) {
    return {
      ok: false,
      error: `広告のリンクは${AD_CONTENT_LIMITS.linkUrl}文字以内で入力してください`,
    };
  }
  return {
    ok: true,
    value: { imageUrl: imageUrl || null, title, text, linkUrl: linkUrl || null },
  };
}

// ─── 純粋関数: 承認の状態遷移 ───

/**
 * 店の保存（申請）: pending を新しい内容で差し替える。
 * live は承認されるまで一切変わらない。
 */
export function submitAdTransition(
  current: ShopAd,
  content: ShopAdContent,
  nowIso: string,
): ShopAd {
  return {
    ...current,
    pending: content,
    pendingSubmittedAt: nowIso,
  };
}

/**
 * 主催者の承認: pending を live に繰り上げる。
 * pending が無ければ null（承認できるものが無い）。
 */
export function approveAdTransition(
  current: ShopAd,
  nowIso: string,
): ShopAd | null {
  if (!current.pending) return null;
  return {
    live: current.pending,
    pending: null,
    pendingSubmittedAt: null,
    approvedAt: nowIso,
    lastRejectedAt: current.lastRejectedAt,
  };
}

/**
 * 主催者の却下: pending を破棄する。live はそのまま残る。
 * pending が無ければ null。
 */
export function rejectAdTransition(
  current: ShopAd,
  nowIso: string,
): ShopAd | null {
  if (!current.pending) return null;
  return {
    ...current,
    pending: null,
    pendingSubmittedAt: null,
    lastRejectedAt: nowIso,
  };
}

// ─── 純粋関数: 広告オプション（契約）のゲート ───

/** 広告オプションのゲートがかかる操作。 */
export type AdsGatedAction =
  /** 主催者がプロジェクト設定で広告を有効にしようとする操作 */
  | 'enable-setting'
  /** 店・協賛が広告内容を保存（申請）する操作 */
  | 'submit'
  /** 店・協賛が広告の新規契約（Checkout）を始める操作 */
  | 'checkout'
  /** 主催者が広告を承認／却下する操作 */
  | 'review'
  /** 公開一覧（特設サイト）へ広告を出す判定 */
  | 'public-list';

/**
 * 広告オプション × プロジェクト設定の広告 ON/OFF で、各操作が
 * できるかどうかを決める（純粋関数）。
 * - 広告オプションが無効なら、すべての操作ができない。
 * - 「有効化」だけはオプションさえあればできる（設定がまだ OFF でも
 *   ON にする操作そのものは許可する）。
 * - それ以外の操作は、オプションと設定の両方が必要。
 */
export function isAdsActionAllowed(
  action: AdsGatedAction,
  input: { adsOptionEnabled: boolean; adsEnabled: boolean },
): boolean {
  if (!input.adsOptionEnabled) return false;
  if (action === 'enable-setting') return true;
  return input.adsEnabled;
}

/**
 * プロジェクトの所有者（ownerUid）から、広告オプションが有効な
 * 契約かどうかを引く。契約者レコードが無い・フィールドが無い場合は
 * 未契約（false）として扱う（店舗課金オプションと同じ倒し方）。
 */
export async function resolveAdsOptionEnabled(
  ownerUid: string,
): Promise<boolean> {
  const organizer = await findOrganizerByOwnerUid(ownerUid);
  return organizer?.adsOptionEnabled === true;
}

// ─── 純粋関数: 掲載可否と公開一覧の選定 ───

/** 広告の契約状態（トップ掲載と同じ値域）。 */
export type AdPlacementStatus =
  | 'active' // 支払い済み・掲載可
  | 'past_due' // 支払い失敗・Stripe のリトライ中（掲載は継続）
  | 'canceled' // 解約済み
  | 'unpaid'; // 未払い確定（または Checkout 発行済みで未払い）

export function parseAdPlacementStatus(value: unknown): AdPlacementStatus {
  return value === 'active' || value === 'past_due' || value === 'canceled'
    ? value
    : 'unpaid';
}

/** 契約状態が「掲載可」かどうか（トップ掲載の掲載判定と同じ）。 */
export function isAdSubscribedForStatus(status: AdPlacementStatus): boolean {
  return status === 'active' || status === 'past_due';
}

/**
 * その店の広告を公開してよいかどうか（純粋関数）。
 * - 広告が無効、または料金が未設定なら出さない。
 * - 料金 0（無料）の間は課金を一切見ない（承認だけでよい）。
 * - 有料の間は契約状態が active / past_due の店だけ。
 */
export function isAdEligible(input: {
  adsEnabled: boolean;
  adsPrice: number | null;
  subscriptionStatus: AdPlacementStatus | null;
}): boolean {
  if (!input.adsEnabled) return false;
  if (input.adsPrice === null) return false;
  if (input.adsPrice === 0) return true;
  if (!input.subscriptionStatus) return false;
  return isAdSubscribedForStatus(input.subscriptionStatus);
}

/** 特設サイトに返す広告1件。 */
export interface PublicAd {
  exhibitorId: string;
  shopName: string;
  /** 協賛（広告専用アカウント）の広告かどうか。特設サイトで「協賛」と出す用 */
  isSponsor: boolean;
  imageUrl: string | null;
  title: string;
  text: string;
  linkUrl: string | null;
}

export interface PublicAdCandidate {
  exhibitorId: string;
  shopName: string;
  /** 協賛（広告専用アカウント）かどうか */
  isSponsor: boolean;
  ad: ShopAd;
  /** 公開一覧に載る店かどうか（掲載設定 かつ 課金停止でない） */
  listed: boolean;
  subscriptionStatus: AdPlacementStatus | null;
}

/**
 * 公開する広告を選ぶ（純粋関数）。
 * 掲載版（live）があり、店が公開対象で、掲載可否を通ったものだけを、
 * 承認が早い順に枠数まで返す。
 */
export function selectPublicAds(
  candidates: PublicAdCandidate[],
  event: Pick<EventConfig, 'adsEnabled' | 'adsPrice' | 'adsSlots'>,
): PublicAd[] {
  if (!event.adsEnabled) return [];
  return candidates
    .filter(
      (candidate) =>
        candidate.listed &&
        candidate.ad.live !== null &&
        isAdEligible({
          adsEnabled: event.adsEnabled,
          adsPrice: event.adsPrice,
          subscriptionStatus: candidate.subscriptionStatus,
        }),
    )
    .sort((a, b) => {
      const aAt = a.ad.approvedAt ?? '';
      const bAt = b.ad.approvedAt ?? '';
      if (aAt !== bAt) return aAt.localeCompare(bAt);
      return a.exhibitorId.localeCompare(b.exhibitorId);
    })
    .slice(0, Math.max(event.adsSlots, 0))
    .map((candidate) => ({
      exhibitorId: candidate.exhibitorId,
      shopName: candidate.shopName,
      isSponsor: candidate.isSponsor,
      imageUrl: candidate.ad.live!.imageUrl,
      title: candidate.ad.live!.title,
      text: candidate.ad.live!.text,
      linkUrl: candidate.ad.live!.linkUrl,
    }));
}

/** 広告画像の保存先パス（店舗写真と同じ公開読み取りの範囲に置く）。 */
export function shopAdPhotoStoragePath(
  eventId: string,
  exhibitorId: string,
  fileName: string,
): string {
  return `events/${eventId}/shop-photos/${exhibitorId}/ad-${fileName}`;
}

// ─── Firestore: 広告の内容と承認 ───

function exhibitorRef(db: Firestore, eventId: string, exhibitorId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId);
}

/** 自店の広告状態（未設定なら空の状態）。 */
export async function getShopAd(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<ShopAd> {
  const snap = await exhibitorRef(db, eventId, exhibitorId).get();
  return parseShopAd(snap.data()?.ad);
}

export type SubmitShopAdResult =
  | { ok: true; ad: ShopAd }
  | { ok: false; status: number; error: string };

/** 店の保存（申請）。pending だけが差し替わり、live は変わらない。 */
export async function submitShopAd(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  content: ShopAdContent,
): Promise<SubmitShopAdResult> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'お店が見つかりません' };
  }
  const next = submitAdTransition(
    parseShopAd(snap.data()?.ad),
    content,
    new Date().toISOString(),
  );
  await ref.update({ ad: next });
  return { ok: true, ad: next };
}

export type ReviewShopAdResult =
  | { ok: true; ad: ShopAd }
  | { ok: false; status: number; error: string };

/** 主催者の承認。申請中が無ければ 409。 */
export async function approveShopAd(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<ReviewShopAdResult> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'お店が見つかりません' };
  }
  const next = approveAdTransition(
    parseShopAd(snap.data()?.ad),
    new Date().toISOString(),
  );
  if (!next) {
    return { ok: false, status: 409, error: '承認待ちの広告がありません' };
  }
  await ref.update({ ad: next });
  return { ok: true, ad: next };
}

/** 主催者の却下。申請中が無ければ 409。掲載版はそのまま残る。 */
export async function rejectShopAd(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<ReviewShopAdResult> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'お店が見つかりません' };
  }
  const next = rejectAdTransition(
    parseShopAd(snap.data()?.ad),
    new Date().toISOString(),
  );
  if (!next) {
    return { ok: false, status: 409, error: '承認待ちの広告がありません' };
  }
  await ref.update({ ad: next });
  return { ok: true, ad: next };
}

export interface AdminAdEntry {
  exhibitorId: string;
  shopName: string;
  /** アカウントの種類（参加店／協賛）。承認キューの出し分け表示用 */
  kind: ExhibitorKind;
  ad: ShopAd;
}

/**
 * 管理画面用: 広告を持つ店の一覧。
 * 申請中（古い順）を先に、次に掲載中、最後にそれ以外を並べる。
 */
export async function listAdsForAdmin(
  db: Firestore,
  eventId: string,
): Promise<AdminAdEntry[]> {
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .get();
  const entries: AdminAdEntry[] = [];
  for (const doc of snap.docs) {
    const ad = parseShopAd(doc.data().ad);
    if (!ad.live && !ad.pending) continue;
    const profile = parseShopProfile(doc.data().profile);
    const kind = parseExhibitorKind(doc.data().kind);
    entries.push({
      exhibitorId: doc.id,
      shopName:
        kind === 'advertiser'
          ? String(doc.data().name ?? '')
          : profile.displayName || String(doc.data().name ?? ''),
      kind,
      ad,
    });
  }
  const rank = (entry: AdminAdEntry): number =>
    entry.ad.pending ? 0 : entry.ad.live ? 1 : 2;
  return entries.sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const aAt = a.ad.pendingSubmittedAt ?? a.ad.approvedAt ?? '';
    const bAt = b.ad.pendingSubmittedAt ?? b.ad.approvedAt ?? '';
    if (aAt !== bAt) return aAt.localeCompare(bAt);
    return a.shopName.localeCompare(b.shopName, 'ja');
  });
}

/**
 * 公開用の広告一覧（特設サイトの広告ページ向け）。
 * 選定は selectPublicAds（承認が早い順に枠数まで）。
 */
export async function listPublicAds(
  db: Firestore,
  eventId: string,
): Promise<PublicAd[]> {
  const event = await getEvent(eventId);
  if (!event || !event.adsEnabled) return [];
  // 広告オプション（主催者の契約）が無効な間は、掲載中の広告が
  // あっても公開しない（データは消さず、表示だけ止める）。
  if (!(await resolveAdsOptionEnabled(event.ownerUid))) return [];
  const [exhibitorsSnap, placementsSnap] = await Promise.all([
    db
      .collection('events')
      .doc(eventId)
      .collection(EVENT_EXHIBITORS_COLLECTION)
      .get(),
    db
      .collection('events')
      .doc(eventId)
      .collection(AD_PLACEMENTS_COLLECTION)
      .get(),
  ]);
  const statuses = new Map<string, AdPlacementStatus>();
  for (const doc of placementsSnap.docs) {
    statuses.set(doc.id, parseAdPlacementStatus(doc.data().status));
  }
  const candidates: PublicAdCandidate[] = exhibitorsSnap.docs.map((doc) => {
    const profile = parseShopProfile(doc.data().profile);
    const isSponsor = parseExhibitorKind(doc.data().kind) === 'advertiser';
    return {
      exhibitorId: doc.id,
      // 協賛は店舗プロフィールを持たないため、表示名は登録名を使う
      shopName: isSponsor
        ? String(doc.data().name ?? '')
        : profile.displayName || String(doc.data().name ?? ''),
      isSponsor,
      ad: parseShopAd(doc.data().ad),
      // 協賛は広告のためだけに存在するので、プロフィール掲載設定や
      // 店舗課金の停止では落とさない（承認と広告の契約状態だけで決まる）
      listed: isSponsor
        ? true
        : isShopPubliclyListed(profile, doc.data().billingSuspended),
      subscriptionStatus: statuses.get(doc.id) ?? null,
    };
  });
  return selectPublicAds(candidates, event);
}

// ─── 広告の契約（課金）: トップ掲載（lib/event-placement.ts）の写し ───
//
// 掲載可否の効き方だけがトップ掲載と違う: トップ掲載は参加店
// ドキュメントの topFeatured フラグに非正規化するが、広告は公開時に
// 契約状態を引いて判定する（selectPublicAds）ため、フラグは持たない。

export interface AdPlacement {
  exhibitorId: string;
  status: AdPlacementStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** 申込時点の月額（円）。料金変更後も既存契約はこの金額のまま */
  monthlyAmount: number;
  /** 店に渡す支払いページ（Checkout）の URL。発行時のみ */
  checkoutUrl: string | null;
  checkoutSessionId: string | null;
  updatedAt: string;
}

/**
 * Stripe のサブスクリプション状態 → ローカルの状態。
 * トップ掲載（placementTransitionForSubscriptionStatus）と揃える:
 * - active / trialing: active
 * - past_due / paused: past_due（掲載は継続）
 * - unpaid: unpaid（掲載を止める）
 * - canceled / incomplete_expired: canceled（掲載を止める）
 * - incomplete: 初回支払い未完了。記録は Checkout 発行時点の unpaid の
 *   ままにするため対象外（null）。
 */
export function adTransitionForSubscriptionStatus(
  stripeStatus: unknown,
): { status: AdPlacementStatus } | null {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return { status: 'active' };
    case 'past_due':
    case 'paused':
      return { status: 'past_due' };
    case 'unpaid':
      return { status: 'unpaid' };
    case 'canceled':
    case 'incomplete_expired':
      return { status: 'canceled' };
    case 'incomplete':
      return null;
    default:
      return null;
  }
}

// ─── 純粋関数: Webhook イベントの効果（トップ掲載の写し） ───

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

export interface AdPlacementEffect {
  subscriptionId: string | null;
  customerId: string | null;
  /** Checkout / サブスクリプションの metadata から得た所属（無ければ null） */
  metadataEventId: string | null;
  metadataExhibitorId: string | null;
  placementPatch: {
    status?: AdPlacementStatus;
    stripeSubscriptionId?: string;
    stripeCustomerId?: string;
  };
  payment: BillingPaymentDraft | null;
}

/**
 * 広告宛の Webhook イベントを、ローカル記録への効果に変換する。
 * metadata.kind が 'ad-placement' でないイベントは null
 * （店舗課金・トップ掲載側の処理対象）。振り分け自体は
 * lib/event-placement.ts の stripeEventKind が担う。
 */
export function effectFromStripeEventForAd(
  event: StripeWebhookEventLike,
): AdPlacementEffect | null {
  const object = asRecord(event.data?.object) ?? {};
  const occurredAt = unixToIso(event.created) ?? new Date().toISOString();

  switch (event.type) {
    case 'checkout.session.completed': {
      if (object.mode !== 'subscription') return null;
      const metadata =
        asRecord(object.metadata) ??
        asRecord(asRecord(object.subscription_details)?.metadata);
      if (metadataString(metadata, 'kind') !== AD_PLACEMENT_KIND) return null;
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
        payment: null,
      };
    }
    case 'invoice.paid': {
      const metadata = metadataFromInvoice(object);
      if (metadataString(metadata, 'kind') !== AD_PLACEMENT_KIND) return null;
      return {
        subscriptionId: subscriptionIdFromInvoice(object),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        placementPatch: { status: 'active' },
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
      if (metadataString(metadata, 'kind') !== AD_PLACEMENT_KIND) return null;
      return {
        subscriptionId: subscriptionIdFromInvoice(object),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        // Stripe のリトライを尊重し、掲載はこの時点では止めない。
        placementPatch: { status: 'past_due' },
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
      const metadata = asRecord(object.metadata);
      if (metadataString(metadata, 'kind') !== AD_PLACEMENT_KIND) return null;
      const transition = adTransitionForSubscriptionStatus(object.status);
      if (!transition) return null;
      return {
        subscriptionId: stringOrNull(object.id),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        placementPatch: { status: transition.status },
        payment: null,
      };
    }
    case 'customer.subscription.deleted': {
      const metadata = asRecord(object.metadata);
      if (metadataString(metadata, 'kind') !== AD_PLACEMENT_KIND) return null;
      return {
        subscriptionId: stringOrNull(object.id),
        customerId: customerIdOf(object.customer),
        metadataEventId: metadataString(metadata, 'eventId'),
        metadataExhibitorId: metadataString(metadata, 'exhibitorId'),
        placementPatch: { status: 'canceled' },
        payment: null,
      };
    }
    default:
      return null;
  }
}

// ─── Firestore: 広告の契約レコード ───

function adPlacementRef(db: Firestore, eventId: string, exhibitorId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(AD_PLACEMENTS_COLLECTION)
    .doc(exhibitorId);
}

function adPlacementsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(AD_PLACEMENTS_COLLECTION);
}

function toAdPlacement(
  exhibitorId: string,
  data: FirebaseFirestore.DocumentData,
): AdPlacement {
  return {
    exhibitorId,
    status: parseAdPlacementStatus(data.status),
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

export async function getAdPlacement(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<AdPlacement | null> {
  const snap = await adPlacementRef(db, eventId, exhibitorId).get();
  if (!snap.exists) return null;
  return toAdPlacement(exhibitorId, snap.data()!);
}

async function writeAdPlacement(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  fields: Record<string, unknown>,
): Promise<AdPlacement> {
  await adPlacementRef(db, eventId, exhibitorId).set(
    { ...fields, updatedAt: new Date().toISOString() },
    { merge: true },
  );
  const placement = await getAdPlacement(db, eventId, exhibitorId);
  return placement!;
}

// ─── 購入条件の解決（トップ掲載と同じ） ───

/**
 * 広告の課金レールが使える状態かどうか。店舗課金オプションと
 * 主催者自身の Stripe を共用するため、条件はトップ掲載と同一
 * （契約者レコードがあり、オプション ON で、Stripe 設定済み）。
 * 料金 0 のプロジェクトではそもそも呼ばれない（課金不要）。
 */
export interface AdAvailability {
  available: boolean;
  organizer: Organizer | null;
  stripeConfigured: boolean;
}

export async function resolveAdAvailability(
  db: Firestore,
  ownerUid: string,
): Promise<AdAvailability> {
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

export interface StartAdPlacementInput {
  contractId: string;
  eventId: string;
  exhibitorId: string;
  exhibitorName: string;
  monthlyAmount: number;
}

export type StartAdPlacementResult =
  | { ok: true; placement: AdPlacement; checkoutUrl: string }
  | { ok: false; status: number; error: string };

/**
 * 広告の申込を始める: Stripe 顧客（無ければ作成）＋金額を直接指定
 * して Checkout セッション（subscription モード）を発行する。
 * 店舗課金・トップ掲載との区別は metadata.kind = 'ad-placement'。
 * 支払い完了後の戻り先は店舗ページ。料金は申込時点で固定される。
 */
export async function startAdPlacement(
  db: Firestore,
  input: StartAdPlacementInput,
): Promise<StartAdPlacementResult> {
  const settings = await getStripeBillingSettings(db, input.contractId);
  if (!settings) {
    return {
      ok: false,
      status: 400,
      error: 'Stripe設定が未完了のため、現在お申し込みできません',
    };
  }
  const stripe = createStripeClient(settings.secretKey);
  const existing = await getAdPlacement(db, input.eventId, input.exhibitorId);

  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: input.exhibitorName,
      metadata: {
        kind: AD_PLACEMENT_KIND,
        contractId: input.contractId,
        eventId: input.eventId,
        exhibitorId: input.exhibitorId,
      },
    });
    customerId = customer.id;
  }

  const metadata = {
    kind: AD_PLACEMENT_KIND,
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
          product_data: { name: 'Push-taro.スタンプラリー 特設サイト 広告掲載' },
        },
      },
    ],
    metadata,
    subscription_data: { metadata },
    success_url: `${origin}/e/${input.eventId}/shop?ad=success`,
    cancel_url: `${origin}/e/${input.eventId}/shop?ad=canceled`,
  });
  if (!session.url) {
    return {
      ok: false,
      status: 502,
      error: '支払いページの発行に失敗しました',
    };
  }

  const placement = await writeAdPlacement(db, input.eventId, input.exhibitorId, {
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

export type CancelAdPlacementResult =
  | { ok: true; placement: AdPlacement }
  | { ok: false; status: number; error: string };

/**
 * 広告の契約を解約する（トップ掲載の解約と同じ作法: Stripe 側を
 * 即時解約し、ローカル記録もその場で止める。掲載は公開判定が契約
 * 状態を見るため、解約と同時に止まる）。
 */
export async function cancelAdPlacement(
  db: Firestore,
  contractId: string,
  eventId: string,
  exhibitorId: string,
): Promise<CancelAdPlacementResult> {
  const existing = await getAdPlacement(db, eventId, exhibitorId);
  if (!existing) {
    return { ok: false, status: 404, error: '広告の契約が見つかりません' };
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

  const placement = await writeAdPlacement(db, eventId, exhibitorId, {
    status: 'canceled',
    checkoutUrl: null,
    checkoutSessionId: null,
  });
  return { ok: true, placement };
}

// ─── Webhook の適用 ───

async function findAdPlacementByStripeIds(
  db: Firestore,
  eventIds: string[],
  ids: { subscriptionId: string | null; customerId: string | null },
): Promise<{ eventId: string; placement: AdPlacement } | null> {
  for (const eventId of eventIds) {
    if (ids.subscriptionId) {
      const snap = await adPlacementsRef(db, eventId)
        .where('stripeSubscriptionId', '==', ids.subscriptionId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return {
          eventId,
          placement: toAdPlacement(snap.docs[0].id, snap.docs[0].data()),
        };
      }
    }
    if (ids.customerId) {
      const snap = await adPlacementsRef(db, eventId)
        .where('stripeCustomerId', '==', ids.customerId)
        .limit(1)
        .get();
      if (!snap.empty) {
        return {
          eventId,
          placement: toAdPlacement(snap.docs[0].id, snap.docs[0].data()),
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

export interface ApplyAdWebhookResult {
  applied: boolean;
  duplicate: boolean;
}

/**
 * 広告宛の Webhook イベントをローカル記録へ反映する。
 * トップ掲載の applyTopPlacementWebhookEffect と同じ作法:
 * 対象の特定は metadata の所属を優先し、無ければ契約者の全
 * プロジェクトから Stripe の顧客／サブスクリプション ID で引く。
 * 支払い記録は共用の billingPayments に kind を付けて記録する
 * （ドキュメントID = Stripe イベントID の create で冪等化）。
 */
export async function applyAdWebhookEffect(
  db: Firestore,
  contractId: string,
  event: StripeWebhookEventLike,
): Promise<ApplyAdWebhookResult> {
  const effect = effectFromStripeEventForAd(event);
  if (!effect) return { applied: false, duplicate: false };
  const occurredAt = unixToIso(event.created) ?? new Date().toISOString();

  let target: { eventId: string; placement: AdPlacement } | null = null;
  if (effect.metadataEventId && effect.metadataExhibitorId) {
    const placement = await getAdPlacement(
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
      const found = await findAdPlacementByStripeIds(
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
        kind: AD_PLACEMENT_KIND,
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

  await writeAdPlacement(db, eventId, exhibitorId, {
    ...effect.placementPatch,
  });
  return { applied: true, duplicate: false };
}
