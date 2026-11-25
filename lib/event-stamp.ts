// lib/event-stamp.ts
// Push-taro.スタンプラリー のスタンプラリー基盤（events/{eventId} 配下）。
//
// - stamps/{memberId}_{round}_{exhibitorId}: スタンプ記録。ドキュメントIDの
//   一意性で「1つの周では同じ店のスタンプは1つまで」を構造的に担保する。
//   取消しはドキュメントの削除で行い、残っているものだけが有効なスタンプ。
// - freeCoupons/{id}: 達成で発行される「好きな店で1回無料」クーポン。
//   どの参加店でも使える。クーポン枠（couponCap）の数には数えない
//   （あれは主催者が発行する通常クーポンの枠）。
// - 途中の特典（マイルストーン）も freeCoupons に発行する。達成特典とは
//   別枠で、クーポン側に milestoneCount の印を付け、1周につき各特典
//   1回だけ発行する（発行済み判定は印で引く）。
// - 周（ラリー1周）の現在位置は購読者ドキュメントの stampRound に持つ。
//   達成したら無料クーポンを発行し、stampRound を次周へ進める
//   （達成後も次の無料分へカウントが継続する）。
//
// 付与の鉄則: 判定はすべてサーバー側（この lib）で行う。方式は3つ:
// - shop-qr: 参加店セッションだけが押せる（主催者は押せない）。自店の
//   スタンプしか押せないのは ID の構造上自明。
// - placed-qr: お客さん本人が、スポットの stampCode（推測不能）で押す。
// - rotating: お客さん本人が、固定ディスプレイの回転QR（数秒ごとに
//   切り替わる署名つきコード）で押す。検証は lib/stamp-rotating.ts。
// どの方式でも、会員・周・重複の規則は共通の grantStamp に合流する。
// あわせて grantStamp では、チェックポイントごとの認証設定
// （stampMethods: 有効な方法だけ許可）と、プロジェクトの順番モード
// （sequentialStamps: 番号順にしか押せない）もここで実施する。
// 追加チェック（お客さんが読む方式だけに適用）もここで実施する:
// - GPSエリアチェック（gpsCheck）: 端末内で 50m 以内と判定した申告
//   （withinRange）が無い付与は拒否する。座標はサーバーに送られない。
// - 移動速度チェック（velocityCheck）: 直近の前回スタンプからの移動が
//   あり得ない速さなら拒否する。
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  EVENT_SUBCOLLECTIONS,
  jstDateString,
  parseStampBenefitText,
  parseStampMilestones,
  parseStampRewardType,
  type EventConfig,
  type StampMilestone,
  type StampRewardType,
} from './event';
import { getEvent } from './event-store';
import {
  EVENT_EXHIBITORS_COLLECTION,
  mapExhibitor,
  type EventExhibitor,
  type ExhibitorKind,
} from './event-coupon';
import { isValidStampCode } from './stamp-qr';
import { haversineMeters, type GeoPoint } from './geo';
import { parseShopProfile } from './event-shop';
import {
  parseRotatingCode,
  readExhibitorRotatingSecret,
  verifyRotatingCode,
} from './stamp-rotating';

// stamps / freeCoupons はリセット・終了削除の対象外（電話番号を含まない台帳）。
// EVENT_SUBCOLLECTIONS の4つとは分けて持つ（event-coupon.ts の exhibitors /
// coupons と同じ扱い）。プロジェクトの完全削除は listCollections で拾うため
// 対象に含まれる。
export const EVENT_STAMPS_COLLECTION = 'stamps';
export const EVENT_FREE_COUPONS_COLLECTION = 'freeCoupons';

/**
 * スタンプの付与方式。
 * - 'shop-qr': お客さんの QR をお店が読む（従来方式）
 * - 'placed-qr': チェックポイントに貼った場所 QR をお客さんが読む
 * - 'rotating': 固定ディスプレイの回転 QR をお客さんが読む
 * 方式の導入前に押されたスタンプには項目が無いため 'shop-qr' に倒す。
 */
export type StampMethod = 'shop-qr' | 'placed-qr' | 'rotating';

/** 保存済みの付与方式を防御的に読む（読み取り用）。未知・未設定は 'shop-qr'。 */
export function parseStampMethod(value: unknown): StampMethod {
  return value === 'placed-qr' || value === 'rotating' ? value : 'shop-qr';
}

export interface EventStamp {
  id: string;
  memberId: string;
  exhibitorId: string;
  exhibitorName: string;
  /** 何周目に押されたか（1始まり） */
  round: number;
  /** 押した日（JST, 'YYYY-MM-DD'）。取消し可否の判定に使う */
  grantedDateJst: string;
  grantedAt: string | null;
  /** 付与方式。導入前の旧レコードは 'shop-qr' として読む */
  method: StampMethod;
  /**
   * チェックポイントの種別（表示用）。スタンプ記録自体には持たず、
   * カード読み取り時に現在のチェックポイント情報から解決して付ける
   * （getStampCard）。解決できない場合は未設定。
   */
  exhibitorKind?: ExhibitorKind;
  /** チェックポイント番号（同上。番号なしは null） */
  checkpointNumber?: number | null;
}

/** 無料クーポンの発行元。スタンプ達成か、毎日ログインボーナスか。 */
export type FreeCouponKind = 'stamp' | 'login';

export interface StampFreeCoupon {
  id: string;
  memberId: string;
  /**
   * 発行元（'stamp' | 'login'）。ログインボーナス導入前に発行された
   * クーポンには項目が無いため 'stamp' に倒す。round の意味は発行元で
   * 変わる（stamp=ラリーの周、login=ログインのサイクル）。
   */
  kind: FreeCouponKind;
  /** 何周目／何サイクル目の達成で発行されたか */
  round: number;
  /**
   * 途中の特典（マイルストーン）として発行された場合の到達個数。
   * 達成特典・ログインボーナスのクーポンと、印の導入前に発行された
   * クーポンでは null。
   */
  milestoneCount: number | null;
  /**
   * 発行時点の特典の種類（スナップショット）。後からプロジェクト設定を
   * 変えても、発行済みクーポンの表示は変わらない。特典スナップショット
   * 導入前に発行されたクーポンには項目が無いため 'free-dish' に倒す。
   */
  rewardType: StampRewardType;
  /** 発行時点の特典の内容（スナップショット）。'free-dish' では空文字 */
  benefitText: string;
  status: 'active' | 'used';
  usedExhibitorId: string | null;
  usedExhibitorName: string | null;
}

export interface StampCard {
  memberId: string;
  /** 現在の周（1始まり） */
  round: number;
  goalCount: number;
  /**
   * プロジェクトの現在の特典設定（達成までの案内文の出し分け用）。
   * 発行済みクーポンの表示は各クーポンのスナップショットで決まる。
   */
  rewardType: StampRewardType;
  benefitText: string;
  /**
   * 途中の特典（マイルストーン）の設定（個数の昇順）。
   * 参加者画面の進み具合（次の特典まであと○個）の表示用。
   */
  milestones: StampMilestone[];
  /** 現在の周で集めたスタンプ数 */
  countInRound: number;
  /** 達成まであと何個か */
  remaining: number;
  /** 現在の周のスタンプ（押した順） */
  stamps: EventStamp[];
  /** 無料クーポン（新しい周の順） */
  freeCoupons: StampFreeCoupon[];
}

/** スタンプ記録のドキュメントID。周ごとに店が一意になるよう構成する。 */
export function stampIdFor(
  memberId: string,
  round: number,
  exhibitorId: string,
): string {
  return `${memberId}_${round}_${exhibitorId}`;
}

/** 周内のスタンプ数が達成個数に届いたかどうか（純粋関数）。 */
export function isRoundCompleted(countInRound: number, goalCount: number): boolean {
  return countInRound >= goalCount;
}

/** 発行するクーポンに写す特典スナップショット。 */
export interface StampRewardSnapshot {
  rewardType: StampRewardType;
  benefitText: string;
}

/**
 * 達成時に発行するクーポンへ写す特典スナップショットを作る（純粋関数）。
 * プロジェクトの現在の設定から切り取るため、発行後に設定を変えても
 * 発行済みクーポンの表示は変わらない。'free-dish' では内容は空にする
 * （種類を戻したとき用に設定側に残っている文面を写さない）。
 */
export function buildStampRewardSnapshot(
  event: Pick<EventConfig, 'stampRewardType' | 'stampBenefitText'>,
): StampRewardSnapshot {
  if (event.stampRewardType === 'benefit') {
    return { rewardType: 'benefit', benefitText: event.stampBenefitText };
  }
  return { rewardType: 'free-dish', benefitText: '' };
}

/**
 * 現在の周を解決する（純粋関数）。
 * 通常は購読者に保存された stampRound が正。ただし stampRound を持たない
 * 旧購読者（導入前の登録）では、スタンプの実績から復元する:
 * 最も大きい周が達成済みならその次の周、未達成ならその周。
 */
export function resolveCurrentRound(
  storedRound: unknown,
  stampRounds: number[],
  goalCount: number,
): number {
  if (
    typeof storedRound === 'number' &&
    Number.isInteger(storedRound) &&
    storedRound >= 1
  ) {
    return storedRound;
  }
  if (stampRounds.length === 0) return 1;
  const maxRound = Math.max(...stampRounds);
  const countInMax = stampRounds.filter((r) => r === maxRound).length;
  return isRoundCompleted(countInMax, goalCount) ? maxRound + 1 : maxRound;
}

export type StampCancelRejection =
  | 'not-owner'
  | 'not-current-round'
  | 'not-today';

export type StampCancelDecision =
  | { allowed: true }
  | { allowed: false; reason: StampCancelRejection };

/**
 * スタンプ取消しの可否（純粋関数）。
 * 取り消せるのは「自店が」「当日（JST）に」「現在の周で」押したスタンプだけ。
 * 過去の周のスタンプは、達成済みでも未達成でも取り消せない。
 */
export function evaluateStampCancel(
  stamp: Pick<EventStamp, 'exhibitorId' | 'round' | 'grantedDateJst'>,
  actorExhibitorId: string,
  currentRound: number,
  todayJst: string,
): StampCancelDecision {
  if (stamp.exhibitorId !== actorExhibitorId) {
    return { allowed: false, reason: 'not-owner' };
  }
  if (stamp.round !== currentRound) {
    return { allowed: false, reason: 'not-current-round' };
  }
  if (stamp.grantedDateJst !== todayJst) {
    return { allowed: false, reason: 'not-today' };
  }
  return { allowed: true };
}

/** 順番モードの判定に使うチェックポイント（番号つき判定用）。 */
export interface SequentialCheckpoint {
  exhibitorId: string;
  checkpointNumber: number | null;
}

export type SequentialStampDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: 'no-number' | 'not-next';
      /** 次に押せるチェックポイントの番号（残りが無ければ null） */
      nextNumber: number | null;
    };

/**
 * 順番モードでの付与可否（純粋関数）。
 * 「次」は、現在の周でまだ押されていない番号付きチェックポイントの
 * うち最小の番号。押そうとするチェックポイントの番号がそれと一致
 * するときだけ許可する。番号のないチェックポイントは対象外。
 */
export function evaluateSequentialStamp(input: {
  checkpoints: SequentialCheckpoint[];
  /** 現在の周で既に押されているチェックポイントの ID 集合 */
  stampedExhibitorIds: ReadonlySet<string>;
  targetExhibitorId: string;
}): SequentialStampDecision {
  const numbered = input.checkpoints
    .filter(
      (
        checkpoint,
      ): checkpoint is SequentialCheckpoint & { checkpointNumber: number } =>
        checkpoint.checkpointNumber !== null,
    )
    .sort((a, b) => a.checkpointNumber - b.checkpointNumber);
  const stampedNumbers = new Set(
    numbered
      .filter((checkpoint) =>
        input.stampedExhibitorIds.has(checkpoint.exhibitorId),
      )
      .map((checkpoint) => checkpoint.checkpointNumber),
  );
  const next = numbered.find(
    (checkpoint) => !stampedNumbers.has(checkpoint.checkpointNumber),
  );
  const nextNumber = next ? next.checkpointNumber : null;
  const target = input.checkpoints.find(
    (checkpoint) => checkpoint.exhibitorId === input.targetExhibitorId,
  );
  if (!target || target.checkpointNumber === null) {
    return { allowed: false, reason: 'no-number', nextNumber };
  }
  if (target.checkpointNumber !== nextNumber) {
    return { allowed: false, reason: 'not-next', nextNumber };
  }
  return { allowed: true };
}

// ─── 移動速度チェック ───

/**
 * 移動速度チェックの上限（km/h）。これを超える移動は現実にはあり得ない
 * ものとして拒否する。写真をまとめて読む不正は数千 km/h 相当になる。
 * 通常の徒歩・自転車・車の移動では到達しない値に置く。
 */
export const MAX_STAMP_SPEED_KMH = 120;

export type StampVelocityDecision = { allowed: true } | { allowed: false };

/**
 * 移動速度チェックの判定（純粋関数）。
 * 直近の前回スタンプ（別チェックポイント）の場所・時刻と、今回の
 * チェックポイントの場所・現在時刻から移動速度を出す。
 * どちらかの座標が無い・前回スタンプが無い場合は判定できないため通す。
 */
export function evaluateStampVelocity(input: {
  previousLocation: GeoPoint | null;
  previousAtMs: number | null;
  currentLocation: GeoPoint | null;
  nowMs: number;
}): StampVelocityDecision {
  if (!input.previousLocation || !input.currentLocation) {
    return { allowed: true };
  }
  if (input.previousAtMs === null) return { allowed: true };
  const distanceMeters = haversineMeters(
    input.previousLocation,
    input.currentLocation,
  );
  const elapsedMs = input.nowMs - input.previousAtMs;
  if (elapsedMs <= 0) {
    // 同時刻（または時計の巻き戻り）: 実質同じ場所なら問題なし
    return { allowed: distanceMeters <= 50 };
  }
  const speedKmh = distanceMeters / 1000 / (elapsedMs / 3_600_000);
  return { allowed: speedKmh <= MAX_STAMP_SPEED_KMH };
}

/**
 * スタンプ記録の grantedAt をミリ秒に直す（読み取り用）。
 * Firestore の Timestamp（toDate）・Date・数値・ISO文字列に対応し、
 * 解釈できないものは null。
 */
export function grantedAtMillis(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (typeof value === 'object') {
    const toDate = (value as { toDate?: unknown }).toDate;
    if (typeof toDate === 'function') {
      const date = (toDate as () => Date).call(value);
      return date instanceof Date ? date.getTime() : null;
    }
  }
  return null;
}

// ─── Firestore 読み書き ───

function stampsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_STAMPS_COLLECTION);
}

function freeCouponsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_FREE_COUPONS_COLLECTION);
}

function subscriberRef(db: Firestore, eventId: string, memberId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_SUBCOLLECTIONS.subscribers)
    .doc(memberId);
}

function mapStamp(
  id: string,
  data: FirebaseFirestore.DocumentData,
): EventStamp {
  const grantedAt = data.grantedAt as
    | { toDate?: () => Date }
    | undefined;
  return {
    id,
    memberId: String(data.memberId ?? ''),
    exhibitorId: String(data.exhibitorId ?? ''),
    exhibitorName: String(data.exhibitorName ?? ''),
    round: typeof data.round === 'number' ? data.round : 0,
    grantedDateJst: String(data.grantedDateJst ?? ''),
    grantedAt: grantedAt?.toDate?.().toISOString() ?? null,
    method: parseStampMethod(data.method),
  };
}

function mapFreeCoupon(
  id: string,
  data: FirebaseFirestore.DocumentData,
): StampFreeCoupon {
  return {
    id,
    memberId: String(data.memberId ?? ''),
    // ログインボーナス導入前のクーポンには項目が無いため 'stamp' に倒す
    kind: data.kind === 'login' ? 'login' : 'stamp',
    round: typeof data.round === 'number' ? data.round : 0,
    // 途中の特典の印。達成特典など印が無いクーポンは null
    milestoneCount:
      typeof data.milestoneCount === 'number' ? data.milestoneCount : null,
    // スナップショット導入前のクーポンには項目が無いため従来種別に倒す
    rewardType: parseStampRewardType(data.rewardType),
    benefitText: parseStampBenefitText(data.benefitText),
    status: data.status === 'used' ? 'used' : 'active',
    usedExhibitorId:
      typeof data.usedExhibitorId === 'string' ? data.usedExhibitorId : null,
    usedExhibitorName:
      typeof data.usedExhibitorName === 'string'
        ? data.usedExhibitorName
        : null,
  };
}

// ─── 付与 ───

export type GrantStampResult =
  | {
      ok: true;
      stampId: string;
      /** 押されたスポット（参加店） */
      exhibitorId: string;
      exhibitorName: string;
      /** スタンプが属する周 */
      round: number;
      /** その周で集めた数（今回を含む） */
      countInRound: number;
      goalCount: number;
      /** 今回で達成したか（無料クーポン発行済み） */
      completed: boolean;
      freeCouponId: string | null;
      /** 今回発行した途中の特典（マイルストーン）のクーポンID群 */
      milestoneFreeCouponIds: string[];
      /** 発行したクーポンの特典スナップショット（未達成でも現在の設定を返す） */
      rewardType: StampRewardType;
      benefitText: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      /**
       * 画面側が文言を出し分けるための機械可読コード。
       * 'gps-check-failed' = GPSエリアチェックの申告なし、
       * 'too-fast' = 移動速度チェックで拒否。
       */
      code?: string;
      /** 順番モードで順番違いのとき、次に押せるチェックポイントの番号 */
      nextCheckpointNumber?: number | null;
    };

/**
 * スタンプを1つ付与する。購読者でない人には押せない（404）。
 * 現在の周で同じ店のスタンプが既にあれば 409（二重押し防止は
 * ドキュメントIDの一意性でも担保される）。
 * 達成したら無料クーポンを発行し、購読者の stampRound を次周へ進める。
 */
export async function grantStamp(
  db: Firestore,
  input: {
    eventId: string;
    exhibitor: EventExhibitor;
    memberId: string;
    /** 付与方式。未指定は従来方式（お店が客の QR を読む） */
    method?: StampMethod;
    /**
     * GPSエリアチェックの申告: お客さんの端末が「スポットから50m以内」
     * と端末内で判定した結果。座標そのものは受け取らない。
     * gpsCheck が有効なチェックポイントでは、この申告が無い付与を拒否する。
     */
    withinRange?: boolean;
    now?: Date;
  },
): Promise<GrantStampResult> {
  // 協賛（広告専用）アカウントはスタンプを押せない
  if (input.exhibitor.kind === 'advertiser') {
    return {
      ok: false,
      status: 403,
      error: '協賛アカウントはスタンプを押せません',
    };
  }
  // 認証設定の実施: そのチェックポイントで有効な方法でだけ押せる。
  const method = input.method ?? 'shop-qr';
  if (method === 'shop-qr' && !input.exhibitor.stampMethods.includes('staff')) {
    return {
      ok: false,
      status: 403,
      error: 'このチェックポイントでは、お店での読み取りは有効になっていません',
    };
  }
  if (method === 'placed-qr' && !input.exhibitor.stampMethods.includes('placed')) {
    return {
      ok: false,
      status: 403,
      error: 'このチェックポイントでは、置きQRは有効になっていません',
    };
  }
  if (method === 'rotating' && !input.exhibitor.stampMethods.includes('rotating')) {
    return {
      ok: false,
      status: 403,
      error: 'このチェックポイントでは、回転QRは有効になっていません',
    };
  }
  // GPSエリアチェックの実施: お客さんが読む方式で、チェックが有効な
  // チェックポイントでは「50m以内」の端末申告が無い付与を拒否する。
  if (
    method !== 'shop-qr' &&
    input.exhibitor.gpsCheck &&
    input.withinRange !== true
  ) {
    return {
      ok: false,
      status: 403,
      code: 'gps-check-failed',
      error: 'スポットの近くで読み込んでください（位置情報の確認ができませんでした）',
    };
  }
  const event = await getEvent(input.eventId);
  if (!event) {
    return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  }
  if (event.status !== 'live') {
    return {
      ok: false,
      status: 403,
      error: 'このプロジェクトは現在スタンプを受け付けていません',
    };
  }
  // 順番モードの実施に使うチェックポイント一覧（番号の判定用）。
  // モードがオフの間は読まない。
  let sequentialCheckpoints: SequentialCheckpoint[] | null = null;
  if (event.sequentialStamps) {
    const snap = await exhibitorsRef(db, input.eventId).get();
    sequentialCheckpoints = snap.docs
      .map((doc) => mapExhibitor(doc.id, doc.data()))
      .filter((e) => e.kind !== 'advertiser' && !e.closedAt)
      .map((e) => ({
        exhibitorId: e.id,
        checkpointNumber: e.checkpointNumber,
      }));
  }
  const goalCount = event.stampGoalCount;
  const today = jstDateString(input.now ?? new Date());
  const memberStampsRef = stampsRef(db, input.eventId);
  const subRef = subscriberRef(db, input.eventId, input.memberId);

  return db.runTransaction(async (tx) => {
    const subscriberSnap = await tx.get(subRef);
    if (!subscriberSnap.exists) {
      return {
        ok: false,
        status: 404,
        error: '登録が見つかりません',
      } as GrantStampResult;
    }
    const allStampsSnap = await tx.get(
      memberStampsRef.where('memberId', '==', input.memberId),
    );
    const stampRounds = allStampsSnap.docs
      .map((doc) => Number(doc.data().round ?? 0))
      .filter((r) => Number.isInteger(r) && r >= 1);
    const round = resolveCurrentRound(
      subscriberSnap.data()?.stampRound,
      stampRounds,
      goalCount,
    );
    const stampId = stampIdFor(input.memberId, round, input.exhibitor.id);
    const stampRef = memberStampsRef.doc(stampId);
    const stampSnap = await tx.get(stampRef);
    if (stampSnap.exists) {
      return {
        ok: false,
        status: 409,
        error: 'この周では、すでにこのお店のスタンプを押しています',
      } as GrantStampResult;
    }

    // 順番モード: 番号順にしか押せない（番号なしは対象外）。
    if (sequentialCheckpoints) {
      const stampedExhibitorIds = new Set(
        allStampsSnap.docs
          .filter((doc) => Number(doc.data().round ?? 0) === round)
          .map((doc) => String(doc.data().exhibitorId ?? '')),
      );
      const decision = evaluateSequentialStamp({
        checkpoints: sequentialCheckpoints,
        stampedExhibitorIds,
        targetExhibitorId: input.exhibitor.id,
      });
      if (!decision.allowed) {
        return {
          ok: false,
          status: decision.reason === 'no-number' ? 403 : 409,
          error:
            decision.reason === 'no-number'
              ? 'このチェックポイントは順番モードの対象外です（番号が設定されていません）'
              : `順番が違います。次は${decision.nextNumber}番のチェックポイントです`,
          nextCheckpointNumber: decision.nextNumber,
        } as GrantStampResult;
      }
    }

    // 移動速度チェック: お客さんが読む方式で、チェックが有効な
    // チェックポイントだけに適用する（店読み取りには適用しない）。
    // 直近の前回スタンプ（別チェックポイント）からの移動があり得ない
    // 速さなら拒否する。座標が無い・前回が無い場合は判定できないため通す。
    if (method !== 'shop-qr' && input.exhibitor.velocityCheck) {
      let previous: { exhibitorId: string; atMs: number } | null = null;
      for (const doc of allStampsSnap.docs) {
        const data = doc.data();
        const prevExhibitorId = String(data.exhibitorId ?? '');
        if (!prevExhibitorId || prevExhibitorId === input.exhibitor.id) {
          continue;
        }
        const atMs = grantedAtMillis(data.grantedAt);
        if (atMs === null) continue;
        if (!previous || atMs > previous.atMs) {
          previous = { exhibitorId: prevExhibitorId, atMs };
        }
      }
      if (previous) {
        const [currentSnap, previousSnap] = await Promise.all([
          tx.get(exhibitorsRef(db, input.eventId).doc(input.exhibitor.id)),
          tx.get(exhibitorsRef(db, input.eventId).doc(previous.exhibitorId)),
        ]);
        const decision = evaluateStampVelocity({
          previousLocation: checkpointLocationFromData(previousSnap.data()),
          previousAtMs: previous.atMs,
          currentLocation: checkpointLocationFromData(currentSnap.data()),
          nowMs: (input.now ?? new Date()).getTime(),
        });
        if (!decision.allowed) {
          return {
            ok: false,
            status: 403,
            code: 'too-fast',
            error: '移動が速すぎるため、このスタンプは付けられませんでした',
          } as GrantStampResult;
        }
      }
    }

    const countInRound =
      stampRounds.filter((r) => r === round).length + 1;
    const completed = isRoundCompleted(countInRound, goalCount);

    // 途中の特典（マイルストーン）: 今ラウンドの個数が設定個数に到達した
    // 特典を、達成特典とは別枠で発行する。各特典は1周につき1人1回だけ。
    // 発行済み判定は、この周で印（milestoneCount）つきで発行された
    // クーポンの有無で行う（トランザクション内の読み取りなので、
    // 再実行・競合でも二重発行しない）。読み取りは書き込みより前に行う。
    const milestones = parseStampMilestones(event.stampMilestones);
    const dueMilestones = milestones.filter((m) => m.count <= countInRound);
    const issuedMilestoneCounts = new Set<number>();
    if (dueMilestones.length > 0) {
      const freeSnap = await tx.get(
        freeCouponsRef(db, input.eventId).where(
          'memberId',
          '==',
          input.memberId,
        ),
      );
      for (const doc of freeSnap.docs) {
        const data = doc.data();
        if (
          data.round === round &&
          typeof data.milestoneCount === 'number'
        ) {
          issuedMilestoneCounts.add(data.milestoneCount);
        }
      }
    }

    tx.set(stampRef, {
      memberId: input.memberId,
      exhibitorId: input.exhibitor.id,
      exhibitorName: input.exhibitor.name,
      round,
      method: input.method ?? 'shop-qr',
      grantedAt: FieldValue.serverTimestamp(),
      grantedDateJst: today,
    });

    const reward = buildStampRewardSnapshot(event);
    const milestoneFreeCouponIds: string[] = [];
    for (const milestone of dueMilestones) {
      if (issuedMilestoneCounts.has(milestone.count)) continue;
      const milestoneRef = freeCouponsRef(db, input.eventId).doc();
      milestoneFreeCouponIds.push(milestoneRef.id);
      tx.set(milestoneRef, {
        memberId: input.memberId,
        kind: 'stamp',
        round,
        // 途中の特典の印（到達個数）。達成特典のクーポンには付けない
        milestoneCount: milestone.count,
        // 特典は達成特典と同じく発行時点のスナップショットで固定する
        ...buildStampRewardSnapshot({
          stampRewardType: milestone.rewardType,
          stampBenefitText: milestone.benefitText,
        }),
        status: 'active',
        issuedAt: FieldValue.serverTimestamp(),
      });
    }
    let freeCouponId: string | null = null;
    if (completed) {
      const freeRef = freeCouponsRef(db, input.eventId).doc();
      freeCouponId = freeRef.id;
      tx.set(freeRef, {
        memberId: input.memberId,
        kind: 'stamp',
        round,
        // 特典は発行時点のスナップショットで固定する
        rewardType: reward.rewardType,
        benefitText: reward.benefitText,
        status: 'active',
        issuedAt: FieldValue.serverTimestamp(),
      });
      tx.update(subRef, {
        stampRound: round + 1,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else if (subscriberSnap.data()?.stampRound !== round) {
      // stampRound を持たない旧購読者には、解決した周を書き戻しておく
      tx.update(subRef, {
        stampRound: round,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    return {
      ok: true,
      stampId,
      exhibitorId: input.exhibitor.id,
      exhibitorName: input.exhibitor.name,
      round,
      countInRound,
      goalCount,
      completed,
      freeCouponId,
      milestoneFreeCouponIds,
      rewardType: reward.rewardType,
      benefitText: reward.benefitText,
    } as GrantStampResult;
  });
}

// ─── 場所QR・回転QR（お客さん本人からの付与） ───

function exhibitorsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION);
}

/**
 * チェックポイントの座標を exhibitor ドキュメントのデータから読む。
 * 座標は店舗プロフィールの location（住所からジオコーディング済み）が正。
 * プロフィールが無い・座標が無いチェックポイントは null。
 */
function checkpointLocationFromData(
  data: FirebaseFirestore.DocumentData | undefined,
): GeoPoint | null {
  if (!data) return null;
  return parseShopProfile(data.profile).location;
}

/** スポットとして使えない参加店（閉店・掲載停止）のガード。 */
function grantableSpotError(
  exhibitor: EventExhibitor,
): { status: number; error: string } | null {
  if (exhibitor.closedAt) {
    return { status: 404, error: 'スポットが見つかりません' };
  }
  if (exhibitor.delistedAt) {
    return {
      status: 403,
      error: 'このスポットは現在スタンプを受け付けていません',
    };
  }
  return null;
}

/** stampCode からチェックポイントを引く。見つからなければ null。 */
async function findExhibitorByStampCode(
  db: Firestore,
  eventId: string,
  stampCode: string,
): Promise<EventExhibitor | null> {
  const snap = await exhibitorsRef(db, eventId)
    .where('stampCode', '==', stampCode)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return mapExhibitor(snap.docs[0].id, snap.docs[0].data());
}

/**
 * 場所QR方式の付与。stampCode からスポットを特定し、共通の grantStamp に
 * 合流する。コードの形式が不正なら照合自体を行わない。
 */
export async function grantStampByPlacedQr(
  db: Firestore,
  input: {
    eventId: string;
    memberId: string;
    stampCode: unknown;
    /** GPSエリアチェックの端末申告（50m以内） */
    withinRange?: boolean;
  },
): Promise<GrantStampResult> {
  if (!isValidStampCode(input.stampCode)) {
    return {
      ok: false,
      status: 400,
      error: 'QRコードが正しくありません',
    };
  }
  const exhibitor = await findExhibitorByStampCode(
    db,
    input.eventId,
    input.stampCode,
  );
  if (!exhibitor) {
    return {
      ok: false,
      status: 404,
      error: 'このQRコードのスポットが見つかりません',
    };
  }
  const spotError = grantableSpotError(exhibitor);
  if (spotError) return { ok: false, ...spotError };
  return grantStamp(db, {
    eventId: input.eventId,
    exhibitor,
    memberId: input.memberId,
    method: 'placed-qr',
    withinRange: input.withinRange,
  });
}

/**
 * お客さんが読む方式の事前情報。参加者画面が付与の前に呼び、
 * GPSエリアチェックが必要かどうかと、端末内判定に使う座標を得る。
 * 座標はチェックが必要な場合だけ返す（判定以外に使わない）。
 */
export interface CheckpointScanInfo {
  exhibitorId: string;
  exhibitorName: string;
  kind: ExhibitorKind;
  gpsCheck: boolean;
  location: GeoPoint | null;
}

export type CheckpointScanInfoResult =
  | { ok: true; info: CheckpointScanInfo }
  | { ok: false; status: number; error: string };

async function buildScanInfo(
  db: Firestore,
  eventId: string,
  exhibitor: EventExhibitor,
): Promise<CheckpointScanInfo> {
  let location: GeoPoint | null = null;
  if (exhibitor.gpsCheck) {
    const snap = await exhibitorsRef(db, eventId).doc(exhibitor.id).get();
    location = checkpointLocationFromData(
      snap.exists ? snap.data() : undefined,
    );
  }
  return {
    exhibitorId: exhibitor.id,
    exhibitorName: exhibitor.name,
    kind: exhibitor.kind,
    gpsCheck: exhibitor.gpsCheck,
    location,
  };
}

/** 場所QRの事前情報。 */
export async function getPlacedQrCheckpointInfo(
  db: Firestore,
  input: { eventId: string; stampCode: unknown },
): Promise<CheckpointScanInfoResult> {
  if (!isValidStampCode(input.stampCode)) {
    return { ok: false, status: 400, error: 'QRコードが正しくありません' };
  }
  const exhibitor = await findExhibitorByStampCode(
    db,
    input.eventId,
    input.stampCode,
  );
  if (!exhibitor) {
    return {
      ok: false,
      status: 404,
      error: 'このQRコードのスポットが見つかりません',
    };
  }
  const spotError = grantableSpotError(exhibitor);
  if (spotError) return { ok: false, ...spotError };
  return { ok: true, info: await buildScanInfo(db, input.eventId, exhibitor) };
}

/**
 * 回転QRのコードを検証し、対象チェックポイントを解決する。
 * 署名・鮮度が不正なコードはすべて同じエラーに倒す（詳細を漏らさない）。
 */
async function resolveRotatingExhibitor(
  db: Firestore,
  eventId: string,
  token: unknown,
  nowMs: number,
): Promise<
  | { ok: true; exhibitor: EventExhibitor }
  | { ok: false; status: number; error: string }
> {
  const parsed = parseRotatingCode(token);
  if (!parsed) {
    return { ok: false, status: 400, error: 'QRコードが正しくありません' };
  }
  const snap = await exhibitorsRef(db, eventId).doc(parsed.exhibitorId).get();
  if (!snap.exists) {
    return {
      ok: false,
      status: 404,
      error: 'このQRコードのスポットが見つかりません',
    };
  }
  const exhibitor = mapExhibitor(snap.id, snap.data()!);
  const spotError = grantableSpotError(exhibitor);
  if (spotError) return { ok: false, ...spotError };
  const secret = await readExhibitorRotatingSecret(db, eventId, exhibitor.id);
  if (!secret || !verifyRotatingCode(secret, eventId, token, nowMs)) {
    return {
      ok: false,
      status: 400,
      error: 'QRコードの有効期限が切れています。画面の新しいコードを読み込んでください',
    };
  }
  return { ok: true, exhibitor };
}

/** 回転QRの事前情報。 */
export async function getRotatingCheckpointInfo(
  db: Firestore,
  input: { eventId: string; token: unknown; now?: Date },
): Promise<CheckpointScanInfoResult> {
  const resolved = await resolveRotatingExhibitor(
    db,
    input.eventId,
    input.token,
    (input.now ?? new Date()).getTime(),
  );
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    info: await buildScanInfo(db, input.eventId, resolved.exhibitor),
  };
}

/**
 * 回転QR方式の付与。コードの署名と鮮度を検証してから、共通の
 * grantStamp に合流する（方法の許可・追加チェックも grantStamp 側）。
 */
export async function grantStampByRotatingQr(
  db: Firestore,
  input: {
    eventId: string;
    memberId: string;
    token: unknown;
    /** GPSエリアチェックの端末申告（50m以内） */
    withinRange?: boolean;
    now?: Date;
  },
): Promise<GrantStampResult> {
  const now = input.now ?? new Date();
  const resolved = await resolveRotatingExhibitor(
    db,
    input.eventId,
    input.token,
    now.getTime(),
  );
  if (!resolved.ok) return resolved;
  return grantStamp(db, {
    eventId: input.eventId,
    exhibitor: resolved.exhibitor,
    memberId: input.memberId,
    method: 'rotating',
    withinRange: input.withinRange,
    now,
  });
}

// ─── 取消し ───

export type CancelStampResult =
  | { ok: true; stampId: string }
  | { ok: false; status: number; error: string };

const CANCEL_ERRORS: Record<
  StampCancelRejection,
  { status: number; error: string }
> = {
  'not-owner': { status: 403, error: '自店のスタンプだけ取り消せます' },
  'not-current-round': {
    status: 409,
    error: '過去の周のスタンプは取り消せません',
  },
  'not-today': {
    status: 409,
    error: '取り消せるのは当日に押したスタンプだけです',
  },
};

/**
 * スタンプを取り消す（押し間違い対応）。条件は evaluateStampCancel のとおり
 * （自店・当日・現在の周のみ）。取り消しはドキュメントの削除。
 * 達成済みの周のスタンプは「現在の周」ではないため、ここでは消せない
 * （発行済みの無料クーポンと不整合にならない）。
 */
export async function cancelStamp(
  db: Firestore,
  input: {
    eventId: string;
    exhibitor: EventExhibitor;
    stampId: string;
    now?: Date;
  },
): Promise<CancelStampResult> {
  const event = await getEvent(input.eventId);
  if (!event) {
    return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  }
  const today = jstDateString(input.now ?? new Date());
  const memberStampsRef = stampsRef(db, input.eventId);
  const stampRef = memberStampsRef.doc(input.stampId);

  return db.runTransaction(async (tx) => {
    const stampSnap = await tx.get(stampRef);
    if (!stampSnap.exists) {
      return {
        ok: false,
        status: 404,
        error: 'スタンプが見つかりません',
      } as CancelStampResult;
    }
    const stamp = mapStamp(stampSnap.id, stampSnap.data()!);
    const subRef = subscriberRef(db, input.eventId, stamp.memberId);
    const [subscriberSnap, allStampsSnap] = await Promise.all([
      tx.get(subRef),
      tx.get(memberStampsRef.where('memberId', '==', stamp.memberId)),
    ]);
    const stampRounds = allStampsSnap.docs
      .map((doc) => Number(doc.data().round ?? 0))
      .filter((r) => Number.isInteger(r) && r >= 1);
    const currentRound = resolveCurrentRound(
      subscriberSnap.exists ? subscriberSnap.data()?.stampRound : undefined,
      stampRounds,
      event.stampGoalCount,
    );
    const decision = evaluateStampCancel(
      stamp,
      input.exhibitor.id,
      currentRound,
      today,
    );
    if (!decision.allowed) {
      const response = CANCEL_ERRORS[decision.reason];
      return {
        ok: false,
        status: response.status,
        error: response.error,
      } as CancelStampResult;
    }    tx.delete(stampRef);
    return { ok: true, stampId: input.stampId } as CancelStampResult;
  });
}

// ─── 一覧・カード ───

/** 参加店が当日に押したスタンプ（取消し UI 用。新しい順）。 */
export async function listTodayStampsByExhibitor(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  now?: Date,
): Promise<EventStamp[]> {
  const today = jstDateString(now ?? new Date());
  const snap = await stampsRef(db, eventId)
    .where('exhibitorId', '==', exhibitorId)
    .where('grantedDateJst', '==', today)
    .get();
  return snap.docs
    .map((doc) => mapStamp(doc.id, doc.data()))
    .sort((a, b) => (b.grantedAt ?? '').localeCompare(a.grantedAt ?? ''));
}

/**
 * 来場者本人のスタンプカード表示データ。
 * 購読者でなければ null（画面には何も出さない）。
 */
export async function getStampCard(
  db: Firestore,
  eventId: string,
  memberId: string,
): Promise<StampCard | null> {
  const event = await getEvent(eventId);
  if (!event) return null;
  const subSnap = await subscriberRef(db, eventId, memberId).get();
  if (!subSnap.exists) return null;

  const stampsSnap = await stampsRef(db, eventId)
    .where('memberId', '==', memberId)
    .get();
  const allStamps = stampsSnap.docs.map((doc) => mapStamp(doc.id, doc.data()));
  const round = resolveCurrentRound(
    subSnap.data()?.stampRound,
    allStamps.map((s) => s.round),
    event.stampGoalCount,
  );
  // 表示用に、現在のチェックポイント情報から種別と番号を解決して付ける
  // （スタンプ記録自体には持たない。対象が消えている場合は付けない）。
  const exhibitorsSnap = await exhibitorsRef(db, eventId).get();
  const exhibitorById = new Map(
    exhibitorsSnap.docs.map((doc) => {
      const exhibitor = mapExhibitor(doc.id, doc.data());
      return [exhibitor.id, exhibitor] as const;
    }),
  );
  const stamps = allStamps
    .filter((s) => s.round === round)
    .sort((a, b) => (a.grantedAt ?? '').localeCompare(b.grantedAt ?? ''))
    .map((stamp) => {
      const exhibitor = exhibitorById.get(stamp.exhibitorId);
      return exhibitor
        ? {
            ...stamp,
            exhibitorKind: exhibitor.kind,
            checkpointNumber: exhibitor.checkpointNumber,
          }
        : stamp;
    });

  const freeSnap = await freeCouponsRef(db, eventId)
    .where('memberId', '==', memberId)
    .get();
  const freeCoupons = freeSnap.docs
    .map((doc) => mapFreeCoupon(doc.id, doc.data()))
    .sort((a, b) => b.round - a.round || a.id.localeCompare(b.id));

  return {
    memberId,
    round,
    goalCount: event.stampGoalCount,
    rewardType: event.stampRewardType,
    benefitText: event.stampBenefitText,
    milestones: parseStampMilestones(event.stampMilestones),
    countInRound: stamps.length,
    remaining: Math.max(event.stampGoalCount - stamps.length, 0),
    stamps,
    freeCoupons,
  };
}

// ─── 無料クーポン消込 ───

export type RedeemFreeCouponResult =
  | { ok: true; freeCouponId: string; kind: FreeCouponKind }
  | { ok: false; status: number; error: string };

/**
 * 無料クーポンを使う（消込）。通常クーポンと違い、所有店の制限はない:
 * どの参加店でも使え、原価は使われた店の負担（ここでは記録だけ）。
 * used への遷移はトランザクションで一度だけ。
 */
export async function redeemFreeCoupon(
  db: Firestore,
  input: {
    eventId: string;
    exhibitor: EventExhibitor;
    freeCouponId: string;
  },
): Promise<RedeemFreeCouponResult> {
  // 協賛（広告専用）アカウントは無料クーポンを消し込めない
  if (input.exhibitor.kind === 'advertiser') {
    return {
      ok: false,
      status: 403,
      error: '協賛アカウントはクーポンを消し込めません',
    };
  }
  const event = await getEvent(input.eventId);
  if (!event) {
    return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  }
  if (event.status !== 'live') {
    return {
      ok: false,
      status: 403,
      error: 'このプロジェクトは現在受け付けていません',
    };
  }
  const freeRef = freeCouponsRef(db, input.eventId).doc(input.freeCouponId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(freeRef);
    if (!snap.exists) {
      return {
        ok: false,
        status: 404,
        error: '無料クーポンが見つかりません',
      } as RedeemFreeCouponResult;
    }
    if (snap.data()?.status === 'used') {
      return {
        ok: false,
        status: 409,
        error: 'この無料クーポンは使用済みです',
      } as RedeemFreeCouponResult;
    }
    tx.update(freeRef, {
      status: 'used',
      usedAt: FieldValue.serverTimestamp(),
      usedExhibitorId: input.exhibitor.id,
      usedExhibitorName: input.exhibitor.name,
    });
    return {
      ok: true,
      freeCouponId: input.freeCouponId,
      // 消込画面の表示文を発行元で出し分けるために発行元も返す
      kind: snap.data()?.kind === 'login' ? 'login' : 'stamp',
    } as RedeemFreeCouponResult;
  });
}

// ─── レビュー資格 ───

/**
 * その店のレビューを書けるかどうか（レビュー機能の前提）。
 * スタンプをもらった（=取消しされず残っている）客だけが書ける。
 * どの周のスタンプでも資格になる。
 */
export async function hasStampForShop(
  db: Firestore,
  eventId: string,
  memberId: string,
  exhibitorId: string,
): Promise<boolean> {
  const snap = await stampsRef(db, eventId)
    .where('memberId', '==', memberId)
    .where('exhibitorId', '==', exhibitorId)
    .limit(1)
    .get();
  return !snap.empty;
}
