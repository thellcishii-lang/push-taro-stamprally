// lib/event.ts
// Push-taro.スタンプラリー のプロジェクト設定モデル（純粋な型・定数・判定ロジックのみ）。
// Firestore への読み書きは lib/event-store.ts に分離する。
//
// 設計原則（干渉しない・波及しない）:
// - プロジェクトごとにデータ名前空間を分ける（events/{eventId} 配下で完結）。
// - リセット等の定期処理は「固定時刻の一括 cron」にせず、
//   15分間隔のスケジューラがプロジェクト単独で拾って実行する前提の判定関数を用意する。

import type { Locale } from './i18n';
import type { SiteNote } from './event-site';

/** 日次リセットの方式。プロジェクトごとに選択する。 */
export type EventResetMode =
  /** 方式A: 購読も電話番号も毎日消去する（単日プロジェクト向け） */
  | 'full-daily'
  /** 方式B: 毎日リセットするのは購読のみ。電話番号と取得・消込記録は期間中保持し、終了時に消去する */
  | 'keep-phones';

export type EventStatus = 'draft' | 'live' | 'ended';

/**
 * スタンプ達成特典の種類。主催者がプロジェクトごとに選ぶ。
 * - 'free-dish': 「好きな店で1回無料」クーポン（従来の挙動）
 * - 'benefit': 主催者が文面を決める特典クーポン（stampBenefitText）
 */
export type StampRewardType = 'free-dish' | 'benefit';

/**
 * 途中の特典（マイルストーン特典）。ラリー1周の途中で、スタンプが
 * count 個に届いた時点で1回だけ自動発行される特典。最終の達成特典
 * （stampGoalCount 到達時）とは別枠で、件数の上限は設けない。
 * 発行されるクーポンには発行時点の種類・内容がスナップショットとして
 * 写され、freeCoupons 側に milestoneCount の印が付く。
 */
export interface StampMilestone {
  /** 到達スタンプ数（1〜MAX_STAMP_SLOTS の整数。同じ個数は1件だけ） */
  count: number;
  /** 特典の種類（達成特典と同じ2種） */
  rewardType: StampRewardType;
  /** 特典の内容。rewardType が 'benefit' のとき必須 */
  benefitText: string;
}

/**
 * 主催者リンク（最大3件）。来場者画面にタイトル付きカードで表示される。
 * プロジェクトドキュメントの links フィールドに配列で持つ。
 * タイトルは主催者が書いた原文のまま表示する（案内PDFのタイトルと同じ扱い、
 * 自動翻訳しない）。
 */
export interface EventLink {
  title: string;
  url: string;
}

export interface EventConfig {
  id: string;
  /** プロジェクト名（例: 展示会名） */
  name: string;
  /** 主催者の Firebase Auth uid */
  ownerUid: string;
  /** 開催開始日（JST, 'YYYY-MM-DD'） */
  startDate: string;
  /** 開催終了日（JST, 'YYYY-MM-DD'）。この日を過ぎたら終了処理（電話番号消去）の対象 */
  endDate: string;
  resetMode: EventResetMode;
  /** リセット時刻（JST, 'HH:MM'）。プロジェクトごとに変更可能 */
  resetTime: string;
  /** 購読者上限 */
  subscriberCap: number;
  /** プロジェクトのデフォルト言語（主催者が設定）。個人の言語選択がこれを上書きする */
  defaultLocale: Locale;
  /**
   * 入場用QRの取り込みを有効にするか（主催者が設定。既定オフ）。
   * オンにすると、来場者が主催者側の既存システム（事前登録・チケット等）から
   * 受け取った入場用QRを自分の画面で読み込んで購読者レコードに保存し、
   * 入場時に表示できる。オフの間は来場者画面に何も出ず、保存もできない。
   */
  admissionQrEnabled: boolean;
  /**
   * ポータル（特設サイト本契約）が有効かどうか。
   * スタンプラリーはポータル主体の製品で、クーポンと特典の管理場所は
   * 常に1か所に寄せる: ポータル有効時はポータル側で管理し、アプリ側の
   * クーポン・特典はグレーアウトする。ポータル無効（アプリ単独）時は
   * アプリのコンソールで管理し、簡易特設ページが立ち上がる。
   * 本家接続のプロビジョニングが立てる項目で、主催者画面からは変更
   * しない。導入前に作られたプロジェクトには項目自体が無いため、
   * 読み取り時はオフ（アプリ単独）に倒す。
   */
  portalEnabled: boolean;
  /**
   * スタンプラリーの達成個数（1〜MAX_STAMP_SLOTS）。主催者がプロジェクト
   * ごとに設定する。1つの周（ラリー1周）で異なる参加店のスタンプを
   * この個数集めると「好きな店で1回無料」クーポンが発行される。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * DEFAULT_STAMP_GOAL_COUNT に倒す。
   */
  stampGoalCount: number;
  /**
   * スタンプ達成特典の種類（'free-dish' | 'benefit'）。主催者が
   * プロジェクトごとに設定する。'free-dish' は従来どおり「好きな店で
   * 1回無料」クーポン、'benefit' は stampBenefitText の内容の特典
   * クーポンが発行される。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * 'free-dish'（従来の挙動）に倒す。
   */
  stampRewardType: StampRewardType;
  /**
   * 特典の内容（最大 STAMP_BENEFIT_TEXT_MAX_LENGTH 字）。stampRewardType が
   * 'benefit' のときだけ意味を持ち、発行されるクーポンに発行時点の
   * スナップショットとして写される（後から設定を変えても発行済み
   * クーポンの表示は変わらない）。'free-dish' の間は使わない。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * 空文字に倒す。
   */
  stampBenefitText: string;
  /**
   * 途中の特典（マイルストーン特典）の一覧。主催者がプロジェクトごとに
   * 設定する。ラリー1周の中でスタンプが各 count に届いた時点で、その周に
   * 1回だけ特典クーポンが自動発行される（達成特典とは別枠）。
   * 件数の上限は設けない。導入前に作られたプロジェクトには項目自体が
   * 無いため、読み取り時は空配列に倒す。
   */
  stampMilestones: StampMilestone[];
  /**
   * 順番モード（主催者がプロジェクトごとに設定する。既定オフ）。
   * オンにすると、スタンプはチェックポイント番号の順にしか押せない
   * （次に押せるのは、現在の周でまだ押されていない番号付きチェック
   * ポイントのうち最小の番号。番号のないチェックポイントは対象外で
   * 押せない）。オフの間は従来どおり自由な順番で押せる。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * オフに倒す。
   */
  sequentialStamps: boolean;
  /**
   * 週次ランキングの対象になる最低レビュー件数（1〜20）。主催者が
   * プロジェクトごとに設定する。その週の可視レビューがこの件数に
   * 届いた参加店だけがランキングに入る（件数自体も一緒に表示する）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * DEFAULT_RANKING_MIN_REVIEWS に倒す。
   */
  rankingMinReviews: number;
  /**
   * レビューの項目別評価の項目名（1〜REVIEW_CATEGORY_MAX_COUNT 件）。
   * 主催者がプロジェクトごとに内容と数を変えられる。お客さんの書き込み
   * フォームはこの項目で星を付け、投稿されたレビューには投稿時点の
   * 項目名がスナップショットとして残る（後から設定を変えても過去の
   * レビューの表示は変わらない。実体は lib/event-review.ts）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * DEFAULT_REVIEW_CATEGORIES（味・接客・雰囲気・盛り付け）に倒す。
   */
  reviewCategories: string[];
  /**
   * 主催者リンク（最大 MAX_EVENT_LINKS 件）。設定画面で登録し、来場者画面に
   * タイトル付きで表示する（案内PDFと同じく登録前でも見える位置）。
   * 未登録なら空配列で、来場者画面には何も出ない。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は空配列に倒す。
   */
  links: EventLink[];
  /**
   * 特設サイト（本家上の公開ページ）の紹介文（最大300字）。主催者が
   * 特設サイト編集画面で設定し、ヒーローに表示される。未設定は空文字。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * 空文字に倒す（検証・正規化は lib/event-site.ts）。
   */
  siteDescription: string;
  /**
   * ご当地グルメの定義（最大1000字、改行可）。その土地のグルメと
   * 呼べる条件・素材・スタイルを主催者が書き、特設サイトに表示する。
   * 未設定は空文字。導入前に作られたプロジェクトには項目自体が無いため、
   * 読み取り時は空文字に倒す（検証・正規化は lib/event-site.ts）。
   */
  gourmetDefinition: string;
  /** 特設サイトのヒーロー画像の公開URL。未設定は null。 */
  heroImageUrl: string | null;
  /**
   * 特設サイトのヘッダーに表示する正方形のプロジェクトアイコンの
   * 公開URL。未設定は null。導入前に作られたプロジェクトには項目自体が
   * 無いため、読み取り時は null に倒す（検証・正規化は lib/event-site.ts）。
   */
  siteIconUrl: string | null;
  /**
   * 特設サイトのテーマカラー（#rrggbb）。プロジェクトごとに色味を
   * 変えるための設定で、未設定は null（表示側の既定色）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * null に倒す（検証・正規化は lib/event-site.ts）。
   */
  themeColor: string | null;
  /**
   * 特設サイトの追加事項（タイトル＋本文、最大5件）。主催者が特設サイト
   * 編集画面で設定する。未登録なら空配列。
   */
  siteNotes: SiteNote[];
  /**
   * 特設サイトのトップ掲載（先頭5枠）課金を有効にするか。主催者が
   * 特設サイト編集画面で設定する。既定オフ。オンの間、参加店は
   * topPlacementPrice の月額を払ってトップに優先表示できる
   * （課金の実体は lib/event-placement.ts）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * オフに倒す。
   */
  topPlacementEnabled: boolean;
  /**
   * トップ掲載の月額料金（円）。未設定は null。設定する場合は
   * TOP_PLACEMENT_PRICE_MIN〜TOP_PLACEMENT_PRICE_MAX の整数。
   * 0 は「無料」: 課金は発生せず、参加店が店舗ページで参加表明
   * （placementOptIn）した店が掲載対象になる。
   */
  topPlacementPrice: number | null;
  /**
   * 毎日ログインボーナスを有効にするか。主催者がプロジェクト設定で
   * 設定する。既定オフ。オンの間、来場者は来場者画面で毎日1回
   * チェックインでき、連続 loginBonusDays 日で「好きな店で使える」
   * ログインボーナスクーポンが発行される（実体は lib/event-login.ts）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * オフに倒す。
   */
  loginBonusEnabled: boolean;
  /**
   * ログインボーナスの達成日数（連続・LOGIN_BONUS_DAYS_MIN〜
   * LOGIN_BONUS_DAYS_MAX の整数）。主催者がプロジェクトごとに設定する。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * DEFAULT_LOGIN_BONUS_DAYS に倒す。
   */
  loginBonusDays: number;
  /**
   * 特設サイトの広告ページ（参加店の広告枠）を有効にするか。主催者が
   * 特設サイト編集画面で設定する。既定オフ。オンの間、参加店は
   * adsPrice の月額（0 なら無料）を払って広告を出せ、主催者の承認を
   * 経て特設サイトに最大 adsSlots 件まで掲載される
   * （実体は lib/event-ads.ts）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * オフに倒す。
   */
  adsEnabled: boolean;
  /**
   * 広告の掲載枠数（1〜MAX_AD_SLOTS の整数）。特設サイトの広告ページに
   * 同時に載せられる広告の上限。承認が早い順にこの件数まで載せる。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * DEFAULT_AD_SLOTS に倒す。
   */
  adsSlots: number;
  /**
   * 広告の月額料金（円）。未設定は null。設定する場合は
   * ADS_PRICE_MIN〜ADS_PRICE_MAX の整数。0 は「無料」: 課金は
   * 発生せず、主催者の承認だけで掲載される。
   */
  adsPrice: number | null;
  /**
   * 参加店が自店のクーポンを発行するときの手数料（1件あたり・円）。
   * 主催者が特設サイト編集画面で設定する。未設定（null）は 0 円
   * （無料）として扱う。設定する場合は COUPON_ISSUE_PRICE_MIN〜
   * COUPON_ISSUE_PRICE_MAX の整数。有料の間は主催者自身の Stripe で
   * 支払いが完了するまでクーポンは公開されない
   * （実体は lib/event-charges.ts）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * null（＝無料）に倒す。
   */
  couponIssuePrice: number | null;
  /**
   * 参加店がプッシュ配信を申請するときの手数料（1回あたり・円）。
   * 主催者が特設サイト編集画面で設定する。未設定（null）は 0 円
   * （無料）として扱う。設定する場合は PUSH_PRICE_MIN〜PUSH_PRICE_MAX
   * の整数。支払い（有料時）と主催者の承認を経て配信される
   * （実体は lib/event-charges.ts / lib/event-push-request.ts）。
   * 導入前に作られたプロジェクトには項目自体が無いため、読み取り時は
   * null（＝無料）に倒す。
   */
  pushPrice: number | null;
  /**
   * 参加店の自己登録（公開の登録ページ）で店が払う月額料金（円）。
   * 主催者が特設サイト編集画面で設定する。未設定（null）の間は自己登録を
   * 受け付けない。0 は「無料」: 支払いなしで登録が完了する。有料の間は
   * 主催者自身の Stripe で支払いが確認できてから参加店レコードが作られる
   * （実体は lib/event-apply.ts）。登録後の課金レコード（shopBillings）の
   * monthlyAmount にはこの金額が入る（主催者発行で店ごとに決める月額と
   * 同じ置き場）。導入前に作られたプロジェクトには項目自体が無いため、
   * 読み取り時は null（受け付けない）に倒す。
   */
  shopMonthlyPrice: number | null;
  /**
   * クーポン上限（プロジェクト全体の件数）。購読者上限と同じく契約枠の軸なので、
   * 変更は運営側のみ。既定は MAX_COUPONS_PER_EVENT。
   */
  couponCap: number;
  /**
   * 最終レポートの運営用バックアップ保持日数（契約ごとに設定）。
   * バックアップは削除対象の外に置き、期限を過ぎたら自動消去する。
   */
  backupRetentionDays: number;
  status: EventStatus;
  /** 最後に日次リセットを実行した JST 日付（'YYYY-MM-DD'）。未実施なら null */
  lastResetDate: string | null;
  /** 終了処理（電話番号消去まで）を完了したかどうか */
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** events/{eventId} 配下のサブコレクション名 */
export const EVENT_SUBCOLLECTIONS = {
  /** プッシュ購読（端末ごとの購読情報） */
  subscribers: 'subscribers',
  /** 電話番号キー本人確認レコード（電話番号そのものを含む） */
  members: 'members',
  /** クーポン取得記録（電話番号キーに紐づく） */
  claims: 'claims',
  /** クーポン消込記録（電話番号キーに紐づく） */
  redemptions: 'redemptions',
} as const;

export type EventSubcollection =
  (typeof EVENT_SUBCOLLECTIONS)[keyof typeof EVENT_SUBCOLLECTIONS];

export const DEFAULT_SUBSCRIBER_CAP = 50_000;
export const MAX_COUPONS_PER_EVENT = 100;
/**
 * 1主催者が同時に仕込めるプロジェクト数の上限（下書き＋開催中）。
 * スタンプラリーはポータル主体の製品で、ポータルが1つだからラリーも
 * 1つしか作らない（2026-11-24 決定）。終了したプロジェクトは数えない。
 */
export const MAX_CONCURRENT_EVENTS = 1;
export const MAX_INFO_PDFS = 5;
export const MAX_EVENT_LINKS = 3;
export const DEFAULT_RESET_TIME = '00:00';
/** スタンプラリー: プロジェクトは常設。終了日を持たないことを表す番兵値（終了処理は走らない）。 */
export const PERMANENT_END_DATE = '9999-12-31';
/** スタンプカードの枠の最大数（達成個数の上限）。 */
export const MAX_STAMP_SLOTS = 200;
/** スタンプの達成個数の既定値（主催者が未設定のプロジェクト）。 */
export const DEFAULT_STAMP_GOAL_COUNT = 5;
/** スタンプ達成特典の種類の既定値（従来の「1軒無料」）。 */
export const DEFAULT_STAMP_REWARD_TYPE: StampRewardType = 'free-dish';
/** 特典の内容の最大文字数。 */
export const STAMP_BENEFIT_TEXT_MAX_LENGTH = 100;
/** 週次ランキングの最低レビュー件数の上限。 */
export const MAX_RANKING_MIN_REVIEWS = 20;
/** 週次ランキングの最低レビュー件数の既定値（主催者が未設定のプロジェクト）。 */
export const DEFAULT_RANKING_MIN_REVIEWS = 3;
export const DEFAULT_BACKUP_RETENTION_DAYS = 30;
export const DEFAULT_RESET_MODE: EventResetMode = 'full-daily';

/** 新規プロジェクトの入力。省略項目は既定値で補完する。 */
export interface CreateEventInput {
  name: string;
  ownerUid: string;
  startDate: string;
  endDate: string;
  /** 作成時の状態。未指定は下書き。'ended' は作成時には指定できない。 */
  status?: 'draft' | 'live';
  resetMode?: EventResetMode;
  resetTime?: string;
  subscriberCap?: number;
  defaultLocale?: Locale;
  admissionQrEnabled?: boolean;
  /** ポータル（特設サイト本契約）の継承値。未指定はアプリ単独（false） */
  portalEnabled?: boolean;
  stampGoalCount?: number;
  stampRewardType?: StampRewardType;
  stampBenefitText?: string;
  stampMilestones?: StampMilestone[];
  sequentialStamps?: boolean;
  rankingMinReviews?: number;
  reviewCategories?: string[];
  loginBonusEnabled?: boolean;
  loginBonusDays?: number;
  adsEnabled?: boolean;
  adsSlots?: number;
  adsPrice?: number | null;
  couponIssuePrice?: number | null;
  pushPrice?: number | null;
  shopMonthlyPrice?: number | null;
  links?: EventLink[];
  couponCap?: number;
  backupRetentionDays?: number;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** Date を JST の 'YYYY-MM-DD' に変換する（coupon-day.ts の couponDay と同じ方式）。 */
/** 購読者の言語別 FCM トピック名。配信は言語ごとにこのトピックへ送る。 */
export function localeTopic(eventId: string, locale: Locale): string {
  return `event_${eventId}_users_${locale}`;
}

export function jstDateString(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Date を JST の 'HH:MM' に変換する。 */
export function jstTimeString(date: Date): string {
  return new Date(date.getTime() + JST_OFFSET_MS).toISOString().slice(11, 16);
}

/** 'HH:MM' 形式かどうかの簡易バリデーション（00:00〜23:59）。 */
export function isValidResetTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** https の URL かどうか。 */
export function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function readLinkFields(item: unknown): { title: string; url: string } | null {
  if (!item || typeof item !== 'object') return null;
  const raw = item as { title?: unknown; url?: unknown };
  return {
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    url: typeof raw.url === 'string' ? raw.url.trim() : '',
  };
}

/**
 * 主催者リンクの入力を検証して正規化する（書き込み用。不正なら throw）。
 * - タイトルと URL はセット: 片方だけの枠はエラー
 * - 両方空の枠は未指定として読み飛ばす（設定画面の空枠がこれに当たる）
 * - URL は https のみ許可
 * - 実質の件数は最大 MAX_EVENT_LINKS 件
 */
export function normalizeEventLinks(input: unknown): EventLink[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('リンクの形式が不正です');
  const links: EventLink[] = [];
  for (const item of input) {
    const fields = readLinkFields(item);
    if (!fields) throw new Error('リンクの形式が不正です');
    if (!fields.title && !fields.url) continue;
    if (!fields.title || !fields.url) {
      throw new Error('リンクのタイトルとURLは両方入力してください');
    }
    if (!isHttpsUrl(fields.url)) {
      throw new Error('リンクのURLは https:// で始まる必要があります');
    }
    links.push(fields);
  }
  if (links.length > MAX_EVENT_LINKS) {
    throw new Error(`リンクは最大${MAX_EVENT_LINKS}件までです`);
  }
  return links;
}

/**
 * 保存済みの主催者リンクを防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトは空配列。不正な要素は落とし、上限で切り詰める。
 */
export function parseEventLinks(value: unknown): EventLink[] {
  if (!Array.isArray(value)) return [];
  const links: EventLink[] = [];
  for (const item of value) {
    const fields = readLinkFields(item);
    if (fields && fields.title && fields.url && isHttpsUrl(fields.url)) {
      links.push(fields);
      if (links.length >= MAX_EVENT_LINKS) break;
    }
  }
  return links;
}

/**
 * このプロジェクトの「今日分」の日次リセットが実行すべき状態かどうか。
 *
 * スケジューラ（15分間隔）が各プロジェクトについて呼ぶ前提:
 * - 開催期間中（startDate <= 今日 <= endDate）であること
 * - 設定時刻を過ぎていること
 * - 今日分がまだ未実施（lastResetDate が今日でない）こと
 *
 * 冪等性は lastResetDate で担保する: 途中で失敗しても次の tick で再判定され、
 * 成功済みのプロジェクトは二重にリセットされない。
 */
export function isResetDue(
  event: Pick<EventConfig, 'startDate' | 'endDate' | 'resetTime' | 'lastResetDate' | 'status'>,
  now: Date,
): boolean {
  if (event.status !== 'live') return false;
  const today = jstDateString(now);
  if (today < event.startDate || today > event.endDate) return false;
  if (event.lastResetDate === today) return false;
  return jstTimeString(now) >= event.resetTime;
}

/** 同時プロジェクト上限のカウント対象かどうか（終了したプロジェクトは数えない）。 */
export function countsTowardConcurrentCap(
  event: Pick<EventConfig, 'status'>,
): boolean {
  return event.status !== 'ended';
}

/** 主催者が現在仕込んでいるプロジェクト数（下書き＋開催中）。 */
export function countConcurrentEvents(
  events: Pick<EventConfig, 'status'>[],
): number {
  return events.filter(countsTowardConcurrentCap).length;
}

/** 新しいプロジェクトをもう1つ仕込めるかどうか（同時上限 MAX_CONCURRENT_EVENTS 未満）。 */
export function canCreateAnotherEvent(
  events: Pick<EventConfig, 'status'>[],
): boolean {
  return countConcurrentEvents(events) < MAX_CONCURRENT_EVENTS;
}

/**
 * 作成時に指定できる状態かどうかを検証し、正規化する（純粋関数・テスト対象）。
 * 未指定（undefined / null）は下書き。'ended' は作成時には選べない
 * （終了はスケジューラの終了処理でのみ遷移する）。
 * それ以外は例外を投げる（呼び出し側で 400 にする）。
 */
export function resolveCreateStatus(value: unknown): 'draft' | 'live' {
  if (value === undefined || value === null || value === 'draft') return 'draft';
  if (value === 'live') return 'live';
  throw new Error('状態の指定が不正です（下書きか開催中を指定してください）');
}

/**
 * 主催者がプロジェクトを削除できるかどうか（純粋関数・テスト対象）。
 * 開催中は削除できない（先に終了させる運用）。削除できるのは
 * 下書きと、終了処理まで済んだ 'ended' のみ。
 */
export function canDeleteEvent(event: Pick<EventConfig, 'status'>): boolean {
  return event.status === 'draft' || event.status === 'ended';
}

/**
 * 契約枠の変更（プロビジョニング更新）を伝播してよいプロジェクトかどうか。
 * 「終わった」プロジェクト = 終了ステータス（'ended'）または終了処理完了
 * （finalizedAt 設定済み）。それ以外（下書き・開催中）は伝播対象で、
 * 終了済みのプロジェクトの枠は履歴として触らない。
 */
export function receivesCapsPropagation(
  event: Pick<EventConfig, 'status' | 'finalizedAt'>,
): boolean {
  return event.status !== 'ended' && !event.finalizedAt;
}

/**
 * 終了処理（電話番号消去）の対象かどうか。
 * 終了日を過ぎていて、まだ finalized されていないプロジェクトが対象。
 * リセットより優先される（終了後にリセットは走らない）。
 */
export function isFinalizationDue(
  event: Pick<EventConfig, 'endDate' | 'finalizedAt'>,
  now: Date,
): boolean {
  if (event.finalizedAt) return false;
  return jstDateString(now) > event.endDate;
}

/** スタンプの達成個数として有効な値かどうか（1〜MAX_STAMP_SLOTS の整数）。 */
export function isValidStampGoalCount(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_STAMP_SLOTS
  );
}

/**
 * 保存済みの達成個数を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトや不正な値は DEFAULT_STAMP_GOAL_COUNT に倒す。
 */
export function parseStampGoalCount(value: unknown): number {
  return isValidStampGoalCount(value)
    ? (value as number)
    : DEFAULT_STAMP_GOAL_COUNT;
}

/** スタンプ達成特典の種類として有効な値かどうか。 */
export function isValidStampRewardType(value: unknown): boolean {
  return value === 'free-dish' || value === 'benefit';
}

/**
 * 保存済みの特典の種類を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトや不正な値は 'free-dish'（従来の挙動）に倒す。
 */
export function parseStampRewardType(value: unknown): StampRewardType {
  return value === 'benefit' ? 'benefit' : DEFAULT_STAMP_REWARD_TYPE;
}

/**
 * 保存済みの特典の内容を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトは空文字。長すぎる値は上限で切り詰める。
 */
export function parseStampBenefitText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, STAMP_BENEFIT_TEXT_MAX_LENGTH);
}

/**
 * 特典の種類の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定は既定の 'free-dish'。
 */
export function normalizeStampRewardType(input: unknown): StampRewardType {
  if (input === undefined || input === null) return DEFAULT_STAMP_REWARD_TYPE;
  if (!isValidStampRewardType(input)) {
    throw new Error('特典の種類の指定が不正です（free-dish か benefit）');
  }
  return input as StampRewardType;
}

/**
 * 特典の内容の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定は空文字。前後の空白は落とす。
 */
export function normalizeStampBenefitText(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new Error('特典の内容の形式が不正です');
  const text = input.trim();
  if (text.length > STAMP_BENEFIT_TEXT_MAX_LENGTH) {
    throw new Error(
      `特典の内容は${STAMP_BENEFIT_TEXT_MAX_LENGTH}文字までです`,
    );
  }
  return text;
}

/**
 * 特典設定の組み合わせを検証する（書き込み用。不正なら throw）。
 * 'benefit' のときは内容が必須（空の特典クーポンは発行させない）。
 * 'free-dish' のときは内容が残っていてもよい（種類を戻したとき用に保持する）。
 */
export function validateStampRewardSettings(
  rewardType: StampRewardType,
  benefitText: string,
): void {
  if (rewardType === 'benefit' && !benefitText) {
    throw new Error('特典を選ぶ場合は、特典の内容を入力してください');
  }
}

/**
 * 保存済みの途中の特典（マイルストーン）を防御的に読む（読み取り用。
 * throw しない）。項目が無い旧プロジェクトは空配列。不正な要素は落とし、
 * 同じ個数が複数あれば最初の1件だけを採用する。結果は個数の昇順。
 * 件数の上限は設けない。
 */
export function parseStampMilestones(value: unknown): StampMilestone[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<number>();
  const milestones: StampMilestone[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as {
      count?: unknown;
      rewardType?: unknown;
      benefitText?: unknown;
    };
    if (!isValidStampGoalCount(raw.count)) continue;
    const count = raw.count as number;
    if (seen.has(count)) continue;
    const rewardType = parseStampRewardType(raw.rewardType);
    const benefitText = parseStampBenefitText(raw.benefitText);
    // 'benefit' で内容が無い特典は発行できないため落とす
    if (rewardType === 'benefit' && !benefitText) continue;
    seen.add(count);
    milestones.push({ count, rewardType, benefitText });
  }
  return milestones.sort((a, b) => a.count - b.count);
}

/**
 * 途中の特典（マイルストーン）の入力を検証して正規化する（書き込み用。
 * 不正なら throw）。未指定は空配列。個数は1〜MAX_STAMP_SLOTS の整数で
 * 重複不可、'benefit' のときは内容が必須（達成特典と同じルール）。
 * 件数の上限は設けない。結果は個数の昇順。
 */
export function normalizeStampMilestones(input: unknown): StampMilestone[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('途中の特典の形式が不正です');
  const seen = new Set<number>();
  const milestones: StampMilestone[] = [];
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      throw new Error('途中の特典の形式が不正です');
    }
    const raw = item as {
      count?: unknown;
      rewardType?: unknown;
      benefitText?: unknown;
    };
    if (!isValidStampGoalCount(raw.count)) {
      throw new Error(
        `途中の特典の個数は1〜${MAX_STAMP_SLOTS}の整数で指定してください`,
      );
    }
    const count = raw.count as number;
    if (seen.has(count)) {
      throw new Error('途中の特典の個数は重複させないでください');
    }
    const rewardType = normalizeStampRewardType(raw.rewardType);
    const benefitText = normalizeStampBenefitText(raw.benefitText);
    validateStampRewardSettings(rewardType, benefitText);
    seen.add(count);
    milestones.push({ count, rewardType, benefitText });
  }
  return milestones.sort((a, b) => a.count - b.count);
}

/** トップ掲載の月額料金の下限・上限（円）。0 は無料（参加表明制）。 */
export const TOP_PLACEMENT_PRICE_MIN = 0;
export const TOP_PLACEMENT_PRICE_MAX = 1_000_000;

/** トップ掲載の月額料金として有効な値かどうか（0〜1,000,000 の整数）。 */
export function isValidTopPlacementPrice(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TOP_PLACEMENT_PRICE_MIN &&
    value <= TOP_PLACEMENT_PRICE_MAX
  );
}

/**
 * 保存済みのトップ掲載料金を防御的に読む（読み取り用。throw しない）。
 * 未設定・不正な値は null（未設定）に倒す。
 */
export function parseTopPlacementPrice(value: unknown): number | null {
  return isValidTopPlacementPrice(value) ? (value as number) : null;
}

/**
 * トップ掲載料金の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定・null は未設定（null）として扱う。
 */
export function normalizeTopPlacementPrice(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (!isValidTopPlacementPrice(input)) {
    throw new Error(
      `トップ掲載の料金は${TOP_PLACEMENT_PRICE_MIN}円から${TOP_PLACEMENT_PRICE_MAX}円の整数で指定してください`,
    );
  }
  return input as number;
}

/** 保存済みのトップ掲載 ON/OFF を防御的に読む（読み取り用）。true のみ有効。 */
export function parseTopPlacementEnabled(value: unknown): boolean {
  return value === true;
}

/** ポータル（特設サイト本契約）の有効フラグ。true のときだけ有効に倒す。 */
export function parsePortalEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * トップ掲載 ON/OFF の入力を検証して正規化する（書き込み用）。
 * 未指定はオフ。それ以外の型は throw。
 */
export function normalizeTopPlacementEnabled(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input !== 'boolean') {
    throw new Error('トップ掲載の設定形式が不正です');
  }
  return input;
}

/** ランキングの最低レビュー件数として有効な値かどうか（1〜20 の整数）。 */
export function isValidRankingMinReviews(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_RANKING_MIN_REVIEWS
  );
}

/**
 * 保存済みの最低レビュー件数を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトや不正な値は DEFAULT_RANKING_MIN_REVIEWS に倒す。
 */
export function parseRankingMinReviews(value: unknown): number {
  return isValidRankingMinReviews(value)
    ? (value as number)
    : DEFAULT_RANKING_MIN_REVIEWS;
}

/** レビューの項目別評価の項目数の下限・上限（件）。 */
export const REVIEW_CATEGORY_MIN_COUNT = 1;
export const REVIEW_CATEGORY_MAX_COUNT = 6;
/** レビューの項目別評価の項目名の最大文字数。 */
export const REVIEW_CATEGORY_LABEL_MAX_LENGTH = 10;
/**
 * レビューの項目別評価の既定の項目（従来の固定4項目）。
 * 主催者が項目を変えていないプロジェクトはこの並びになる。
 */
export const DEFAULT_REVIEW_CATEGORIES: string[] = [
  '味',
  '接客',
  '雰囲気',
  '盛り付け',
];

/**
 * レビューの項目別評価の項目として有効な値かどうか。
 * 1〜6件の配列で、各項目名は前後の空白を除いて1〜10文字、重複なし。
 */
export function isValidReviewCategories(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  if (
    value.length < REVIEW_CATEGORY_MIN_COUNT ||
    value.length > REVIEW_CATEGORY_MAX_COUNT
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return false;
    const label = item.trim();
    if (!label || label.length > REVIEW_CATEGORY_LABEL_MAX_LENGTH) {
      return false;
    }
    if (seen.has(label)) return false;
    seen.add(label);
  }
  return true;
}

/**
 * 保存済みのレビュー項目を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトや不正な値は既定の4項目に倒す。
 * 有効な値は前後の空白を落とした新しい配列で返す。
 */
export function parseReviewCategories(value: unknown): string[] {
  if (!isValidReviewCategories(value)) return [...DEFAULT_REVIEW_CATEGORIES];
  return (value as string[]).map((label) => label.trim());
}

/**
 * レビュー項目の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定は既定の4項目。前後の空白は落とす。
 */
export function normalizeReviewCategories(input: unknown): string[] {
  if (input === undefined || input === null) {
    return [...DEFAULT_REVIEW_CATEGORIES];
  }
  if (!isValidReviewCategories(input)) {
    throw new Error(
      `レビューの項目は${REVIEW_CATEGORY_MIN_COUNT}〜${REVIEW_CATEGORY_MAX_COUNT}件で、各項目${REVIEW_CATEGORY_LABEL_MAX_LENGTH}文字以内・重複なしで指定してください`,
    );
  }
  return (input as string[]).map((label) => label.trim());
}

/** ログインボーナスの達成日数の下限・上限（連続日数）。 */
export const LOGIN_BONUS_DAYS_MIN = 5;
export const LOGIN_BONUS_DAYS_MAX = 20;
/** ログインボーナスの達成日数の既定値（主催者が未設定のプロジェクト）。 */
export const DEFAULT_LOGIN_BONUS_DAYS = 7;

/** ログインボーナス ON/OFF を防御的に読む（読み取り用）。true のみ有効。 */
export function parseLoginBonusEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * ログインボーナス ON/OFF の入力を検証して正規化する（書き込み用）。
 * 未指定はオフ。それ以外の型は throw。
 */
export function normalizeLoginBonusEnabled(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input !== 'boolean') {
    throw new Error('ログインボーナスの設定形式が不正です');
  }
  return input;
}

/** ログインボーナスの達成日数として有効な値かどうか（5〜20 の整数）。 */
export function isValidLoginBonusDays(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= LOGIN_BONUS_DAYS_MIN &&
    value <= LOGIN_BONUS_DAYS_MAX
  );
}

/**
 * 保存済みの達成日数を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトや不正な値は DEFAULT_LOGIN_BONUS_DAYS に倒す。
 */
export function parseLoginBonusDays(value: unknown): number {
  return isValidLoginBonusDays(value)
    ? (value as number)
    : DEFAULT_LOGIN_BONUS_DAYS;
}

/** 広告の掲載枠数の上限。 */
export const MAX_AD_SLOTS = 50;
/** 広告の掲載枠数の既定値（主催者が未設定のプロジェクト）。 */
export const DEFAULT_AD_SLOTS = 5;

/** 広告 ON/OFF を防御的に読む（読み取り用）。true のみ有効。 */
export function parseAdsEnabled(value: unknown): boolean {
  return value === true;
}

/**
 * 広告 ON/OFF の入力を検証して正規化する（書き込み用）。
 * 未指定はオフ。それ以外の型は throw。
 */
export function normalizeAdsEnabled(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input !== 'boolean') {
    throw new Error('広告の設定形式が不正です');
  }
  return input;
}

/** 広告の掲載枠数として有効な値かどうか（1〜MAX_AD_SLOTS の整数）。 */
export function isValidAdsSlots(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_AD_SLOTS
  );
}

/**
 * 保存済みの掲載枠数を防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧プロジェクトや不正な値は DEFAULT_AD_SLOTS に倒す。
 */
export function parseAdsSlots(value: unknown): number {
  return isValidAdsSlots(value) ? (value as number) : DEFAULT_AD_SLOTS;
}

/**
 * 広告の掲載枠数の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定は既定値。
 */
export function normalizeAdsSlots(input: unknown): number {
  if (input === undefined || input === null) return DEFAULT_AD_SLOTS;
  if (!isValidAdsSlots(input)) {
    throw new Error(
      `広告の枠数は1から${MAX_AD_SLOTS}の整数で指定してください`,
    );
  }
  return input as number;
}

/** 広告の月額料金の下限・上限（円）。0 は無料（承認のみで掲載）。 */
export const ADS_PRICE_MIN = 0;
export const ADS_PRICE_MAX = 1_000_000;

/** 広告の月額料金として有効な値かどうか（0〜1,000,000 の整数）。 */
export function isValidAdsPrice(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= ADS_PRICE_MIN &&
    value <= ADS_PRICE_MAX
  );
}

/**
 * 保存済みの広告料金を防御的に読む（読み取り用。throw しない）。
 * 未設定・不正な値は null（未設定）に倒す。0（無料）はそのまま 0。
 */
export function parseAdsPrice(value: unknown): number | null {
  return isValidAdsPrice(value) ? (value as number) : null;
}

/**
 * 広告料金の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定・null は未設定（null）として扱う。0 は無料として有効。
 */
export function normalizeAdsPrice(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (!isValidAdsPrice(input)) {
    throw new Error(
      `広告の料金は${ADS_PRICE_MIN}円から${ADS_PRICE_MAX}円の整数で指定してください`,
    );
  }
  return input as number;
}

/** クーポン発行手数料（1件あたり）の下限・上限（円）。0 は無料。 */
export const COUPON_ISSUE_PRICE_MIN = 0;
export const COUPON_ISSUE_PRICE_MAX = 1_000_000;

/** クーポン発行手数料として有効な値かどうか（0〜1,000,000 の整数）。 */
export function isValidCouponIssuePrice(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= COUPON_ISSUE_PRICE_MIN &&
    value <= COUPON_ISSUE_PRICE_MAX
  );
}

/**
 * 保存済みのクーポン発行手数料を防御的に読む（読み取り用。throw しない）。
 * 未設定・不正な値は null（未設定＝無料）に倒す。0（無料）はそのまま 0。
 */
export function parseCouponIssuePrice(value: unknown): number | null {
  return isValidCouponIssuePrice(value) ? (value as number) : null;
}

/**
 * クーポン発行手数料の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定・null は未設定（null）として扱う。0 は無料として有効。
 */
export function normalizeCouponIssuePrice(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (!isValidCouponIssuePrice(input)) {
    throw new Error(
      `クーポン発行の料金は${COUPON_ISSUE_PRICE_MIN}円から${COUPON_ISSUE_PRICE_MAX}円の整数で指定してください`,
    );
  }
  return input as number;
}

/** プッシュ配信手数料（1回あたり）の下限・上限（円）。0 は無料。 */
export const PUSH_PRICE_MIN = 0;
export const PUSH_PRICE_MAX = 1_000_000;

/** プッシュ配信手数料として有効な値かどうか（0〜1,000,000 の整数）。 */
export function isValidPushPrice(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PUSH_PRICE_MIN &&
    value <= PUSH_PRICE_MAX
  );
}

/**
 * 保存済みのプッシュ配信手数料を防御的に読む（読み取り用。throw しない）。
 * 未設定・不正な値は null（未設定＝無料）に倒す。0（無料）はそのまま 0。
 */
export function parsePushPrice(value: unknown): number | null {
  return isValidPushPrice(value) ? (value as number) : null;
}

/**
 * プッシュ配信手数料の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定・null は未設定（null）として扱う。0 は無料として有効。
 */
export function normalizePushPrice(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (!isValidPushPrice(input)) {
    throw new Error(
      `プッシュ配信の料金は${PUSH_PRICE_MIN}円から${PUSH_PRICE_MAX}円の整数で指定してください`,
    );
  }
  return input as number;
}

/** 参加店の自己登録の月額料金の下限・上限（円）。0 は無料（支払いなしで登録完了）。 */
export const SHOP_MONTHLY_PRICE_MIN = 0;
export const SHOP_MONTHLY_PRICE_MAX = 1_000_000;

/** 参加店の自己登録の月額料金として有効な値かどうか（0〜1,000,000 の整数）。 */
export function isValidShopMonthlyPrice(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SHOP_MONTHLY_PRICE_MIN &&
    value <= SHOP_MONTHLY_PRICE_MAX
  );
}

/**
 * 保存済みの自己登録の月額料金を防御的に読む（読み取り用。throw しない）。
 * 未設定・不正な値は null（未設定＝自己登録を受け付けない）に倒す。
 * 0（無料）はそのまま 0。
 */
export function parseShopMonthlyPrice(value: unknown): number | null {
  return isValidShopMonthlyPrice(value) ? (value as number) : null;
}

/**
 * 自己登録の月額料金の入力を検証して正規化する（書き込み用。不正なら throw）。
 * 未指定・null は未設定（null）として扱う。0 は無料として有効。
 */
export function normalizeShopMonthlyPrice(input: unknown): number | null {
  if (input === undefined || input === null) return null;
  if (!isValidShopMonthlyPrice(input)) {
    throw new Error(
      `参加店の月額料金は${SHOP_MONTHLY_PRICE_MIN}円から${SHOP_MONTHLY_PRICE_MAX}円の整数で指定してください`,
    );
  }
  return input as number;
}

export type SubscriberUsageLevel = 'normal' | 'warning' | 'full';

/**
 * 購読者枠の使用状況（プロジェクトカードのインジケーター用）。
 * percent は 0–100 に丸め、level は 90%以上で warning、上限到達で full。
 */
export function subscriberUsage(
  count: number,
  cap: number,
): { percent: number; level: SubscriberUsageLevel } {
  if (cap <= 0) return { percent: 0, level: 'normal' };
  const ratio = count / cap;
  const percent = Math.min(100, Math.round(ratio * 100));
  const level: SubscriberUsageLevel = ratio >= 1 ? 'full' : ratio >= 0.9 ? 'warning' : 'normal';
  return { percent, level };
}
