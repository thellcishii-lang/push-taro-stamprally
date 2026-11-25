// lib/event-stamp.test.ts
// スタンプの純粋ロジック: ドキュメントID構成、達成判定、現在の周の解決、
// 取消し可否。Firestore を使う処理（grantStamp 等）はルートテスト側で
// lib をモックして検証する。
import type { Firestore } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventExhibitor } from './event-coupon';
import {
  buildStampRewardSnapshot,
  evaluateSequentialStamp,
  evaluateStampCancel,
  getStampCard,
  grantStamp,
  grantStampByPlacedQr,
  isRoundCompleted,
  parseStampMethod,
  redeemFreeCoupon,
  resolveCurrentRound,
  stampIdFor,
} from './event-stamp';

const storeMocks = vi.hoisted(() => ({ getEvent: vi.fn() }));
vi.mock('./event-store', () => ({ getEvent: storeMocks.getEvent }));

describe('stampIdFor', () => {
  it('memberId・周・参加店ID から一意なIDを作る', () => {
    expect(stampIdFor('member-a', 1, 'shop-a')).toBe('member-a_1_shop-a');
    expect(stampIdFor('member-a', 2, 'shop-a')).not.toBe(
      stampIdFor('member-a', 1, 'shop-a'),
    );
    expect(stampIdFor('member-a', 1, 'shop-b')).not.toBe(
      stampIdFor('member-a', 1, 'shop-a'),
    );
  });
});

describe('isRoundCompleted', () => {
  it('達成個数に届いたら達成', () => {
    expect(isRoundCompleted(5, 5)).toBe(true);
    expect(isRoundCompleted(6, 5)).toBe(true);
    expect(isRoundCompleted(4, 5)).toBe(false);
    expect(isRoundCompleted(0, 5)).toBe(false);
    expect(isRoundCompleted(1, 1)).toBe(true);
  });
});

describe('resolveCurrentRound', () => {
  it('保存済みの stampRound があればそれが正', () => {
    expect(resolveCurrentRound(3, [1, 1, 2], 5)).toBe(3);
    expect(resolveCurrentRound(1, [], 5)).toBe(1);
  });
  it('保存が無くスタンプも無ければ 1周目', () => {
    expect(resolveCurrentRound(undefined, [], 5)).toBe(1);
    expect(resolveCurrentRound(null, [], 5)).toBe(1);
  });
  it('保存が無ければ実績の最大周を引き継ぐ（未達成ならその周）', () => {
    expect(resolveCurrentRound(undefined, [1, 1, 2], 5)).toBe(2);
  });
  it('最大周が達成済みなら次の周に進める', () => {
    expect(resolveCurrentRound(undefined, [2, 2, 2, 2, 2], 5)).toBe(3);
  });
  it('不正な保存値は実績からの復元に倒す', () => {
    expect(resolveCurrentRound(0, [1], 5)).toBe(1);
    expect(resolveCurrentRound('2', [2, 2], 5)).toBe(2);
  });
});

describe('evaluateStampCancel', () => {
  const today = '2026-11-14';
  const stamp = {
    exhibitorId: 'shop-a',
    round: 2,
    grantedDateJst: today,
  };
  it('自店・当日・現在の周なら取り消せる', () => {
    expect(evaluateStampCancel(stamp, 'shop-a', 2, today)).toEqual({
      allowed: true,
    });
  });
  it('他店のスタンプは取り消せない', () => {
    expect(evaluateStampCancel(stamp, 'shop-b', 2, today)).toEqual({
      allowed: false,
      reason: 'not-owner',
    });
  });
  it('過去の周のスタンプは取り消せない', () => {
    expect(evaluateStampCancel(stamp, 'shop-a', 3, today)).toEqual({
      allowed: false,
      reason: 'not-current-round',
    });
  });
  it('当日以外のスタンプは取り消せない', () => {
    expect(
      evaluateStampCancel(
        { ...stamp, grantedDateJst: '2026-11-13' },
        'shop-a',
        2,
        today,
      ),
    ).toEqual({ allowed: false, reason: 'not-today' });
  });
});

describe('buildStampRewardSnapshot（発行クーポンへの特典スナップショット）', () => {
  it('free-dish では従来どおりの種別で、内容は空（設定に残る文面は写さない）', () => {
    expect(
      buildStampRewardSnapshot({
        stampRewardType: 'free-dish',
        stampBenefitText: '前に特典で使っていた文面',
      }),
    ).toEqual({ rewardType: 'free-dish', benefitText: '' });
  });
  it('benefit では種類と内容をそのまま写す', () => {
    expect(
      buildStampRewardSnapshot({
        stampRewardType: 'benefit',
        stampBenefitText: '特製グッズをプレゼント',
      }),
    ).toEqual({ rewardType: 'benefit', benefitText: '特製グッズをプレゼント' });
  });
  it('発行後に設定を変えても、作成済みスナップショットは変わらない', () => {
    const issued = buildStampRewardSnapshot({
      stampRewardType: 'benefit',
      stampBenefitText: '発行時点の特典',
    });
    // 設定変更を模して別オブジェクトを作っても issued は不変
    buildStampRewardSnapshot({
      stampRewardType: 'free-dish',
      stampBenefitText: '',
    });
    expect(issued).toEqual({
      rewardType: 'benefit',
      benefitText: '発行時点の特典',
    });
  });
});

describe('協賛（広告専用）アカウントのガード', () => {
  // 種別ガードは Firestore やプロジェクト取得より前に効くため、
  // db は使われない（null を渡してそれを担保する）。
  const noDb = null as unknown as Firestore;
  const advertiser: EventExhibitor = {
    id: 'sponsor-1',
    name: '協賛企業',
    email: 'sponsor@example.com',
    address: null,
    hasAccessCode: true,
    lang: 'ja',
    kind: 'advertiser',
    source: 'admin',
    delistedAt: null,
    closedAt: null,
    stampCode: null,
    checkpointNumber: null,
    stampMethods: [],
    gpsCheck: false,
    velocityCheck: false,
  };

  it('協賛アカウントはスタンプを押せない（403）', async () => {
    const result = await grantStamp(noDb, {
      eventId: 'event-1',
      exhibitor: advertiser,
      memberId: 'member-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('協賛アカウントは無料クーポンを消し込めない（403）', async () => {
    const result = await redeemFreeCoupon(noDb, {
      eventId: 'event-1',
      exhibitor: advertiser,
      freeCouponId: 'fc-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe('parseStampMethod（付与方式の読み取り）', () => {
  it('新しい方式はそのまま読む', () => {
    expect(parseStampMethod('placed-qr')).toBe('placed-qr');
    expect(parseStampMethod('shop-qr')).toBe('shop-qr');
  });
  it('未設定・未知の値は従来方式に倒す（後方互換）', () => {
    expect(parseStampMethod(undefined)).toBe('shop-qr');
    expect(parseStampMethod(null)).toBe('shop-qr');
    expect(parseStampMethod('unknown')).toBe('shop-qr');
    // GPS 方式があった時期の記録も壊れず従来方式として読む
    expect(parseStampMethod('gps')).toBe('shop-qr');
  });
});

describe('evaluateSequentialStamp（順番モードの判定）', () => {
  const checkpoints = [
    { exhibitorId: 'cp-1', checkpointNumber: 1 },
    { exhibitorId: 'cp-2', checkpointNumber: 2 },
    { exhibitorId: 'cp-3', checkpointNumber: 3 },
    { exhibitorId: 'cp-x', checkpointNumber: null },
  ];
  it('正順なら押せる（次は未取得の最小番号）', () => {
    expect(
      evaluateSequentialStamp({
        checkpoints,
        stampedExhibitorIds: new Set(),
        targetExhibitorId: 'cp-1',
      }),
    ).toEqual({ allowed: true });
    expect(
      evaluateSequentialStamp({
        checkpoints,
        stampedExhibitorIds: new Set(['cp-1']),
        targetExhibitorId: 'cp-2',
      }),
    ).toEqual({ allowed: true });
  });
  it('飛ばすと拒否し、次の番号を返す', () => {
    expect(
      evaluateSequentialStamp({
        checkpoints,
        stampedExhibitorIds: new Set(),
        targetExhibitorId: 'cp-2',
      }),
    ).toEqual({ allowed: false, reason: 'not-next', nextNumber: 1 });
    expect(
      evaluateSequentialStamp({
        checkpoints,
        stampedExhibitorIds: new Set(['cp-1']),
        targetExhibitorId: 'cp-3',
      }),
    ).toEqual({ allowed: false, reason: 'not-next', nextNumber: 2 });
  });
  it('番号のないチェックポイントは対象外', () => {
    expect(
      evaluateSequentialStamp({
        checkpoints,
        stampedExhibitorIds: new Set(['cp-1']),
        targetExhibitorId: 'cp-x',
      }),
    ).toEqual({ allowed: false, reason: 'no-number', nextNumber: 2 });
  });
});

// ─── フェイク Firestore（grantStamp 系の統合テスト用） ───

type DocData = Record<string, unknown>;
const GRANT_EVENT_ID = 'event-1';

function createStampFakeDb() {
  const store = new Map<string, DocData>();
  let autoId = 0;
  const copy = (data: DocData): DocData => ({ ...data });

  function docRef(path: string): Record<string, unknown> {
    const id = path.split('/').pop()!;
    return {
      id,
      path,
      get: async () => {
        const data = store.get(path);
        return {
          exists: data !== undefined,
          id,
          data: () => (data ? copy(data) : undefined),
        };
      },
      set: async (data: DocData) => {
        store.set(path, copy(data));
      },
      update: async (data: DocData) => {
        const current = store.get(path);
        if (!current) throw new Error(`更新対象がありません: ${path}`);
        store.set(path, { ...current, ...copy(data) });
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(path: string): Record<string, unknown> {
    const filters: Array<[string, unknown]> = [];
    const self: Record<string, unknown> = {
      doc: (id?: string) => docRef(`${path}/${id ?? `auto-${++autoId}`}`),
      where: (field: string, _op: string, value: unknown) => {
        filters.push([field, value]);
        return self;
      },
      limit: (_n: number) => self,
      get: async () => {
        const docs: Array<Record<string, unknown>> = [];
        for (const [docPath, data] of store.entries()) {
          if (!docPath.startsWith(`${path}/`)) continue;
          const rest = docPath.slice(path.length + 1);
          if (rest.includes('/')) continue;
          if (filters.every(([field, value]) => data[field] === value)) {
            docs.push({
              id: rest,
              data: () => copy(data),
              ref: docRef(docPath),
            });
          }
        }
        return { docs, empty: docs.length === 0 };
      },
    };
    return self;
  }

  const db = {
    collection: (name: string) => collectionRef(name),
    runTransaction: async (
      fn: (tx: {
        get: (ref: never) => Promise<unknown>;
        set: (ref: never, data: DocData) => Promise<void>;
        update: (ref: never, data: DocData) => Promise<void>;
      }) => Promise<unknown>,
    ) =>
      fn({
        get: (ref: { get: () => Promise<unknown> }) => ref.get(),
        set: (ref: { set: (data: DocData) => Promise<void> }, data: DocData) =>
          ref.set(data),
        update: (
          ref: { update: (data: DocData) => Promise<void> },
          data: DocData,
        ) => ref.update(data),
      }),
  };
  return { db: db as unknown as Firestore, store };
}

function liveEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_EVENT_ID,
    status: 'live',
    stampGoalCount: 5,
    stampRewardType: 'free-dish',
    stampBenefitText: '',
    sequentialStamps: false,
    ...overrides,
  };
}

function fakeExhibitor(overrides: Partial<EventExhibitor>): EventExhibitor {
  return {
    id: 'shop-a',
    name: '店A',
    email: 'a@example.com',
    address: null,
    hasAccessCode: true,
    lang: 'ja',
    kind: 'shop',
    source: 'admin',
    delistedAt: null,
    closedAt: null,
    stampCode: null,
    checkpointNumber: null,
    stampMethods: ['staff'],
    gpsCheck: false,
    velocityCheck: false,
    ...overrides,
  };
}

function seedExhibitorDoc(
  store: Map<string, DocData>,
  id: string,
  data: DocData,
) {
  store.set(`events/${GRANT_EVENT_ID}/exhibitors/${id}`, data);
}

function seedSubscriber(store: Map<string, DocData>, memberId: string) {
  store.set(`events/${GRANT_EVENT_ID}/subscribers/${memberId}`, {});
}

const CODE_A = 'AAAAAAAAAAAAAAAAAAAA';
const CODE_B = 'BBBBBBBBBBBBBBBBBBBB';

beforeEach(() => {
  storeMocks.getEvent.mockReset();
  storeMocks.getEvent.mockResolvedValue(liveEvent());
});

describe('grantStamp: 認証方法の実施', () => {
  it('店読みが無効なチェックポイントでは店読みを拒否する（403）', async () => {
    const { db, store } = createStampFakeDb();
    seedSubscriber(store, 'member-a');
    const result = await grantStamp(db, {
      eventId: GRANT_EVENT_ID,
      exhibitor: fakeExhibitor({ stampMethods: ['placed'] }),
      memberId: 'member-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('置きQRが無効なスポットでは置きQRを拒否する（403）', async () => {
    const { db, store } = createStampFakeDb();
    seedSubscriber(store, 'member-a');
    seedExhibitorDoc(store, 'spot-b', {
      name: 'スポットB',
      kind: 'spot',
      stampCode: CODE_B,
      stampMethods: ['staff'],
    });
    const result = await grantStampByPlacedQr(db, {
      eventId: GRANT_EVENT_ID,
      memberId: 'member-a',
      stampCode: CODE_B,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe('スポットのスタンプ合算（置きQR）', () => {
  it('スポットのスタンプもお店と同じカード・目標に数え、達成で発行される', async () => {
    storeMocks.getEvent.mockResolvedValue(liveEvent({ stampGoalCount: 2 }));
    const { db, store } = createStampFakeDb();
    seedSubscriber(store, 'member-a');
    seedExhibitorDoc(store, 'spot-b', {
      name: '展望台',
      kind: 'spot',
      stampCode: CODE_B,
      stampMethods: ['placed'],
      checkpointNumber: 2,
    });
    seedExhibitorDoc(store, 'shop-a', {
      name: '店A',
      kind: 'shop',
      stampCode: CODE_A,
      stampMethods: ['staff', 'placed'],
      checkpointNumber: 1,
    });

    const first = await grantStampByPlacedQr(db, {
      eventId: GRANT_EVENT_ID,
      memberId: 'member-a',
      stampCode: CODE_B,
    });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.countInRound).toBe(1);
      expect(first.completed).toBe(false);
      expect(first.exhibitorName).toBe('展望台');
    }

    const second = await grantStampByPlacedQr(db, {
      eventId: GRANT_EVENT_ID,
      memberId: 'member-a',
      stampCode: CODE_A,
    });
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.countInRound).toBe(2);
      expect(second.completed).toBe(true);
      expect(second.freeCouponId).toBeTruthy();
    }

    const card = await getStampCard(db, GRANT_EVENT_ID, 'member-a');
    expect(card).not.toBeNull();
    // 達成で次周に進んでいるため、今の周のスタンプは 0。無料クーポンが
    // 1枚発行されていることで合算・達成を確認する。
    expect(card?.freeCoupons).toHaveLength(1);
  });

  it('カードのスタンプにスポットの種別と番号が付く', async () => {
    storeMocks.getEvent.mockResolvedValue(liveEvent({ stampGoalCount: 5 }));
    const { db, store } = createStampFakeDb();
    seedSubscriber(store, 'member-a');
    seedExhibitorDoc(store, 'spot-b', {
      name: '展望台',
      kind: 'spot',
      stampCode: CODE_B,
      stampMethods: ['placed'],
      checkpointNumber: 2,
    });
    await grantStampByPlacedQr(db, {
      eventId: GRANT_EVENT_ID,
      memberId: 'member-a',
      stampCode: CODE_B,
    });
    const card = await getStampCard(db, GRANT_EVENT_ID, 'member-a');
    expect(card?.stamps).toHaveLength(1);
    expect(card?.stamps[0].exhibitorKind).toBe('spot');
    expect(card?.stamps[0].checkpointNumber).toBe(2);
  });
});

describe('grantStamp: 順番モードの実施', () => {
  function seedSequential(store: Map<string, DocData>) {
    seedSubscriber(store, 'member-a');
    seedExhibitorDoc(store, 'cp-1', {
      name: '1番の店',
      kind: 'shop',
      stampCode: null,
      stampMethods: ['staff'],
      checkpointNumber: 1,
    });
    seedExhibitorDoc(store, 'cp-2', {
      name: '2番のスポット',
      kind: 'spot',
      stampCode: CODE_B,
      stampMethods: ['placed'],
      checkpointNumber: 2,
    });
    seedExhibitorDoc(store, 'cp-3', {
      name: '3番の店',
      kind: 'shop',
      stampCode: null,
      stampMethods: ['staff'],
      checkpointNumber: 3,
    });
    seedExhibitorDoc(store, 'cp-x', {
      name: '番号なしの店',
      kind: 'shop',
      stampCode: null,
      stampMethods: ['staff'],
      checkpointNumber: null,
    });
  }

  it('正順は押せて、飛ばしは次の番号つきで拒否、番号なしは対象外', async () => {
    storeMocks.getEvent.mockResolvedValue(
      liveEvent({ sequentialStamps: true }),
    );
    const { db, store } = createStampFakeDb();
    seedSequential(store);
    const cp1 = fakeExhibitor({ id: 'cp-1', checkpointNumber: 1 });
    const cp3 = fakeExhibitor({ id: 'cp-3', checkpointNumber: 3 });
    const cpX = fakeExhibitor({ id: 'cp-x', checkpointNumber: null });

    const first = await grantStamp(db, {
      eventId: GRANT_EVENT_ID,
      exhibitor: cp1,
      memberId: 'member-a',
    });
    expect(first.ok).toBe(true);

    const skipped = await grantStamp(db, {
      eventId: GRANT_EVENT_ID,
      exhibitor: cp3,
      memberId: 'member-a',
    });
    expect(skipped.ok).toBe(false);
    if (!skipped.ok) {
      expect(skipped.status).toBe(409);
      expect(skipped.nextCheckpointNumber).toBe(2);
      expect(skipped.error).toContain('次は2番');
    }

    const second = await grantStampByPlacedQr(db, {
      eventId: GRANT_EVENT_ID,
      memberId: 'member-a',
      stampCode: CODE_B,
    });
    expect(second.ok).toBe(true);

    const noNumber = await grantStamp(db, {
      eventId: GRANT_EVENT_ID,
      exhibitor: cpX,
      memberId: 'member-a',
    });
    expect(noNumber.ok).toBe(false);
    if (!noNumber.ok) expect(noNumber.status).toBe(403);

    const third = await grantStamp(db, {
      eventId: GRANT_EVENT_ID,
      exhibitor: cp3,
      memberId: 'member-a',
    });
    expect(third.ok).toBe(true);
  });

  it('順番モードがオフなら番号と違う順番でも押せる', async () => {
    storeMocks.getEvent.mockResolvedValue(
      liveEvent({ sequentialStamps: false }),
    );
    const { db, store } = createStampFakeDb();
    seedSequential(store);
    const cp3 = fakeExhibitor({ id: 'cp-3', checkpointNumber: 3 });
    const result = await grantStamp(db, {
      eventId: GRANT_EVENT_ID,
      exhibitor: cp3,
      memberId: 'member-a',
    });
    expect(result.ok).toBe(true);
  });
});
