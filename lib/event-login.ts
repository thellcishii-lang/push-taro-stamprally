// lib/event-login.ts
// Push-taro.スタンプラリー の毎日ログインボーナス基盤（events/{eventId} 配下）。
//
// - 来場者はお店に行かなくても、来場者画面を開いてチェックインボタンを
//   押すだけでよい。1日（JST）1回まで数え、連続した日数で数える。
//   1日でも空くと連続が途切れ、その日のチェックインから数え直しになる。
// - 連続日数がプロジェクト設定の達成日数（loginBonusDays、5〜20）に届くと、
//   スタンプ達成と同じ freeCoupons に kind='login' のクーポンを発行し、
//   カウンタは自動でリセットされて次のサイクルが始まる。
// - 状態は購読者ドキュメント（subscribers/{memberId}）のトップレベル項目
//   に持つ（stampRound と同じ置き方）。書き込みはチェックイン API
//   （サーバー側）だけが行い、来場者本人の認証トークンから memberId を
//   特定するため改ざんできない。
// - クーポンの消込はスタンプ分と共通（lib/event-stamp.ts の
//   redeemFreeCoupon）。貰えるものは店ごとに profile.loginReward。
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  EVENT_SUBCOLLECTIONS,
  jstDateString,
  type EventConfig,
} from './event';
import { getEvent } from './event-store';
import { EVENT_FREE_COUPONS_COLLECTION } from './event-stamp';

/** 購読者ドキュメントに持つログインボーナスの状態。 */
export interface LoginBonusState {
  /** 現在のサイクルで数えた日数（達成で 0 に戻る） */
  countInCycle: number;
  /** 最後にチェックインした日（JST, 'YYYY-MM-DD'）。未実施なら null */
  lastCheckinDate: string | null;
  /** 完了したサイクル数（= 発行したクーポン数） */
  cyclesCompleted: number;
  /** これまでに発行したクーポンの総数（cyclesCompleted と同値だが表示用に分ける） */
  totalEarned: number;
}

export function emptyLoginBonusState(): LoginBonusState {
  return {
    countInCycle: 0,
    lastCheckinDate: null,
    cyclesCompleted: 0,
    totalEarned: 0,
  };
}

function readNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * 購読者ドキュメントからログインボーナス状態を防御的に読む（純粋関数）。
 * 項目が無い旧購読者はすべて 0 / null（未実施）。
 */
export function parseLoginBonusState(
  data: FirebaseFirestore.DocumentData | undefined | null,
): LoginBonusState {
  if (!data) return emptyLoginBonusState();
  return {
    countInCycle: readNonNegativeInt(data.loginCountInCycle),
    lastCheckinDate:
      typeof data.loginLastCheckinDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(data.loginLastCheckinDate)
        ? data.loginLastCheckinDate
        : null,
    cyclesCompleted: readNonNegativeInt(data.loginCyclesCompleted),
    totalEarned: readNonNegativeInt(data.loginTotalEarned),
  };
}

/** 状態を購読者ドキュメントの項目名に写す（書き込み用）。 */
export function loginBonusStateFields(
  state: LoginBonusState,
): Record<string, unknown> {
  return {
    loginCountInCycle: state.countInCycle,
    loginLastCheckinDate: state.lastCheckinDate,
    loginCyclesCompleted: state.cyclesCompleted,
    loginTotalEarned: state.totalEarned,
  };
}

export interface CheckinEvaluation {
  /** 今日すでに数えたかどうか（true なら日数は増えていない） */
  alreadyCheckedIn: boolean;
  /** 遷移後の状態 */
  nextState: LoginBonusState;
  /**
   * 今回発行すべきクーポンのサイクル番号（1始まり、完了順）。
   * 達成しなければ空。日数の再計算（目標日数を下げた等）で複数回の
   * 達成が同時に起きた場合は複数件になる。
   */
  issuedCycles: number[];
}

/** JST 日付文字列（'YYYY-MM-DD'）の前日を返す。 */
function prevJstDateString(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * チェックインの状態遷移（純粋関数）。
 * - 今日まだ数えていなければ、最終チェックイン日が昨日のときだけ +1
 *   する（連続）。昨日でなければ連続が途切れているので、その日を
 *   1日目として数え直す（冪等: 同じ日の再実行では増えない）。
 * - そのうえで、連続日数が目標日数以上なら達成としてクーポン発行分を
 *   切り出し、カウンタから目標日数を引く（サイクルが自動で回る）。
 *   すでに数えた日に目標日数を下げていた場合も、ここで達成が確定する。
 */
export function evaluateCheckin(
  state: LoginBonusState,
  todayJst: string,
  goalDays: number,
): CheckinEvaluation {
  const alreadyCheckedIn = state.lastCheckinDate === todayJst;
  let count: number;
  if (alreadyCheckedIn) {
    count = state.countInCycle;
  } else if (
    state.lastCheckinDate !== null &&
    state.lastCheckinDate === prevJstDateString(todayJst)
  ) {
    // 昨日もチェックインしているので連続が続く
    count = state.countInCycle + 1;
  } else {
    // 初回、または1日以上空いて連続が途切れたので数え直し
    count = 1;
  }
  let cyclesCompleted = state.cyclesCompleted;
  let totalEarned = state.totalEarned;
  const issuedCycles: number[] = [];
  while (count >= goalDays) {
    count -= goalDays;
    cyclesCompleted += 1;
    totalEarned += 1;
    issuedCycles.push(cyclesCompleted);
  }
  return {
    alreadyCheckedIn,
    nextState: {
      countInCycle: count,
      lastCheckinDate: todayJst,
      cyclesCompleted,
      totalEarned,
    },
    issuedCycles,
  };
}

/** 来場者画面・API で返す表示用の状態。 */
export interface LoginBonusView {
  /** プロジェクトで有効かどうか */
  enabled: boolean;
  /** 達成に必要な連続日数 */
  goalDays: number;
  /** 現在のサイクルで数えた日数 */
  countInCycle: number;
  /** 達成まであと何日か */
  remaining: number;
  /** 今日すでにチェックイン済みかどうか */
  checkedInToday: boolean;
  /** 完了したサイクル数 */
  cyclesCompleted: number;
  /** これまでに発行したクーポンの総数 */
  totalEarned: number;
}

/** 状態とプロジェクト設定から表示用ビューを作る（純粋関数）。 */
export function buildLoginBonusView(
  state: LoginBonusState,
  event: Pick<EventConfig, 'loginBonusEnabled' | 'loginBonusDays'>,
  todayJst: string,
): LoginBonusView {
  return {
    enabled: event.loginBonusEnabled,
    goalDays: event.loginBonusDays,
    countInCycle: state.countInCycle,
    remaining: Math.max(event.loginBonusDays - state.countInCycle, 0),
    checkedInToday: state.lastCheckinDate === todayJst,
    cyclesCompleted: state.cyclesCompleted,
    totalEarned: state.totalEarned,
  };
}

// ─── Firestore 読み書き ───

function subscriberRef(db: Firestore, eventId: string, memberId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_SUBCOLLECTIONS.subscribers)
    .doc(memberId);
}

function freeCouponsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_FREE_COUPONS_COLLECTION);
}

/**
 * 本人のログインボーナス状態（表示用）。
 * 購読者でなければ null（画面には何も出さない）。
 */
export async function getLoginBonusView(
  db: Firestore,
  eventId: string,
  memberId: string,
  now?: Date,
): Promise<LoginBonusView | null> {
  const event = await getEvent(eventId);
  if (!event) return null;
  const subSnap = await subscriberRef(db, eventId, memberId).get();
  if (!subSnap.exists) return null;
  const state = parseLoginBonusState(subSnap.data());
  return buildLoginBonusView(state, event, jstDateString(now ?? new Date()));
}

export type CheckinLoginBonusResult =
  | {
      ok: true;
      view: LoginBonusView;
      /** 今日すでに数えた状態だったかどうか */
      alreadyCheckedIn: boolean;
      /** 今回発行されたクーポンのID（無ければ空） */
      issuedCouponIds: string[];
    }
  | { ok: false; status: number; error: string };

/**
 * 今日のチェックインを記録する。購読者でない人・機能がオフの
 * プロジェクトでは記録しない。状態の更新とクーポン発行は1つの
 * トランザクションで行い、二重送信でも結果は同じ（冪等）。
 * 発行するクーポンはスタンプ達成と同じ freeCoupons に kind='login'
 * で積む。特典は店ごとの loginReward が担うため、クーポン側の
 * スナップショットは 'free-dish' 形式（benefitText は空）にする。
 */
export async function checkInLoginBonus(
  db: Firestore,
  input: { eventId: string; memberId: string; now?: Date },
): Promise<CheckinLoginBonusResult> {
  const event = await getEvent(input.eventId);
  if (!event) {
    return { ok: false, status: 404, error: 'プロジェクトが見つかりません' };
  }
  if (!event.loginBonusEnabled) {
    return {
      ok: false,
      status: 403,
      error: 'このプロジェクトではログインボーナスを実施していません',
    };
  }
  if (event.status !== 'live') {
    return {
      ok: false,
      status: 403,
      error: 'このプロジェクトは現在受け付けていません',
    };
  }
  const today = jstDateString(input.now ?? new Date());
  const subRef = subscriberRef(db, input.eventId, input.memberId);

  return db.runTransaction(async (tx) => {
    const subSnap = await tx.get(subRef);
    if (!subSnap.exists) {
      return {
        ok: false,
        status: 404,
        error: '登録が見つかりません',
      } as CheckinLoginBonusResult;
    }
    const state = parseLoginBonusState(subSnap.data());
    const evaluation = evaluateCheckin(state, today, event.loginBonusDays);

    const issuedCouponIds: string[] = [];
    for (const cycle of evaluation.issuedCycles) {
      const freeRef = freeCouponsRef(db, input.eventId).doc();
      issuedCouponIds.push(freeRef.id);
      tx.set(freeRef, {
        memberId: input.memberId,
        kind: 'login',
        // round にはログインのサイクル番号を持つ（スタンプの周とは別軸）
        round: cycle,
        rewardType: 'free-dish',
        benefitText: '',
        status: 'active',
        issuedAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(subRef, {
      ...loginBonusStateFields(evaluation.nextState),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      ok: true,
      view: buildLoginBonusView(evaluation.nextState, event, today),
      alreadyCheckedIn: evaluation.alreadyCheckedIn,
      issuedCouponIds,
    } as CheckinLoginBonusResult;
  });
}
