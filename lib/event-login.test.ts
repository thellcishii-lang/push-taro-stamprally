// lib/event-login.test.ts
// ログインボーナスの純粋ロジック: 状態の読み取り、チェックインの
// 状態遷移（JST の日付境界・累積・サイクル達成と繰り返し）、表示整形。
import { describe, expect, it } from 'vitest';
import {
  buildLoginBonusView,
  emptyLoginBonusState,
  evaluateCheckin,
  loginBonusStateFields,
  parseLoginBonusState,
  type LoginBonusState,
} from './event-login';

function state(partial: Partial<LoginBonusState> = {}): LoginBonusState {
  return { ...emptyLoginBonusState(), ...partial };
}

describe('parseLoginBonusState', () => {
  it('未設定は空の状態に倒す', () => {
    expect(parseLoginBonusState(undefined)).toEqual(emptyLoginBonusState());
    expect(parseLoginBonusState(null)).toEqual(emptyLoginBonusState());
    expect(parseLoginBonusState({})).toEqual(emptyLoginBonusState());
  });

  it('保存済みの値を読み、不正な値は 0 / null に倒す', () => {
    expect(
      parseLoginBonusState({
        loginCountInCycle: 3,
        loginLastCheckinDate: '2026-11-17',
        loginCyclesCompleted: 2,
        loginTotalEarned: 2,
      }),
    ).toEqual({
      countInCycle: 3,
      lastCheckinDate: '2026-11-17',
      cyclesCompleted: 2,
      totalEarned: 2,
    });
    expect(
      parseLoginBonusState({
        loginCountInCycle: -1,
        loginLastCheckinDate: '17/11/2026',
        loginCyclesCompleted: 1.5,
        loginTotalEarned: 'x',
      }),
    ).toEqual(emptyLoginBonusState());
  });

  it('loginBonusStateFields は保存フィールド名で往復できる', () => {
    const original = state({
      countInCycle: 4,
      lastCheckinDate: '2026-11-17',
      cyclesCompleted: 1,
      totalEarned: 1,
    });
    expect(parseLoginBonusState(loginBonusStateFields(original))).toEqual(
      original,
    );
  });
});

describe('evaluateCheckin', () => {
  it('初めてのチェックインで 1 日分が数えられる', () => {
    const result = evaluateCheckin(state(), '2026-11-17', 7);
    expect(result.alreadyCheckedIn).toBe(false);
    expect(result.issuedCycles).toEqual([]);
    expect(result.nextState).toEqual({
      countInCycle: 1,
      lastCheckinDate: '2026-11-17',
      cyclesCompleted: 0,
      totalEarned: 0,
    });
  });

  it('同じ日（JST）の再チェックインは増えない（冪等）', () => {
    const first = evaluateCheckin(state(), '2026-11-17', 7);
    const second = evaluateCheckin(first.nextState, '2026-11-17', 7);
    expect(second.alreadyCheckedIn).toBe(true);
    expect(second.nextState.countInCycle).toBe(1);
    expect(second.issuedCycles).toEqual([]);
  });

  it('日付が変われば数えられる（連続でなくても累積する）', () => {
    const day1 = evaluateCheckin(state(), '2026-11-17', 7);
    // 18日を飛ばして19日に開いても、累積で2日目になる
    const day3 = evaluateCheckin(day1.nextState, '2026-11-19', 7);
    expect(day3.alreadyCheckedIn).toBe(false);
    expect(day3.nextState.countInCycle).toBe(2);
  });

  it('目標日数ちょうどでクーポン1件が発行され、カウンタが 0 に戻る', () => {
    const result = evaluateCheckin(
      state({ countInCycle: 6, lastCheckinDate: '2026-11-16' }),
      '2026-11-17',
      7,
    );
    expect(result.issuedCycles).toEqual([1]);
    expect(result.nextState).toEqual({
      countInCycle: 0,
      lastCheckinDate: '2026-11-17',
      cyclesCompleted: 1,
      totalEarned: 1,
    });
  });

  it('サイクルは自動で繰り返す（2周目はサイクル番号 2）', () => {
    const result = evaluateCheckin(
      state({
        countInCycle: 4,
        lastCheckinDate: '2026-11-16',
        cyclesCompleted: 1,
        totalEarned: 1,
      }),
      '2026-11-17',
      5,
    );
    expect(result.issuedCycles).toEqual([2]);
    expect(result.nextState.cyclesCompleted).toBe(2);
    expect(result.nextState.totalEarned).toBe(2);
    expect(result.nextState.countInCycle).toBe(0);
  });

  it('目標日数を下げたあとのチェックインで、余りを持ったまま達成する', () => {
    // 目標 7 で 6 日貯めたあと、主催者が目標を 5 に下げたケース。
    // 次のチェックインで 7 日分 → 達成1回＋余り 2 日が次サイクルに残る。
    const result = evaluateCheckin(
      state({ countInCycle: 6, lastCheckinDate: '2026-11-16' }),
      '2026-11-17',
      5,
    );
    expect(result.issuedCycles).toEqual([1]);
    expect(result.nextState.countInCycle).toBe(2);
  });

  it('すでに数えた日でも、目標を下げていれば達成が確定する', () => {
    const result = evaluateCheckin(
      state({ countInCycle: 6, lastCheckinDate: '2026-11-17' }),
      '2026-11-17',
      5,
    );
    expect(result.alreadyCheckedIn).toBe(true);
    expect(result.issuedCycles).toEqual([1]);
    expect(result.nextState.countInCycle).toBe(1);
  });

  it('大きく下げた場合は複数サイクル分が同時に発行される', () => {
    const result = evaluateCheckin(
      state({ countInCycle: 19, lastCheckinDate: '2026-11-16' }),
      '2026-11-17',
      5,
    );
    expect(result.issuedCycles).toEqual([1, 2, 3, 4]);
    expect(result.nextState.countInCycle).toBe(0);
    expect(result.nextState.totalEarned).toBe(4);
  });
});

describe('buildLoginBonusView', () => {
  it('進み具合・残り日数・今日チェックイン済みを整形する', () => {
    const view = buildLoginBonusView(
      state({ countInCycle: 3, lastCheckinDate: '2026-11-17' }),
      { loginBonusEnabled: true, loginBonusDays: 7 },
      '2026-11-17',
    );
    expect(view).toEqual({
      enabled: true,
      goalDays: 7,
      countInCycle: 3,
      remaining: 4,
      checkedInToday: true,
      cyclesCompleted: 0,
      totalEarned: 0,
    });
  });

  it('日付が変われば今日はまだチェックインしていない', () => {
    const view = buildLoginBonusView(
      state({ countInCycle: 3, lastCheckinDate: '2026-11-16' }),
      { loginBonusEnabled: true, loginBonusDays: 7 },
      '2026-11-17',
    );
    expect(view.checkedInToday).toBe(false);
    expect(view.remaining).toBe(4);
  });

  it('無効な間も設定値（目標日数）はそのまま返す', () => {
    const view = buildLoginBonusView(
      state(),
      { loginBonusEnabled: false, loginBonusDays: 10 },
      '2026-11-17',
    );
    expect(view.enabled).toBe(false);
    expect(view.goalDays).toBe(10);
  });
});
