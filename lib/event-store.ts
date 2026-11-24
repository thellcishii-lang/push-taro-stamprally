// lib/event-store.ts
// イベント設定の Firestore 読み書き層（Admin SDK）。
// データ配置: events/{eventId} にイベント設定を持ち、
// 購読者・クーポン等は events/{eventId} 配下のサブコレクションに置く
// （イベント単位で名前空間を分け、障害や削除が他イベントに波及しないようにする）。
import { FieldValue } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { db } from './firebase-admin';
import { DEFAULT_LOCALE, isLocale, normalizeLocale } from './i18n';
import {
  CreateEventInput,
  DEFAULT_BACKUP_RETENTION_DAYS,
  DEFAULT_RESET_MODE,
  DEFAULT_RESET_TIME,
  DEFAULT_SUBSCRIBER_CAP,
  EventConfig,
  MAX_COUPONS_PER_EVENT,
  isValidResetTime,
  DEFAULT_RANKING_MIN_REVIEWS,
  DEFAULT_STAMP_GOAL_COUNT,
  EVENT_SUBCOLLECTIONS,
  isValidRankingMinReviews,
  isValidStampGoalCount,
  normalizeEventLinks,
  normalizeReviewCategories,
  normalizeStampBenefitText,
  normalizeStampRewardType,
  normalizeTopPlacementEnabled,
  normalizeTopPlacementPrice,
  parseEventLinks,
  parseRankingMinReviews,
  parseReviewCategories,
  parseStampBenefitText,
  parseStampGoalCount,
  parseStampRewardType,
  parseTopPlacementEnabled,
  parseTopPlacementPrice,
  receivesCapsPropagation,
  validateStampRewardSettings,
  DEFAULT_AD_SLOTS,
  DEFAULT_LOGIN_BONUS_DAYS,
  isValidAdsSlots,
  isValidCouponIssuePrice,
  isValidLoginBonusDays,
  isValidPushPrice,
  isValidShopMonthlyPrice,
  normalizeAdsEnabled,
  normalizeAdsPrice,
  normalizeAdsSlots,
  normalizeCouponIssuePrice,
  normalizeLoginBonusEnabled,
  normalizePushPrice,
  normalizeShopMonthlyPrice,
  parseAdsEnabled,
  parseAdsPrice,
  parseAdsSlots,
  parseCouponIssuePrice,
  parseLoginBonusDays,
  parseLoginBonusEnabled,
  parsePortalEnabled,
  parsePushPrice,
  parseShopMonthlyPrice,
} from './event';
import {
  normalizeGourmetDefinition,
  normalizeHeroImageUrl,
  normalizeSiteDescription,
  normalizeSiteIconUrl,
  normalizeSiteNotes,
  normalizeThemeColor,
  parseSiteSettings,
} from './event-site';

const EVENTS_COLLECTION = 'events';

type EventDocData = Omit<EventConfig, 'id' | 'createdAt' | 'updatedAt'> & {
  createdAt?: FirebaseFirestore.Timestamp;
  updatedAt?: FirebaseFirestore.Timestamp;
};

function toEventConfig(id: string, data: FirebaseFirestore.DocumentData): EventConfig {
  return {
    id,
    name: data.name,
    ownerUid: data.ownerUid,
    startDate: data.startDate,
    endDate: data.endDate,
    resetMode: data.resetMode,
    resetTime: data.resetTime,
    subscriberCap: data.subscriberCap,
    defaultLocale: normalizeLocale(data.defaultLocale),
    // 入場用QRは既定オフ。導入前に作られたイベントには項目自体が無い
    admissionQrEnabled: data.admissionQrEnabled === true,
    // ポータル（特設サイト本契約）も既定オフ（アプリ単独）に倒す
    portalEnabled: parsePortalEnabled(data.portalEnabled),
    // スタンプ達成個数も導入前のイベントには項目が無いため既定値に倒す
    stampGoalCount: parseStampGoalCount(data.stampGoalCount),
    // 達成特典の種類・内容も同様に既定値（従来の「1軒無料」・空）に倒す
    stampRewardType: parseStampRewardType(data.stampRewardType),
    stampBenefitText: parseStampBenefitText(data.stampBenefitText),
    // ランキングの最低レビュー件数も同様に既定値に倒す
    rankingMinReviews: parseRankingMinReviews(data.rankingMinReviews),
    // レビューの項目別評価の項目も同様に既定値（従来の4項目）に倒す
    reviewCategories: parseReviewCategories(data.reviewCategories),
    // 主催者リンクは導入前のイベントには項目自体が無い
    links: parseEventLinks(data.links),
    // 特設サイトの表示内容も導入前のイベントには項目自体が無いため既定値に倒す
    ...parseSiteSettings(data),
    // トップ掲載の設定も導入前のイベントには項目が無いため既定値に倒す
    topPlacementEnabled: parseTopPlacementEnabled(data.topPlacementEnabled),
    topPlacementPrice: parseTopPlacementPrice(data.topPlacementPrice),
    // ログインボーナス・広告の設定も同様に既定値（オフ・既定日数/枠数・未設定）に倒す
    loginBonusEnabled: parseLoginBonusEnabled(data.loginBonusEnabled),
    loginBonusDays: parseLoginBonusDays(data.loginBonusDays),
    adsEnabled: parseAdsEnabled(data.adsEnabled),
    adsSlots: parseAdsSlots(data.adsSlots),
    adsPrice: parseAdsPrice(data.adsPrice),
    // 店舗のクーポン発行・プッシュ申請の手数料も同様に未設定（無料）に倒す
    couponIssuePrice: parseCouponIssuePrice(data.couponIssuePrice),
    pushPrice: parsePushPrice(data.pushPrice),
    // 自己登録の月額料金も同様に未設定（受け付けない）に倒す
    shopMonthlyPrice: parseShopMonthlyPrice(data.shopMonthlyPrice),
    couponCap: data.couponCap ?? MAX_COUPONS_PER_EVENT,
    backupRetentionDays: data.backupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
    status: data.status,
    lastResetDate: data.lastResetDate ?? null,
    finalizedAt: data.finalizedAt ?? null,
    createdAt: data.createdAt?.toDate?.().toISOString() ?? '',
    updatedAt: data.updatedAt?.toDate?.().toISOString() ?? '',
  };
}

export async function createEvent(input: CreateEventInput): Promise<EventConfig> {
  if (input.endDate < input.startDate) {
    throw new Error('終了日は開始日以降を指定してください');
  }
  const resetTime = input.resetTime ?? DEFAULT_RESET_TIME;
  if (!isValidResetTime(resetTime)) {
    throw new Error('リセット時刻の形式が不正です（HH:MM）');
  }
  if (input.defaultLocale !== undefined && !isLocale(input.defaultLocale)) {
    throw new Error('対応していない言語です（ja / en / zh / ko）');
  }
  if (
    input.stampGoalCount !== undefined &&
    !isValidStampGoalCount(input.stampGoalCount)
  ) {
    throw new Error('スタンプの達成個数は1〜10の整数で指定してください');
  }
  if (
    input.rankingMinReviews !== undefined &&
    !isValidRankingMinReviews(input.rankingMinReviews)
  ) {
    throw new Error('ランキングの最低レビュー件数は1〜20の整数で指定してください');
  }
  if (
    input.loginBonusDays !== undefined &&
    !isValidLoginBonusDays(input.loginBonusDays)
  ) {
    throw new Error('ログインボーナスの達成日数は5〜20の整数で指定してください');
  }
  if (input.adsSlots !== undefined && !isValidAdsSlots(input.adsSlots)) {
    throw new Error('広告の枠数は1〜50の整数で指定してください');
  }
  if (
    input.couponIssuePrice !== undefined &&
    input.couponIssuePrice !== null &&
    !isValidCouponIssuePrice(input.couponIssuePrice)
  ) {
    throw new Error('クーポン発行の料金は0〜1,000,000円の整数で指定してください');
  }
  if (
    input.pushPrice !== undefined &&
    input.pushPrice !== null &&
    !isValidPushPrice(input.pushPrice)
  ) {
    throw new Error('プッシュ配信の料金は0〜1,000,000円の整数で指定してください');
  }
  if (
    input.shopMonthlyPrice !== undefined &&
    input.shopMonthlyPrice !== null &&
    !isValidShopMonthlyPrice(input.shopMonthlyPrice)
  ) {
    throw new Error('参加店の月額料金は0〜1,000,000円の整数で指定してください');
  }
  // 達成特典は種類と内容を正規化し、組み合わせ（benefit なら内容必須）まで検証する
  const stampRewardType = normalizeStampRewardType(input.stampRewardType);
  const stampBenefitText = normalizeStampBenefitText(input.stampBenefitText);
  validateStampRewardSettings(stampRewardType, stampBenefitText);

  const ref = db.collection(EVENTS_COLLECTION).doc();
  const data: EventDocData = {
    name: input.name,
    ownerUid: input.ownerUid,
    startDate: input.startDate,
    endDate: input.endDate,
    resetMode: input.resetMode ?? DEFAULT_RESET_MODE,
    resetTime,
    subscriberCap: input.subscriberCap ?? DEFAULT_SUBSCRIBER_CAP,
    defaultLocale: input.defaultLocale ?? DEFAULT_LOCALE,
    admissionQrEnabled: input.admissionQrEnabled ?? false,
    // ポータルは契約（主催者レコード）からの継承。未指定はアプリ単独。
    // 契約後の ON/OFF はプロビジョニングの伝播で追随する
    portalEnabled: input.portalEnabled === true,
    stampGoalCount: input.stampGoalCount ?? DEFAULT_STAMP_GOAL_COUNT,
    stampRewardType,
    stampBenefitText,
    rankingMinReviews: input.rankingMinReviews ?? DEFAULT_RANKING_MIN_REVIEWS,
    reviewCategories: normalizeReviewCategories(input.reviewCategories),
    links: normalizeEventLinks(input.links),
    // 特設サイトの表示内容は作成時点では未設定（編集画面で後から設定する）
    siteDescription: '',
    gourmetDefinition: '',
    heroImageUrl: null,
    siteIconUrl: null,
    themeColor: null,
    siteNotes: [],
    // トップ掲載も作成時点では無効・料金未設定（特設サイト編集画面で設定する）
    topPlacementEnabled: false,
    topPlacementPrice: null,
    // ログインボーナス・広告も作成時点では無効（設定画面で後から有効化する）
    loginBonusEnabled: input.loginBonusEnabled ?? false,
    loginBonusDays: input.loginBonusDays ?? DEFAULT_LOGIN_BONUS_DAYS,
    adsEnabled: false,
    adsSlots: DEFAULT_AD_SLOTS,
    adsPrice: null,
    // 店舗のクーポン発行・プッシュ申請の手数料は未設定（無料）で始める
    couponIssuePrice: input.couponIssuePrice ?? null,
    pushPrice: input.pushPrice ?? null,
    // 自己登録の月額料金は未設定（受け付けない）で始める
    shopMonthlyPrice: input.shopMonthlyPrice ?? null,
    couponCap: input.couponCap ?? MAX_COUPONS_PER_EVENT,
    backupRetentionDays:
      input.backupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS,
    status: input.status ?? 'draft',
    lastResetDate: null,
    finalizedAt: null,
  };
  await ref.set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const created = await getEvent(ref.id);
  if (!created) throw new Error('イベントの作成に失敗しました');
  return created;
}

export async function getEvent(eventId: string): Promise<EventConfig | null> {
  const snap = await db.collection(EVENTS_COLLECTION).doc(eventId).get();
  if (!snap.exists) return null;
  return toEventConfig(snap.id, snap.data()!);
}

export async function listEventsByOwner(ownerUid: string): Promise<EventConfig[]> {
  const snap = await db
    .collection(EVENTS_COLLECTION)
    .where('ownerUid', '==', ownerUid)
    .get();
  return snap.docs
    .map((doc) => toEventConfig(doc.id, doc.data()))
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export interface EventWithSubscriberCount extends EventConfig {
  subscriberCount: number;
}

/** イベントの現在の購読者数（集計クエリなので大きなコレクションでも軽い）。 */
export async function countEventSubscribers(eventId: string): Promise<number> {
  const snap = await db
    .collection(EVENTS_COLLECTION)
    .doc(eventId)
    .collection(EVENT_SUBCOLLECTIONS.subscribers)
    .count()
    .get();
  return snap.data().count;
}

/**
 * 主催者のイベント一覧に現在の購読者数を付ける（一覧カード表示用）。
 * 数えられないイベントがあっても一覧自体は出す（そのイベントは 0 として扱う）。
 */
export async function listEventsByOwnerWithSubscriberCounts(
  ownerUid: string,
): Promise<EventWithSubscriberCount[]> {
  const events = await listEventsByOwner(ownerUid);
  return Promise.all(
    events.map(async (event) => ({
      ...event,
      subscriberCount: await countEventSubscribers(event.id).catch(() => 0),
    })),
  );
}

/** スケジューラが「開催中イベント」を拾うための一覧。件数は最大でも数十件想定。 */
export async function listLiveEvents(): Promise<EventConfig[]> {
  const snap = await db
    .collection(EVENTS_COLLECTION)
    .where('status', '==', 'live')
    .get();
  return snap.docs.map((doc) => toEventConfig(doc.id, doc.data()));
}

/** 終了処理の候補（未 finalized の全イベント）。due 判定は isFinalizationDue で行う。 */
export async function listUnfinalizedEvents(): Promise<EventConfig[]> {
  const snap = await db
    .collection(EVENTS_COLLECTION)
    .where('finalizedAt', '==', null)
    .get();
  return snap.docs.map((doc) => toEventConfig(doc.id, doc.data()));
}

/** Firestore のバッチ上限（500）に対する安全側のチャンクサイズ。event-reset.ts と同じ値。 */
const UPDATE_CHUNK_SIZE = 450;

export interface CapsPropagationResult {
  /** 枠を反映できたイベントID */
  updatedEventIds: string[];
  /** 反映に失敗したイベントと理由（1件の失敗で全体は止めない） */
  failed: { eventId: string; error: string }[];
}

/**
 * 契約枠の変更を、その主催者の「終わっていない」イベント
 * （下書き・開催中。receivesCapsPropagation 参照）へ伝播する。
 *
 * 冪等: 同じ枠の再送でも結果は同じ（絶対値で上書きする）。
 * 失敗の局所化: チャンク（450件）単位のバッチで書き、チャンクが
 * 失敗したら1件ずつに落として失敗したイベントだけを結果に集める。
 * 呼び出し側は failed を見て記録すればよく、この関数自体は
 * 個別イベントの失敗では throw しない。
 */
export async function propagateCapsToOwnerEvents(
  ownerUid: string,
  caps: { subscriberCap?: number; couponCap?: number },
): Promise<CapsPropagationResult> {
  const patch: { subscriberCap?: number; couponCap?: number } = {};
  if (caps.subscriberCap !== undefined) patch.subscriberCap = caps.subscriberCap;
  if (caps.couponCap !== undefined) patch.couponCap = caps.couponCap;

  const result: CapsPropagationResult = { updatedEventIds: [], failed: [] };
  if (Object.keys(patch).length === 0) return result;

  const events = await listEventsByOwner(ownerUid);
  const targets = events.filter(receivesCapsPropagation);

  for (let i = 0; i < targets.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = targets.slice(i, i + UPDATE_CHUNK_SIZE);
    try {
      const batch = db.batch();
      for (const event of chunk) {
        batch.update(db.collection(EVENTS_COLLECTION).doc(event.id), {
          ...patch,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      result.updatedEventIds.push(...chunk.map((event) => event.id));
    } catch {
      // チャンク単位で失敗したら1件ずつに落として、失敗を局所化する。
      for (const event of chunk) {
        try {
          await updateEvent(event.id, patch);
          result.updatedEventIds.push(event.id);
        } catch (error) {
          result.failed.push({
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  return result;
}

/**
 * ポータル（特設サイト本契約）の ON/OFF を、その主催者の
 * 「終わっていない」イベントへ伝播する。枠の伝播と同じ作法
 * （冪等・失敗の局所化・個別失敗では throw しない）。
 * ポータルの接続/解約でクーポン・特典の管理場所が切り替わるため、
 * 契約レコードだけでなくイベント側の値も追随させる必要がある。
 */
export async function propagatePortalEnabledToOwnerEvents(
  ownerUid: string,
  portalEnabled: boolean,
): Promise<CapsPropagationResult> {
  const result: CapsPropagationResult = { updatedEventIds: [], failed: [] };

  const events = await listEventsByOwner(ownerUid);
  const targets = events.filter(receivesCapsPropagation);

  for (let i = 0; i < targets.length; i += UPDATE_CHUNK_SIZE) {
    const chunk = targets.slice(i, i + UPDATE_CHUNK_SIZE);
    try {
      const batch = db.batch();
      for (const event of chunk) {
        batch.update(db.collection(EVENTS_COLLECTION).doc(event.id), {
          portalEnabled,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
      result.updatedEventIds.push(...chunk.map((event) => event.id));
    } catch {
      for (const event of chunk) {
        try {
          await updateEvent(event.id, { portalEnabled });
          result.updatedEventIds.push(event.id);
        } catch (error) {
          result.failed.push({
            eventId: event.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
  return result;
}

export type UpdateEventInput = Partial<
  Pick<
    EventConfig,
    | 'name'
    | 'startDate'
    | 'endDate'
    | 'resetMode'
    | 'resetTime'
    | 'subscriberCap'
    | 'defaultLocale'
    | 'admissionQrEnabled'
    | 'portalEnabled'
    | 'stampGoalCount'
    | 'stampRewardType'
    | 'stampBenefitText'
    | 'rankingMinReviews'
    | 'reviewCategories'
    | 'links'
    | 'siteDescription'
    | 'gourmetDefinition'
    | 'heroImageUrl'
    | 'siteIconUrl'
    | 'themeColor'
    | 'siteNotes'
    | 'topPlacementEnabled'
    | 'topPlacementPrice'
    | 'loginBonusEnabled'
    | 'loginBonusDays'
    | 'adsEnabled'
    | 'adsSlots'
    | 'adsPrice'
    | 'couponIssuePrice'
    | 'pushPrice'
    | 'shopMonthlyPrice'
    | 'couponCap'
    | 'backupRetentionDays'
    | 'status'
    | 'lastResetDate'
    | 'finalizedAt'
  >
>;

export async function updateEvent(
  eventId: string,
  patch: UpdateEventInput,
): Promise<void> {
  if (patch.resetTime !== undefined && !isValidResetTime(patch.resetTime)) {
    throw new Error('リセット時刻の形式が不正です（HH:MM）');
  }
  if (patch.defaultLocale !== undefined && !isLocale(patch.defaultLocale)) {
    throw new Error('対応していない言語です（ja / en / zh / ko）');
  }
  if (
    patch.admissionQrEnabled !== undefined &&
    typeof patch.admissionQrEnabled !== 'boolean'
  ) {
    throw new Error('入場用QR設定の形式が不正です');
  }
  if (
    patch.stampGoalCount !== undefined &&
    !isValidStampGoalCount(patch.stampGoalCount)
  ) {
    throw new Error('スタンプの達成個数は1〜10の整数で指定してください');
  }
  if (
    patch.rankingMinReviews !== undefined &&
    !isValidRankingMinReviews(patch.rankingMinReviews)
  ) {
    throw new Error('ランキングの最低レビュー件数は1〜20の整数で指定してください');
  }
  // 達成特典は種類と内容を正規化する。組み合わせ（benefit なら内容必須）は
  // 片方だけの更新でも保存済みのもう片方と突き合わせて検証する。
  const stampRewardType =
    patch.stampRewardType !== undefined
      ? normalizeStampRewardType(patch.stampRewardType)
      : undefined;
  const stampBenefitText =
    patch.stampBenefitText !== undefined
      ? normalizeStampBenefitText(patch.stampBenefitText)
      : undefined;
  if (stampRewardType !== undefined || stampBenefitText !== undefined) {
    let mergedType = stampRewardType;
    let mergedText = stampBenefitText;
    if (mergedType === undefined || mergedText === undefined) {
      const current = await getEvent(eventId);
      if (!current) throw new Error('イベントが見つかりません');
      mergedType = mergedType ?? current.stampRewardType;
      mergedText = mergedText ?? current.stampBenefitText;
    }
    validateStampRewardSettings(mergedType, mergedText);
  }
  // レビューの項目別評価の項目は検証・正規化してから保存する
  const reviewCategories =
    patch.reviewCategories !== undefined
      ? normalizeReviewCategories(patch.reviewCategories)
      : undefined;
  // 主催者リンクは検証してから正規化した形で保存する
  const links =
    patch.links !== undefined ? normalizeEventLinks(patch.links) : undefined;
  // 特設サイトの表示内容も検証・正規化してから保存する
  const siteDescription =
    patch.siteDescription !== undefined
      ? normalizeSiteDescription(patch.siteDescription)
      : undefined;
  const gourmetDefinition =
    patch.gourmetDefinition !== undefined
      ? normalizeGourmetDefinition(patch.gourmetDefinition)
      : undefined;
  const heroImageUrl =
    patch.heroImageUrl !== undefined
      ? normalizeHeroImageUrl(patch.heroImageUrl)
      : undefined;
  const siteIconUrl =
    patch.siteIconUrl !== undefined
      ? normalizeSiteIconUrl(patch.siteIconUrl)
      : undefined;
  const themeColor =
    patch.themeColor !== undefined
      ? normalizeThemeColor(patch.themeColor)
      : undefined;
  const siteNotes =
    patch.siteNotes !== undefined
      ? normalizeSiteNotes(patch.siteNotes)
      : undefined;
  // トップ掲載の設定も検証・正規化してから保存する
  const topPlacementEnabled =
    patch.topPlacementEnabled !== undefined
      ? normalizeTopPlacementEnabled(patch.topPlacementEnabled)
      : undefined;
  const topPlacementPrice =
    patch.topPlacementPrice !== undefined
      ? normalizeTopPlacementPrice(patch.topPlacementPrice)
      : undefined;
  // ログインボーナス・広告の設定も検証・正規化してから保存する
  if (
    patch.loginBonusDays !== undefined &&
    !isValidLoginBonusDays(patch.loginBonusDays)
  ) {
    throw new Error('ログインボーナスの達成日数は5〜20の整数で指定してください');
  }
  const loginBonusEnabled =
    patch.loginBonusEnabled !== undefined
      ? normalizeLoginBonusEnabled(patch.loginBonusEnabled)
      : undefined;
  if (patch.adsSlots !== undefined && !isValidAdsSlots(patch.adsSlots)) {
    throw new Error('広告の枠数は1〜50の整数で指定してください');
  }
  const adsEnabled =
    patch.adsEnabled !== undefined
      ? normalizeAdsEnabled(patch.adsEnabled)
      : undefined;
  const adsSlots =
    patch.adsSlots !== undefined
      ? normalizeAdsSlots(patch.adsSlots)
      : undefined;
  const adsPrice =
    patch.adsPrice !== undefined ? normalizeAdsPrice(patch.adsPrice) : undefined;
  // 店舗のクーポン発行・プッシュ申請の手数料も検証・正規化してから保存する
  const couponIssuePrice =
    patch.couponIssuePrice !== undefined
      ? normalizeCouponIssuePrice(patch.couponIssuePrice)
      : undefined;
  const pushPrice =
    patch.pushPrice !== undefined
      ? normalizePushPrice(patch.pushPrice)
      : undefined;
  const shopMonthlyPrice =
    patch.shopMonthlyPrice !== undefined
      ? normalizeShopMonthlyPrice(patch.shopMonthlyPrice)
      : undefined;
  if (
    patch.startDate !== undefined &&
    patch.endDate !== undefined &&
    patch.endDate < patch.startDate
  ) {
    throw new Error('終了日は開始日以降を指定してください');
  }
  await db
    .collection(EVENTS_COLLECTION)
    .doc(eventId)
    .update({
      ...patch,
      ...(stampRewardType !== undefined ? { stampRewardType } : {}),
      ...(stampBenefitText !== undefined ? { stampBenefitText } : {}),
      ...(reviewCategories !== undefined ? { reviewCategories } : {}),
      ...(links !== undefined ? { links } : {}),
      ...(siteDescription !== undefined ? { siteDescription } : {}),
      ...(gourmetDefinition !== undefined ? { gourmetDefinition } : {}),
      ...(heroImageUrl !== undefined ? { heroImageUrl } : {}),
      ...(siteIconUrl !== undefined ? { siteIconUrl } : {}),
      ...(themeColor !== undefined ? { themeColor } : {}),
      ...(siteNotes !== undefined ? { siteNotes } : {}),
      ...(topPlacementEnabled !== undefined ? { topPlacementEnabled } : {}),
      ...(topPlacementPrice !== undefined ? { topPlacementPrice } : {}),
      ...(loginBonusEnabled !== undefined ? { loginBonusEnabled } : {}),
      ...(adsEnabled !== undefined ? { adsEnabled } : {}),
      ...(adsSlots !== undefined ? { adsSlots } : {}),
      ...(adsPrice !== undefined ? { adsPrice } : {}),
      ...(couponIssuePrice !== undefined ? { couponIssuePrice } : {}),
      ...(pushPrice !== undefined ? { pushPrice } : {}),
      ...(shopMonthlyPrice !== undefined ? { shopMonthlyPrice } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** Firestore のバッチ上限（500）に対する安全側のチャンクサイズ。event-reset.ts と同じ値。 */
const DELETE_CHUNK_SIZE = 450;

/** コレクションを先頭からチャンク削除し、空になるまで繰り返す。 */
async function drainCollectionCompletely(
  collectionRef: FirebaseFirestore.CollectionReference,
): Promise<void> {
  for (;;) {
    const snap = await collectionRef.limit(DELETE_CHUNK_SIZE).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    if (snap.size < DELETE_CHUNK_SIZE) return;
  }
}

/**
 * イベントを完全に削除する（主催者の削除操作用）。
 *
 * 対象は events/{eventId} 本体と、その配下の全サブコレクション
 * （subscribers / members / claims / redemptions / exhibitors / coupons /
 * campaigns / dailyStats / infoPdfs など、実在するものを listCollections で拾う）、
 * および Storage 上の実ファイル（現行形式 organizers/{ownerUid}/events/{eventId}/
 * 配下と、移行前の旧形式 events/{eventId}/ 配下の両方）。
 * 最終レポート（event_reports）と運営用バックアップ（event_report_backups）は
 * 別コレクションにあり、ここでは一切触らない。
 *
 * 終了処理（finalization）と違い、こちらはイベントドキュメント自体も消す。
 * 想定する対象は下書きと終了済みで、終了済みは終了処理で主要サブコレクションが
 * 既に消えており、下書きは来場者データを持たないため、一括で消し切れる。
 * 途中で失敗しても、本体を最後に消すため再実行で残りを消せる（冪等）。
 * 削除可否（状態チェック）は呼び出し側で行うこと。
 */
export async function deleteEventCompletely(eventId: string): Promise<void> {
  const ref = db.collection(EVENTS_COLLECTION).doc(eventId);
  // 1. Storage の実ファイル（案内 PDF・宣伝ファイル等）。
  //    保存済みパスは現行形式（organizers/{uid}/events/{eventId}/）と
  //    移行前の旧形式（events/{eventId}/）が混在しうるので両方を消す。
  const bucket = getStorage().bucket();
  await bucket.deleteFiles({ prefix: `events/${eventId}/` });
  const snap = await ref.get();
  const ownerUid = snap.exists ? String(snap.data()?.ownerUid ?? '') : '';
  if (ownerUid) {
    await bucket.deleteFiles({
      prefix: `organizers/${ownerUid}/events/${eventId}/`,
    });
  }
  // 2. サブコレクションをすべてチャンク削除する。
  const collections = await ref.listCollections();
  for (const collection of collections) {
    await drainCollectionCompletely(collection);
  }
  // 3. イベント本体。
  await ref.delete();
}
