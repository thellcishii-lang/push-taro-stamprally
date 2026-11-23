// lib/stamp-celebration.test.ts
// 達成セレブレーションの純粋ロジック: 対象クーポンの選択、特典種別の
// 判定、表示済みの保存キーと読み書き。
import { describe, expect, it } from 'vitest';
import {
  celebrationCouponKind,
  celebrationRewardKind,
  celebrationStorageKey,
  isCelebratedInStorage,
  markCelebratedInStorage,
  pickCelebrationCoupon,
  type CelebrationCouponLike,
  type CelebrationStorageLike,
} from './stamp-celebration';

function coupon(
  partial: Partial<CelebrationCouponLike> & { id: string },
): CelebrationCouponLike {
  return {
    round: 1,
    rewardType: 'free-dish',
    benefitText: '',
    status: 'active',
    ...partial,
  };
}

const noneCelebrated = () => false;

describe('celebrationStorageKey', () => {
  it('クーポンIDごとに一意なキーを作る', () => {
    expect(celebrationStorageKey('fc-1')).toBe('stamprally-celebrated-fc-1');
    expect(celebrationStorageKey('fc-1')).not.toBe(
      celebrationStorageKey('fc-2'),
    );
  });
});

describe('celebrationRewardKind', () => {
  it("benefit スナップショットだけを 'benefit' と判定する", () => {
    expect(celebrationRewardKind({ rewardType: 'benefit' })).toBe('benefit');
    expect(celebrationRewardKind({ rewardType: 'free-dish' })).toBe(
      'free-dish',
    );
    // スナップショット導入前のクーポン（未設定）は従来種別に倒す
    expect(celebrationRewardKind({})).toBe('free-dish');
    expect(celebrationRewardKind({ rewardType: 'unknown' })).toBe('free-dish');
  });
});

describe('pickCelebrationCoupon', () => {
  it('クーポンが無ければ null', () => {
    expect(pickCelebrationCoupon([], noneCelebrated)).toBeNull();
  });

  it('使用済みだけなら null（お祝いは未使用のものだけ）', () => {
    const used = coupon({ id: 'fc-1', status: 'used' });
    expect(pickCelebrationCoupon([used], noneCelebrated)).toBeNull();
  });

  it('未使用で未表示のものを返す', () => {
    const active = coupon({ id: 'fc-1' });
    expect(pickCelebrationCoupon([active], noneCelebrated)).toBe(active);
  });

  it('一番新しい達成（周が最大）を選ぶ', () => {
    const older = coupon({ id: 'fc-1', round: 1 });
    const newer = coupon({ id: 'fc-2', round: 2 });
    expect(pickCelebrationCoupon([older, newer], noneCelebrated)).toBe(newer);
    expect(pickCelebrationCoupon([newer, older], noneCelebrated)).toBe(newer);
  });

  it('表示済みのものは飛ばして次の候補を選ぶ', () => {
    const older = coupon({ id: 'fc-1', round: 1 });
    const newer = coupon({ id: 'fc-2', round: 2 });
    const celebrated = (id: string) => id === 'fc-2';
    expect(pickCelebrationCoupon([older, newer], celebrated)).toBe(older);
  });

  it('全部表示済みなら null', () => {
    const a = coupon({ id: 'fc-1', round: 1 });
    const b = coupon({ id: 'fc-2', round: 2 });
    expect(pickCelebrationCoupon([a, b], () => true)).toBeNull();
  });

  it('使用済みの新しい周があっても、未使用の古い周を選ぶ', () => {
    const activeOld = coupon({ id: 'fc-1', round: 1 });
    const usedNew = coupon({ id: 'fc-2', round: 2, status: 'used' });
    expect(pickCelebrationCoupon([activeOld, usedNew], noneCelebrated)).toBe(
      activeOld,
    );
  });
});

describe('storage helpers', () => {
  function fakeStorage(): CelebrationStorageLike & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
  }

  it('記録する前は未表示、記録したら表示済みになる', () => {
    const storage = fakeStorage();
    expect(isCelebratedInStorage(storage, 'fc-1')).toBe(false);
    markCelebratedInStorage(storage, 'fc-1');
    expect(isCelebratedInStorage(storage, 'fc-1')).toBe(true);
    expect(isCelebratedInStorage(storage, 'fc-2')).toBe(false);
  });

  it('storage が null でも例外なく動く', () => {
    expect(isCelebratedInStorage(null, 'fc-1')).toBe(false);
    expect(() => markCelebratedInStorage(null, 'fc-1')).not.toThrow();
  });

  it('例外を投げる storage でも例外なく動く（プライベートモード等）', () => {
    const throwing: CelebrationStorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(isCelebratedInStorage(throwing, 'fc-1')).toBe(false);
    expect(() => markCelebratedInStorage(throwing, 'fc-1')).not.toThrow();
  });
});

describe('celebrationCouponKind', () => {
  it("kind が 'login' のものだけを 'login' と判定する", () => {
    expect(celebrationCouponKind({ kind: 'login' })).toBe('login');
    expect(celebrationCouponKind({ kind: 'stamp' })).toBe('stamp');
    // 旧データ（kind 未設定）はスタンプ達成として扱う
    expect(celebrationCouponKind({})).toBe('stamp');
    expect(celebrationCouponKind({ kind: 'other' })).toBe('stamp');
  });

  it('ログインボーナスのクーポンもセレブレーションの対象になる', () => {
    const loginCoupon = coupon({ id: 'fc-login', kind: 'login', round: 2 });
    expect(pickCelebrationCoupon([loginCoupon], noneCelebrated)).toEqual(
      loginCoupon,
    );
    // 表示済みなら出さない（スタンプ達成と同じ扱い）
    expect(
      pickCelebrationCoupon([loginCoupon], (id) => id === 'fc-login'),
    ).toBeNull();
  });
});
