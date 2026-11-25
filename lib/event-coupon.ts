// lib/event-coupon.ts
// Push-taro.スタンプラリー のクーポン基盤（events/{eventId} 配下）。
//
// - exhibitors/{exhibitorId}: 出店者（会社）。ログインはイベント専用の
//   アクセスコード方式（lib/exhibitor-access.ts）。ドキュメントにメール
//   アドレスとコードのハッシュ（accessCode フィールド）を持ち、Firebase
//   Auth のアカウントは作らない（Auth は主催者だけ）。
// - coupons/{couponId}: クーポン。必ず所有する出店者（exhibitorId）を持ち、
//   検索・一覧用に出店者名とキーワードを保持する。イベント全体で最大100件。
// - claims/{memberId}_{couponId}: 来場者の取得記録（電話番号キー）。
// - redemptions/{claimId}: 消込記録。
//
// 消込の鉄則: 出店者は自社クーポンしか消込できない。この判定は画面ではなく
// サーバー側（evaluateRedemption / redeemClaim）で必ず行う。
// 主催者（イベント所有者）は管理画面側の消込として全クーポンを消込できる。
import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase-admin';
import { EVENT_SUBCOLLECTIONS, MAX_COUPONS_PER_EVENT } from './event';
import { getEvent } from './event-store';
import { normalizeLocale, parseLocalizedTexts, pickLocalizedText, resolveLocale, type Locale } from './i18n';
import { translateText } from './translate';
import { uiText } from './ui-text';
import { generateStampCode, isValidStampCode } from './stamp-qr';

// exhibitors / coupons はリセット・終了削除の対象外（個人情報を含まない台帳）。
// 削除対象は EVENT_SUBCOLLECTIONS の4つ（subscribers/members/claims/redemptions）。
export const EVENT_EXHIBITORS_COLLECTION = 'exhibitors';
export const EVENT_COUPONS_COLLECTION = 'coupons';

/**
 * アカウントの種類。
 * - 'shop': 参加店（従来の出店者。プロフィール・スタンプ・レビュー・
 *   トップ掲載など、参加店としての全機能の対象）
 * - 'advertiser': 協賛（広告専用）。参加店としては一切現れず、
 *   広告の掲載だけを行う。
 * - 'spot': スポット（チェックポイント専用）。ログイン・アクセス
 *   コード・消込・クーポン発行を持たず、主催者が登録した場所に
 *   置きQRを置いて、お客さんが通過時に自分で読んでスタンプを付ける。
 * 旧ドキュメント（項目なし）は 'shop' として扱う。
 */
export type ExhibitorKind = 'shop' | 'advertiser' | 'spot';

/** 保存済みの種類を防御的に読む（読み取り用）。'advertiser' のみ協賛、'spot' のみスポット。 */
export function parseExhibitorKind(value: unknown): ExhibitorKind {
  if (value === 'advertiser') return 'advertiser';
  if (value === 'spot') return 'spot';
  return 'shop';
}

/**
 * 登録の入口。
 * - 'admin': 主催者が管理画面から発行（従来の入口）
 * - 'self': 店・広告主が公開の申込ページから自分で登録（自己申込）
 * 旧ドキュメント（項目なし）は 'admin' として扱う。
 */
export type ExhibitorSource = 'admin' | 'self';

/** 保存済みの登録入口を防御的に読む（読み取り用）。'self' のみ自己申込。 */
export function parseExhibitorSource(value: unknown): ExhibitorSource {
  return value === 'self' ? 'self' : 'admin';
}

/**
 * チェックポイントのスタンプ認証方法（チェックポイントごとに複数選択可。
 * チェックした方法だけがそのチェックポイントで有効になる）。
 * - 'staff': 店が読む（お店・スタッフがお客さんのQRを読み取る）
 * - 'placed': 置きQR（お客さんが静止QRを読み取る）
 * - 'rotating': 回転QR（お客さんが固定ディスプレイの回転QRを読み取る。
 *   実施は PR-D で、ここでは設定の保存・表示まで）
 */
export type CheckpointStampMethod = 'staff' | 'placed' | 'rotating';

/** 認証方法の全種（表示順・正規化の走査順）。 */
export const CHECKPOINT_STAMP_METHODS: readonly CheckpointStampMethod[] = [
  'staff',
  'placed',
  'rotating',
];

/** チェックポイント番号として有効な値かどうか（1以上の整数）。 */
export function isValidCheckpointNumber(value: unknown): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 1
  );
}

/**
 * 保存済みのチェックポイント番号を防御的に読む（読み取り用）。
 * 未設定・不正な値は null（番号なし）。
 */
export function parseCheckpointNumber(value: unknown): number | null {
  return isValidCheckpointNumber(value) ? (value as number) : null;
}

/** 種別ごとの認証方法の既定値（項目が無い旧ドキュメント向け）。 */
export function defaultStampMethods(
  kind: ExhibitorKind,
): CheckpointStampMethod[] {
  if (kind === 'spot') return ['placed'];
  if (kind === 'shop') return ['staff'];
  return [];
}

/**
 * 保存済みの認証方法を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧ドキュメントは種別の既定値に倒す。配列があれば
 * 有効な値だけを残す（空配列は「どの方法も無効」として尊重する）。
 */
export function parseStampMethods(
  value: unknown,
  kind: ExhibitorKind,
): CheckpointStampMethod[] {
  if (!Array.isArray(value)) return defaultStampMethods(kind);
  return CHECKPOINT_STAMP_METHODS.filter((method) => value.includes(method));
}

/**
 * 認証方法の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 1つ以上必須（0件ではそのチェックポイントでスタンプが押せなくなる）。
 */
export function normalizeStampMethods(
  input: unknown,
): CheckpointStampMethod[] {
  if (!Array.isArray(input)) {
    throw new Error('スタンプの認証方法の形式が不正です');
  }
  const methods = CHECKPOINT_STAMP_METHODS.filter((method) =>
    input.includes(method),
  );
  if (methods.length === 0) {
    throw new Error('スタンプの認証方法を1つ以上選んでください');
  }
  return methods;
}

/**
 * チェックポイント番号の重複相手を探す（純粋関数）。
 * 同一イベント内で、閉店扱いでも協賛でもない他のチェックポイントが
 * 同じ番号を持っていれば、その相手を返す。重複が無ければ null。
 */
export function findCheckpointNumberConflict(
  exhibitors: Array<
    Pick<
      EventExhibitor,
      'id' | 'name' | 'kind' | 'closedAt' | 'checkpointNumber'
    >
  >,
  exhibitorId: string,
  checkpointNumber: number,
): Pick<
  EventExhibitor,
  'id' | 'name' | 'kind' | 'closedAt' | 'checkpointNumber'
> | null {
  return (
    exhibitors.find(
      (other) =>
        other.id !== exhibitorId &&
        !other.closedAt &&
        other.kind !== 'advertiser' &&
        other.checkpointNumber === checkpointNumber,
    ) ?? null
  );
}

export interface EventExhibitor {
  id: string;
  name: string;
  /** 消込ログイン用メールアドレス。旧ドキュメント（Auth 方式時代）は null */
  email: string | null;
  /**
   * 登録時に集めた住所（トップレベル・管理用）。店舗課金オプションが
   * 有効な契約での登録時に必須で集める。公開プロフィール
   * （profile.address、店が自分で入れる公開用）とは別物で、
   * 特設サイト等の公開側には出さない。未登録なら null。
   */
  address: string | null;
  /** アクセスコード（画面表記「パスワード」）が発行済みかどうか。
   * ハッシュ自体は API に出さない。 */
  hasAccessCode: boolean;
  /** 表示言語（個人の選択）。未設定ならイベントのデフォルト言語 */
  lang: Locale;
  /** アカウントの種類（参加店／協賛）。旧ドキュメントは 'shop' */
  kind: ExhibitorKind;
  /** 登録の入口（主催者発行／自己申込）。旧ドキュメントは 'admin' */
  source: ExhibitorSource;
  /**
   * 店舗課金の未払い確定で掲載停止になった日時（ISO）。停止中でない
   * （未設定・復旧済み）場合は null。掲載停止から3ヶ月を過ぎると閉店
   * 扱いになり、同じメールでの新規登録（自己申込）が通るようになる
   * （実体は lib/event-apply.ts）。
   */
  delistedAt: string | null;
  /**
   * 閉店扱いになった日時（ISO）。掲載停止から3ヶ月経過後に同じメールで
   * 新規登録された時点で、旧レコードに付けられる。以後の重複判定・
   * ログイン照合では存在しないものとして扱う。未閉店は null。
   */
  closedAt: string | null;
  /**
   * 場所QR（チェックポイントに貼る QR）用のスタンプコード。参加店と
   * スポットだけが持ち、作成時に自動発行される。導入前の旧ドキュメント
   * は null で、主催者コンソールの表示時に遅延発行される
   * （ensureExhibitorStampCode）。協賛アカウントは常に null。
   */
  stampCode: string | null;
  /**
   * チェックポイント番号（任意）。順番モードや特設サイト・参加者画面
   * での表示に使う。同一イベント内で重複は許さない（保存時に検証）。
   * 未設定・旧ドキュメントは null。
   */
  checkpointNumber: number | null;
  /**
   * このチェックポイントで有効なスタンプ認証方法（複数選択可）。
   * 項目が無い旧ドキュメントは種別の既定値（参加店='staff'、
   * スポット='placed'、協賛=なし）に倒す。
   */
  stampMethods: CheckpointStampMethod[];
  /**
   * お客さんが読み取る方法（置きQR・回転QR）のときの追加チェック:
   * 端末GPSでスポットから50m以内かを判定するか。既定オフ。
   * 判定の実施は PR-D（ここでは設定の保存・表示まで）。
   */
  gpsCheck: boolean;
  /**
   * お客さんが読み取る方法のときの追加チェック: 移動速度チェックを
   * 行うか。既定オフ。判定の実施は PR-D。
   */
  velocityCheck: boolean;
}

export function mapExhibitor(
  id: string,
  data: Record<string, unknown>,
): EventExhibitor {
  return {
    id,
    name: String(data.name ?? ''),
    email:
      typeof data.email === 'string' && data.email ? data.email : null,
    address:
      typeof data.address === 'string' && data.address ? data.address : null,
    hasAccessCode:
      typeof data.accessCode === 'string' && data.accessCode.length > 0,
    lang: normalizeLocale(data.lang),
    kind: parseExhibitorKind(data.kind),
    source: parseExhibitorSource(data.source),
    delistedAt:
      typeof data.delistedAt === 'string' && data.delistedAt
        ? data.delistedAt
        : null,
    closedAt:
      typeof data.closedAt === 'string' && data.closedAt
        ? data.closedAt
        : null,
    stampCode: isValidStampCode(data.stampCode) ? data.stampCode : null,
    checkpointNumber: parseCheckpointNumber(data.checkpointNumber),
    stampMethods: parseStampMethods(
      data.stampMethods,
      parseExhibitorKind(data.kind),
    ),
    gpsCheck: data.gpsCheck === true,
    velocityCheck: data.velocityCheck === true,
  };
}

/** クーポンの発行元。'admin' = 主催者（従来どおり無料・即時）、'shop' = 参加店自身。 */
export type CouponIssuedBy = 'admin' | 'shop';

/** 保存済みの発行元を防御的に読む（読み取り用）。旧ドキュメントは 'admin'。 */
export function parseCouponIssuedBy(value: unknown): CouponIssuedBy {
  return value === 'shop' ? 'shop' : 'admin';
}

export interface EventCoupon {
  id: string;
  exhibitorId: string;
  exhibitorName: string;
  title: string;
  description: string;
  /** タイトルの言語別マップ（作成時に自動翻訳） */
  titleI18n: Partial<Record<Locale, string>>;
  /** 説明文の言語別マップ（同上） */
  descriptionI18n: Partial<Record<Locale, string>>;
  keywords: string[];
  active: boolean;
  /** 発行元。旧ドキュメント（項目なし）は 'admin' として扱う */
  issuedBy: CouponIssuedBy;
  /**
   * 店舗発行で発行手数料の支払い待ちかどうか。true の間は active=false で
   * 保存され、来場者には見えず取得もできない。支払いが確認できたら
   * activatePaidCoupon で active=true・false に切り替わる。
   * 主催者発行と無料の店舗発行では常に false。
   */
  paymentPending: boolean;
  /**
   * 店舗発行で作成時点に固定された発行手数料（円）。支払いの検証で
   * Checkout の金額と突き合わせるためのスナップショット。
   * 主催者発行・無料発行は null。
   */
  feeAmount: number | null;
  /**
   * 取得できる期間の開始日（JST の 'YYYY-MM-DD'）。告知期間中に先に
   * 取得させて使用は開催期間だけ、という運用のために使用期間と分けて
   * 持つ。null は制限なし。旧ドキュメント（項目なし）は null に倒す。
   */
  claimFrom: string | null;
  /** 取得できる期間の終了日（JST の 'YYYY-MM-DD'）。null は制限なし。 */
  claimUntil: string | null;
  /** 使える期間の開始日（JST の 'YYYY-MM-DD'）。null は制限なし。 */
  useFrom: string | null;
  /** 使える期間の終了日（JST の 'YYYY-MM-DD'）。null は制限なし。 */
  useUntil: string | null;
}

/** クーポンの取得・使用期間（いずれも JST の 'YYYY-MM-DD'、null は制限なし）。 */
export interface CouponWindows {
  claimFrom: string | null;
  claimUntil: string | null;
  useFrom: string | null;
  useUntil: string | null;
}

const COUPON_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 保存値を防御的に読む（形式が合わなければ null = 制限なしに倒す）。 */
export function parseCouponWindowDate(value: unknown): string | null {
  return typeof value === 'string' && COUPON_DATE_PATTERN.test(value)
    ? value
    : null;
}

function parseWindowInput(
  value: string | null | undefined,
  label: string,
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (!COUPON_DATE_PATTERN.test(value)) {
    throw new Error(`${label}の形式が不正です`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label}の日付が不正です`);
  }
  return value;
}

/**
 * 作成入力の期間を検証して正規化する。開始日が終了日より後なら例外。
 * 未指定（undefined/null/空文字）は制限なし（null）。
 */
export function normalizeCouponWindows(
  input: Partial<Record<keyof CouponWindows, string | null | undefined>>,
): CouponWindows {
  const windows: CouponWindows = {
    claimFrom: parseWindowInput(input.claimFrom, '取得期間の開始日'),
    claimUntil: parseWindowInput(input.claimUntil, '取得期間の終了日'),
    useFrom: parseWindowInput(input.useFrom, '使用期間の開始日'),
    useUntil: parseWindowInput(input.useUntil, '使用期間の終了日'),
  };
  if (
    windows.claimFrom &&
    windows.claimUntil &&
    windows.claimFrom > windows.claimUntil
  ) {
    throw new Error('取得期間の終了日は開始日以降を指定してください');
  }
  if (windows.useFrom && windows.useUntil && windows.useFrom > windows.useUntil) {
    throw new Error('使用期間の終了日は開始日以降を指定してください');
  }
  return windows;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** JST の今日（'YYYY-MM-DD'）。期間判定の基準日。 */
export function jstTodayString(now: Date = new Date()): string {
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export type CouponClaimState = 'upcoming' | 'open' | 'closed';

/** 指定日（JST）にそのクーポンを取得できる状態かどうか。 */
export function couponClaimState(
  coupon: Pick<EventCoupon, 'claimFrom' | 'claimUntil'>,
  todayJst: string,
): CouponClaimState {
  if (coupon.claimFrom && todayJst < coupon.claimFrom) return 'upcoming';
  if (coupon.claimUntil && todayJst > coupon.claimUntil) return 'closed';
  return 'open';
}

/** 指定日（JST）にそのクーポンを使用（消込）できるかどうか。 */
export function isCouponUseAllowedOn(
  coupon: Pick<EventCoupon, 'useFrom' | 'useUntil'>,
  todayJst: string,
): boolean {
  if (coupon.useFrom && todayJst < coupon.useFrom) return false;
  if (coupon.useUntil && todayJst > coupon.useUntil) return false;
  return true;
}

export interface EventClaim {
  id: string;
  memberId: string;
  couponId: string;
  exhibitorId: string;
  status: 'claimed' | 'redeemed';
}

// PR #4（event-register）の memberIdForPhone と同一式。
// 両PRのマージ後に共通化する。
export function memberIdForPhone(phoneE164: string): string {
  return createHash('sha256').update(phoneE164.trim()).digest('hex');
}

/**
 * 端末認証（SMSオフ時）の memberId。端末の識別子（匿名認証の uid）の
 * SHA-256 ハッシュ。電話番号の memberId と衝突しないよう 'device:'
 * プレフィックスを付けてからハッシュする。uid そのものはドキュメントIDに
 * 含めない（memberIdForPhone と同じ作法）。
 */
export function memberIdForDevice(deviceUid: string): string {
  return createHash('sha256').update(`device:${deviceUid.trim()}`).digest('hex');
}

export function claimIdFor(memberId: string, couponId: string): string {
  return `${memberId}_${couponId}`;
}

/** クーポン検索（会社名・タイトル・説明・キーワードに部分一致、大文字小文字を無視）。 */
export function filterCoupons(coupons: EventCoupon[], query: string): EventCoupon[] {
  const q = query.trim().toLowerCase();
  if (!q) return coupons;
  return coupons.filter((coupon) => {
    const haystack = [
      coupon.title,
      coupon.description,
      coupon.exhibitorName,
      ...coupon.keywords,
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

export type RedemptionActor =
  | { type: 'organizer' }
  | { type: 'exhibitor'; exhibitorId: string };

export type RedemptionDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'not-owner'
        | 'already-redeemed'
        | 'coupon-inactive'
        | 'outside-use-window';
    };

/**
 * 消込可否の判定（純粋関数）。
 * - 出店者は自社クーポンのみ。主催者は全クーポン可。
 * - 消込済みの取得記録は二度消しできない。
 * - todayJst を渡すと使用期間（useFrom/useUntil）も判定する。
 *   渡さない場合は期間判定をしない（従来の呼び出しとの互換）。
 */
export function evaluateRedemption(
  actor: RedemptionActor,
  coupon: Pick<EventCoupon, 'exhibitorId' | 'active' | 'useFrom' | 'useUntil'>,
  claim: Pick<EventClaim, 'status'>,
  todayJst?: string,
): RedemptionDecision {
  if (actor.type === 'exhibitor' && actor.exhibitorId !== coupon.exhibitorId) {
    return { allowed: false, reason: 'not-owner' };
  }
  if (!coupon.active) return { allowed: false, reason: 'coupon-inactive' };
  if (claim.status === 'redeemed') return { allowed: false, reason: 'already-redeemed' };
  if (todayJst && !isCouponUseAllowedOn(coupon, todayJst)) {
    return { allowed: false, reason: 'outside-use-window' };
  }
  return { allowed: true };
}

function eventRef(eventId: string) {
  return db.collection('events').doc(eventId);
}

function exhibitorsRef(eventId: string) {
  return eventRef(eventId).collection(EVENT_EXHIBITORS_COLLECTION);
}

function couponsRef(eventId: string) {
  return eventRef(eventId).collection(EVENT_COUPONS_COLLECTION);
}

// ─── 出店者 ───

/** 出店者の表示言語（個人の選択）を保存する。 */
export async function updateExhibitorLanguage(
  eventId: string,
  exhibitorId: string,
  lang: Locale,
): Promise<void> {
  await eventRef(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId)
    .update({ lang });
}

export async function createExhibitor(
  eventId: string,
  input: {
    name: string;
    email?: string | null;
    lang?: Locale;
    /** 登録時の住所（管理用・トップレベル）。公開プロフィールとは別 */
    address?: string | null;
    kind?: ExhibitorKind;
    /** 登録の入口。未指定は主催者発行（'admin'） */
    source?: ExhibitorSource;
    /** チェックポイント番号（任意）。重複チェックは呼び出し側の設定更新で行う */
    checkpointNumber?: number | null;
    /**
     * ドキュメントIDを呼び出し側で先に決める場合に指定する。
     * 自己申込では、支払い確認前に課金レコードを同じ ID で作るため、
     * 申込時点で ID を採番しておく（lib/event-apply.ts）。
     */
    id?: string;
  },
): Promise<EventExhibitor> {
  const name = input.name.trim();
  if (!name) throw new Error('出店者名が必要です');
  const event = await getEvent(eventId);
  const ref = input.id
    ? exhibitorsRef(eventId).doc(input.id)
    : exhibitorsRef(eventId).doc();
  const email = input.email?.trim().toLowerCase() || null;
  const address = input.address?.trim() || null;
  const kind = input.kind ?? 'shop';
  const checkpointNumber = parseCheckpointNumber(input.checkpointNumber);
  const exhibitor: EventExhibitor = {
    id: ref.id,
    name,
    email,
    address,
    hasAccessCode: false,
    lang: resolveLocale(input.lang, event?.defaultLocale),
    kind,
    source: input.source ?? 'admin',
    delistedAt: null,
    closedAt: null,
    // 場所QR用のスタンプコードはチェックポイント（参加店・スポット）
    // だけに作成時自動発行する（協賛はチェックポイントではないため
    // 持たない）。
    stampCode: kind === 'shop' || kind === 'spot' ? generateStampCode() : null,
    checkpointNumber,
    // 認証方法は種別の既定値で始める（コンソールで後から変更できる）。
    // 追加チェックは既定オフ。
    stampMethods: defaultStampMethods(kind),
    gpsCheck: false,
    velocityCheck: false,
  };
  // hasAccessCode / delistedAt / closedAt はドキュメントの実フィールドから
  // 導く表示用の値で、作成時に保存するのは実フィールド（email / address /
  // lang / kind / source）だけ（停止・閉店の印は課金側が後から付ける）。
  const {
    hasAccessCode: _displayOnly,
    delistedAt: _delistedDisplayOnly,
    closedAt: _closedDisplayOnly,
    ...stored
  } = exhibitor;
  await ref.set({ ...stored, createdAt: FieldValue.serverTimestamp() });
  return exhibitor;
}

export async function listExhibitors(eventId: string): Promise<EventExhibitor[]> {
  const snap = await exhibitorsRef(eventId).get();
  return snap.docs.map((doc) => mapExhibitor(doc.id, doc.data()));
}

export async function getExhibitor(
  eventId: string,
  exhibitorId: string,
): Promise<EventExhibitor | null> {
  const doc = await exhibitorsRef(eventId).doc(exhibitorId).get();
  if (!doc.exists) return null;
  return mapExhibitor(doc.id, doc.data()!);
}

// ─── 場所QRコード（スタンプ認証） ───

/**
 * スタンプコードが無ければ発行して返す（遅延発行）。導入前の旧参加店・
 * スポットドキュメント向けで、主催者コンソールの表示時に呼ばれる。
 * 協賛・閉店扱いのアカウントには発行しない（null）。
 */
export async function ensureExhibitorStampCode(
  eventId: string,
  exhibitor: EventExhibitor,
): Promise<string | null> {
  if (exhibitor.stampCode) return exhibitor.stampCode;
  if (exhibitor.kind === 'advertiser' || exhibitor.closedAt) return null;
  const stampCode = generateStampCode();
  await exhibitorsRef(eventId)
    .doc(exhibitor.id)
    .update({ stampCode });
  return stampCode;
}

/**
 * スタンプコードを再発行する。保存値を差し替えるだけなので、旧コードは
 * その時点で無効になる。対象が無ければ null。
 */
export async function regenerateExhibitorStampCode(
  eventId: string,
  exhibitorId: string,
): Promise<string | null> {
  const exhibitor = await getExhibitor(eventId, exhibitorId);
  if (!exhibitor || exhibitor.kind === 'advertiser') return null;
  const stampCode = generateStampCode();
  await exhibitorsRef(eventId).doc(exhibitorId).update({ stampCode });
  return stampCode;
}

// ─── チェックポイント設定（番号・認証方法・追加チェック） ───

export type UpdateExhibitorCheckpointSettingsResult =
  | { ok: true; exhibitor: EventExhibitor }
  | { ok: false; status: number; error: string };

/**
 * チェックポイント設定（番号・認証方法・追加チェック）を更新する。
 * 対象は参加店とスポットだけ（協賛にはチェックポイント設定が無い）。
 * 番号は同一イベント内で重複を許さない（閉店扱い・協賛は対象外）。
 * 指定された項目だけを更新する（undefined の項目は触らない）。
 */
export async function updateExhibitorCheckpointSettings(
  eventId: string,
  exhibitorId: string,
  input: {
    checkpointNumber?: number | null;
    stampMethods?: unknown;
    gpsCheck?: unknown;
    velocityCheck?: unknown;
  },
): Promise<UpdateExhibitorCheckpointSettingsResult> {
  const exhibitor = await getExhibitor(eventId, exhibitorId);
  if (!exhibitor) {
    return { ok: false, status: 404, error: 'チェックポイントが見つかりません' };
  }
  if (exhibitor.kind === 'advertiser') {
    return {
      ok: false,
      status: 400,
      error: '協賛アカウントにはチェックポイント設定はありません',
    };
  }
  const patch: Record<string, unknown> = {};
  if (input.checkpointNumber !== undefined) {
    if (
      input.checkpointNumber !== null &&
      !isValidCheckpointNumber(input.checkpointNumber)
    ) {
      return {
        ok: false,
        status: 400,
        error: 'チェックポイント番号は1以上の整数で指定してください',
      };
    }
    if (input.checkpointNumber !== null) {
      const conflict = findCheckpointNumberConflict(
        await listExhibitors(eventId),
        exhibitorId,
        input.checkpointNumber,
      );
      if (conflict) {
        return {
          ok: false,
          status: 409,
          error: `番号${input.checkpointNumber}は「${conflict.name}」で既に使われています`,
        };
      }
    }
    patch.checkpointNumber = input.checkpointNumber;
  }
  if (input.stampMethods !== undefined) {
    try {
      patch.stampMethods = normalizeStampMethods(input.stampMethods);
    } catch (error) {
      return {
        ok: false,
        status: 400,
        error:
          error instanceof Error
            ? error.message
            : 'スタンプの認証方法の形式が不正です',
      };
    }
  }
  if (input.gpsCheck !== undefined) {
    if (typeof input.gpsCheck !== 'boolean') {
      return {
        ok: false,
        status: 400,
        error: 'GPSチェックの設定形式が不正です',
      };
    }
    patch.gpsCheck = input.gpsCheck;
  }
  if (input.velocityCheck !== undefined) {
    if (typeof input.velocityCheck !== 'boolean') {
      return {
        ok: false,
        status: 400,
        error: '移動速度チェックの設定形式が不正です',
      };
    }
    patch.velocityCheck = input.velocityCheck;
  }
  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: '変更項目がありません' };
  }
  await exhibitorsRef(eventId).doc(exhibitorId).update(patch);
  const updated = await getExhibitor(eventId, exhibitorId);
  if (!updated) {
    return { ok: false, status: 404, error: 'チェックポイントが見つかりません' };
  }
  return { ok: true, exhibitor: updated };
}

// ─── クーポン ───

/** クーポン上限に達しているか（上限はイベント設定の契約枠）。 */
export function isCouponCapReached(couponCount: number, couponCap: number): boolean {
  return couponCount >= couponCap;
}

export async function createCoupon(
  eventId: string,
  input: {
    exhibitorId: string;
    title: string;
    description?: string;
    keywords?: string[];
    /**
     * 発行元。未指定は 'admin'（主催者発行: 従来どおり無料・即時・有効）。
     * 'shop'（参加店発行）で発行手数料が有料のときは paymentPending: true を
     * 付けると、支払いが確認されるまで無効（非公開・取得不可）で作られる。
     */
    issuedBy?: CouponIssuedBy;
    /** 支払い待ちとして作るかどうか（店舗発行・有料時のみ true） */
    paymentPending?: boolean;
    /** 作成時点の発行手数料スナップショット（円）。支払い待ちのときだけ付ける */
    feeAmount?: number | null;
    /** 取得できる期間の開始日（'YYYY-MM-DD'）。未指定は制限なし */
    claimFrom?: string | null;
    /** 取得できる期間の終了日（'YYYY-MM-DD'）。未指定は制限なし */
    claimUntil?: string | null;
    /** 使える期間の開始日（'YYYY-MM-DD'）。未指定は制限なし */
    useFrom?: string | null;
    /** 使える期間の終了日（'YYYY-MM-DD'）。未指定は制限なし */
    useUntil?: string | null;
  },
): Promise<EventCoupon> {
  const exhibitor = await getExhibitor(eventId, input.exhibitorId);
  if (!exhibitor) throw new Error('出店者が見つかりません');
  if (exhibitor.kind === 'advertiser') {
    throw new Error('協賛アカウントにはクーポンを登録できません');
  }
  if (exhibitor.kind === 'spot') {
    throw new Error('スポットにはクーポンを登録できません');
  }
  const title = input.title.trim();
  if (!title) throw new Error('クーポンのタイトルが必要です');

  const event = await getEvent(eventId);
  const couponCap = event?.couponCap ?? MAX_COUPONS_PER_EVENT;
  const countSnap = await couponsRef(eventId).count().get();
  if (isCouponCapReached(countSnap.data().count, couponCap)) {
    throw new Error(`クーポンはイベント全体で最大${couponCap}件までです`);
  }

  const ref = couponsRef(eventId).doc();
  const description = (input.description ?? '').trim();
  // 作成時に翻訳を揃える。失敗時は空マップで続行（原文表示にフォールバック）。
  const [titleI18n, descriptionI18n] = await Promise.all([
    translateText(title),
    translateText(description),
  ]);
  const paymentPending = input.paymentPending === true;
  const windows = normalizeCouponWindows(input);
  const coupon: EventCoupon = {
    id: ref.id,
    exhibitorId: exhibitor.id,
    exhibitorName: exhibitor.name,
    title,
    description,
    titleI18n,
    descriptionI18n,
    keywords: (input.keywords ?? []).map((k) => k.trim()).filter(Boolean),
    // 支払い待ちの間は無効で作る（来場者に見せず、取得もさせない）
    active: !paymentPending,
    issuedBy: input.issuedBy ?? 'admin',
    paymentPending,
    feeAmount: paymentPending ? (input.feeAmount ?? null) : null,
    ...windows,
  };
  await ref.set({ ...coupon, createdAt: FieldValue.serverTimestamp() });
  return coupon;
}

/** 保存済みクーポンを防御的に読む（listCoupons / getCoupon 共用）。 */
function mapCoupon(id: string, data: Record<string, unknown>): EventCoupon {
  return {
    id,
    exhibitorId: String(data.exhibitorId ?? ''),
    exhibitorName: String(data.exhibitorName ?? ''),
    title: String(data.title ?? ''),
    description: String(data.description ?? ''),
    titleI18n: parseLocalizedTexts(data.titleI18n),
    descriptionI18n: parseLocalizedTexts(data.descriptionI18n),
    keywords: Array.isArray(data.keywords) ? (data.keywords as string[]) : [],
    active: data.active !== false,
    issuedBy: parseCouponIssuedBy(data.issuedBy),
    paymentPending: data.paymentPending === true,
    feeAmount: typeof data.feeAmount === 'number' ? data.feeAmount : null,
    claimFrom: parseCouponWindowDate(data.claimFrom),
    claimUntil: parseCouponWindowDate(data.claimUntil),
    useFrom: parseCouponWindowDate(data.useFrom),
    useUntil: parseCouponWindowDate(data.useUntil),
  };
}

export async function listCoupons(eventId: string): Promise<EventCoupon[]> {
  const snap = await couponsRef(eventId).get();
  return snap.docs.map((doc) => mapCoupon(doc.id, doc.data()));
}

export async function getCoupon(
  eventId: string,
  couponId: string,
): Promise<EventCoupon | null> {
  const doc = await couponsRef(eventId).doc(couponId).get();
  if (!doc.exists) return null;
  return mapCoupon(doc.id, doc.data()!);
}

/**
 * 支払い待ちクーポンを有効化する（発行手数料の支払い確認後に呼ぶ）。
 * 既に有効化済みなら何もしない（冪等）。戻り値は「今回有効化したか」。
 * クーポンが無い・支払い待ちでない場合は false。
 */
export async function activatePaidCoupon(
  eventId: string,
  couponId: string,
): Promise<boolean> {
  const ref = couponsRef(eventId).doc(couponId);
  const doc = await ref.get();
  if (!doc.exists) return false;
  if (doc.data()?.paymentPending !== true) return false;
  await ref.update({ active: true, paymentPending: false });
  return true;
}

// ─── 取得 ───

export type ClaimResult =
  | { ok: true; claimId: string; alreadyClaimed: boolean }
  | { ok: false; status: number; error: string };

export async function claimCoupon(
  eventId: string,
  couponId: string,
  memberId: string,
): Promise<ClaimResult> {
  const event = await getEvent(eventId);
  if (!event) return { ok: false, status: 404, error: 'イベントが見つかりません' };

  const memberRef = eventRef(eventId)
    .collection(EVENT_SUBCOLLECTIONS.members)
    .doc(memberId);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    return { ok: false, status: 403, error: '先にイベントへ登録してください' };
  }

  const coupon = await getCoupon(eventId, couponId);
  if (!coupon || !coupon.active) {
    return { ok: false, status: 404, error: 'クーポンが見つかりません' };
  }

  // 取得期間の判定（告知中に先行取得させる運用では、期間外の取得を止める）
  const claimState = couponClaimState(coupon, jstTodayString());
  if (claimState === 'upcoming') {
    return {
      ok: false,
      status: 403,
      error: `このクーポンは ${coupon.claimFrom} から取得できます`,
    };
  }
  if (claimState === 'closed') {
    return { ok: false, status: 403, error: 'このクーポンの取得期間は終了しました' };
  }

  const claimId = claimIdFor(memberId, couponId);
  const claimRef = eventRef(eventId)
    .collection(EVENT_SUBCOLLECTIONS.claims)
    .doc(claimId);
  const claimSnap = await claimRef.get();
  if (claimSnap.exists) {
    // 取得済みは冪等に成功として返す（再取得で二重に持たせない）
    return { ok: true, claimId, alreadyClaimed: true };
  }

  await claimRef.set({
    memberId,
    couponId,
    exhibitorId: coupon.exhibitorId,
    status: 'claimed',
    claimedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, claimId, alreadyClaimed: false };
}

export interface MemberClaimView {
  claimId: string;
  couponId: string;
  title: string;
  exhibitorName: string;
  status: 'claimed' | 'redeemed';
}

/** 来場者本人の取得済みクーポン一覧（クーポン情報を付けて返す）。
 * locale があればタイトルをその言語で返す（作成時の自動翻訳を使用）。 */
export async function listClaimsByMember(
  eventId: string,
  memberId: string,
  locale?: Locale,
): Promise<MemberClaimView[]> {
  const snap = await eventRef(eventId)
    .collection(EVENT_SUBCOLLECTIONS.claims)
    .where('memberId', '==', memberId)
    .get();
  const event = locale ? await getEvent(eventId) : null;
  const views: MemberClaimView[] = [];
  for (const doc of snap.docs) {
    const data = doc.data();
    const coupon = await getCoupon(eventId, String(data.couponId ?? ''));
    views.push({
      claimId: doc.id,
      couponId: String(data.couponId ?? ''),
      title: coupon
        ? (locale
            ? pickLocalizedText(coupon.titleI18n, locale, event?.defaultLocale)
            : '') || coupon.title
        : locale
          ? uiText(locale, 'deletedCoupon')
          : '（削除されたクーポン）',
      exhibitorName: coupon?.exhibitorName ?? '',
      status: data.status === 'redeemed' ? 'redeemed' : 'claimed',
    });
  }
  return views;
}

// ─── 件数集計 ───

export interface CouponClaimCounts {
  claimedCount: number;
  redeemedCount: number;
}

/** 取得記録をクーポンごとに集計する純粋関数。
 * claimedCount は取得総数、redeemedCount はそのうち消込済みの数。 */
export function tallyClaimsByCoupon(
  claims: Array<Pick<EventClaim, 'couponId' | 'status'>>,
): Map<string, CouponClaimCounts> {
  const tally = new Map<string, CouponClaimCounts>();
  for (const claim of claims) {
    const counts = tally.get(claim.couponId) ?? { claimedCount: 0, redeemedCount: 0 };
    counts.claimedCount += 1;
    if (claim.status === 'redeemed') counts.redeemedCount += 1;
    tally.set(claim.couponId, counts);
  }
  return tally;
}

/** 1出店者分の取得・消込件数をクーポンごとに返す（出店者画面の件数表示用）。
 * claims ドキュメントは exhibitorId を保持するので、その出店者の分だけを
 * 1クエリで読み、他社の記録には触れない。 */
export async function countClaimsByExhibitor(
  eventId: string,
  exhibitorId: string,
): Promise<Map<string, CouponClaimCounts>> {
  const snap = await eventRef(eventId)
    .collection(EVENT_SUBCOLLECTIONS.claims)
    .where('exhibitorId', '==', exhibitorId)
    .get();
  return tallyClaimsByCoupon(
    snap.docs.map((doc) => {
      const data = doc.data();
      return {
        couponId: String(data.couponId ?? ''),
        status: (data.status === 'redeemed' ? 'redeemed' : 'claimed') as EventClaim['status'],
      };
    }),
  );
}

// ─── 消込 ───

export type RedeemResult =
  | { ok: true; claimId: string }
  | { ok: false; status: number; error: string };

type RedemptionRejection =
  | 'not-owner'
  | 'already-redeemed'
  | 'coupon-inactive'
  | 'outside-use-window';

const REDEMPTION_ERRORS: Record<
  RedemptionRejection,
  { status: number; error: string }
> = {
  'not-owner': { status: 403, error: '他社のクーポンは消込できません' },
  'already-redeemed': { status: 409, error: 'このクーポンは消込済みです' },
  'coupon-inactive': { status: 409, error: 'このクーポンは現在無効です' },
  'outside-use-window': { status: 403, error: 'このクーポンは使用期間外です' },
};

export async function redeemClaim(
  eventId: string,
  claimId: string,
  actor: RedemptionActor,
): Promise<RedeemResult> {
  const claimRef = eventRef(eventId)
    .collection(EVENT_SUBCOLLECTIONS.claims)
    .doc(claimId);
  const redemptionRef = eventRef(eventId)
    .collection(EVENT_SUBCOLLECTIONS.redemptions)
    .doc(claimId);

  return db.runTransaction(async (tx) => {
    const claimSnap = await tx.get(claimRef);
    if (!claimSnap.exists) {
      return { ok: false, status: 404, error: '取得記録が見つかりません' } as RedeemResult;
    }
    const claimData = claimSnap.data()!;
    const claim: EventClaim = {
      id: claimSnap.id,
      memberId: String(claimData.memberId ?? ''),
      couponId: String(claimData.couponId ?? ''),
      exhibitorId: String(claimData.exhibitorId ?? ''),
      status: claimData.status === 'redeemed' ? 'redeemed' : 'claimed',
    };

    const coupon = await getCoupon(eventId, claim.couponId);
    if (!coupon) {
      return { ok: false, status: 404, error: 'クーポンが見つかりません' } as RedeemResult;
    }

    const decision = evaluateRedemption(actor, coupon, claim, jstTodayString());
    if (!decision.allowed) {
      const response = REDEMPTION_ERRORS[decision.reason];
      return { ok: false, status: response.status, error: response.error } as RedeemResult;
    }

    tx.update(claimRef, {
      status: 'redeemed',
      redeemedAt: FieldValue.serverTimestamp(),
      redeemedBy: actor.type === 'organizer' ? 'organizer' : actor.exhibitorId,
    });
    tx.set(redemptionRef, {
      claimId,
      couponId: claim.couponId,
      exhibitorId: coupon.exhibitorId,
      memberId: claim.memberId,
      redeemedBy: actor.type === 'organizer' ? 'organizer' : actor.exhibitorId,
      redeemedAt: FieldValue.serverTimestamp(),
    });
    return { ok: true, claimId } as RedeemResult;
  });
}
