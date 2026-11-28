// lib/event-coupon.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

// updateExhibitorCheckpointSettings のテスト用フェイク Firestore。
// exhibitors コレクションの doc 取得・一覧・更新だけを再現する。
const fakeExhibitorDocs = vi.hoisted(() => ({
  docs: new Map<string, Record<string, unknown>>(),
}));
vi.mock('./firebase-admin', () => {
  const exhibitorsCollection = (eventId: string) => ({
    doc: (id: string) => ({
      get: async () => {
        const data = fakeExhibitorDocs.docs.get(`${eventId}/${id}`);
        return {
          exists: data !== undefined,
          id,
          data: () => data,
        };
      },
      update: async (patch: Record<string, unknown>) => {
        const key = `${eventId}/${id}`;
        const current = fakeExhibitorDocs.docs.get(key);
        if (!current) throw new Error(`更新対象がありません: ${key}`);
        fakeExhibitorDocs.docs.set(key, { ...current, ...patch });
      },
    }),
    get: async () => ({
      docs: [...fakeExhibitorDocs.docs.entries()]
        .filter(([key]) => key.startsWith(`${eventId}/`))
        .map(([key, data]) => ({
          id: key.slice(eventId.length + 1),
          data: () => data,
        })),
    }),
  });
  return {
    db: {
      collection: () => ({
        doc: (eventId: string) => ({
          collection: () => exhibitorsCollection(eventId),
        }),
      }),
    },
  };
});

import {
  EventClaim,
  EventCoupon,
  claimIdFor,
  couponClaimState,
  evaluateRedemption,
  filterCoupons,
  isCouponCapReached,
  isCouponUseAllowedOn,
  jstTodayString,
  memberIdForDevice,
  memberIdForPhone,
  normalizeCouponWindows,
  defaultStampMethods,
  findCheckpointNumberConflict,
  normalizeStampMethods,
  parseCheckpointNumber,
  parseCouponApprovalStatus,
  parseCouponIssuedBy,
  parseCouponWindowDate,
  parseExhibitorKind,
  parseStampMethods,
  tallyClaimsByCoupon,
  updateExhibitorCheckpointSettings,
  type EventExhibitor,
} from './event-coupon';

const couponA: EventCoupon = {
  id: 'coupon-a',
  exhibitorId: 'exhibitor-a',
  exhibitorName: '株式会社アルファ',
  title: 'ドリンク1杯無料',
  description: 'ブースで使える',
  titleI18n: {},
  descriptionI18n: {},
  keywords: ['飲み物', '無料'],
  active: true,
  issuedBy: 'admin',
  paymentPending: false,
  feeAmount: null,
  approvalStatus: 'approved',
  claimFrom: null,
  claimUntil: null,
  useFrom: null,
  useUntil: null,
};
const couponB: EventCoupon = {
  id: 'coupon-b',
  exhibitorId: 'exhibitor-b',
  exhibitorName: 'ベータ商会',
  title: 'ノベルティ進呈',
  description: '',
  titleI18n: {},
  descriptionI18n: {},
  keywords: ['グッズ'],
  active: true,
  issuedBy: 'admin',
  paymentPending: false,
  feeAmount: null,
  approvalStatus: 'approved',
  claimFrom: null,
  claimUntil: null,
  useFrom: null,
  useUntil: null,
};
const claimedClaim: Pick<EventClaim, 'status'> = { status: 'claimed' };
const redeemedClaim: Pick<EventClaim, 'status'> = { status: 'redeemed' };

describe('evaluateRedemption（消込の権限）', () => {
  it('出店者は自社クーポンを消込できる', () => {
    expect(
      evaluateRedemption({ type: 'exhibitor', exhibitorId: 'exhibitor-a' }, couponA, claimedClaim),
    ).toEqual({ allowed: true });
  });
  it('出店者は他社のクーポンを消込できない', () => {
    expect(
      evaluateRedemption({ type: 'exhibitor', exhibitorId: 'exhibitor-b' }, couponA, claimedClaim),
    ).toEqual({ allowed: false, reason: 'not-owner' });
  });
  it('主催者はどの出店者のクーポンも消込できる', () => {
    expect(evaluateRedemption({ type: 'organizer' }, couponA, claimedClaim)).toEqual({ allowed: true });
    expect(evaluateRedemption({ type: 'organizer' }, couponB, claimedClaim)).toEqual({ allowed: true });
  });
  it('消込済みは二度消しできない（自社でも主催者でも）', () => {
    expect(
      evaluateRedemption({ type: 'exhibitor', exhibitorId: 'exhibitor-a' }, couponA, redeemedClaim),
    ).toEqual({ allowed: false, reason: 'already-redeemed' });
    expect(evaluateRedemption({ type: 'organizer' }, couponA, redeemedClaim)).toEqual({
      allowed: false,
      reason: 'already-redeemed',
    });
  });
  it('無効化されたクーポンは消込できない', () => {
    expect(
      evaluateRedemption(
        { type: 'exhibitor', exhibitorId: 'exhibitor-a' },
        { ...couponA, active: false },
        claimedClaim,
      ),
    ).toEqual({ allowed: false, reason: 'coupon-inactive' });
  });
  it('他社チェックが最優先（他社の消込済みを持ってきても not-owner）', () => {
    expect(
      evaluateRedemption({ type: 'exhibitor', exhibitorId: 'exhibitor-b' }, couponA, redeemedClaim),
    ).toEqual({ allowed: false, reason: 'not-owner' });
  });
});

describe('filterCoupons（検索）', () => {
  const all = [couponA, couponB];
  it('空のクエリは全件返す', () => {
    expect(filterCoupons(all, '')).toHaveLength(2);
    expect(filterCoupons(all, '  ')).toHaveLength(2);
  });
  it('会社名で検索できる', () => {
    expect(filterCoupons(all, 'ベータ').map((c) => c.id)).toEqual(['coupon-b']);
  });
  it('キーワードで検索できる', () => {
    expect(filterCoupons(all, '飲み物').map((c) => c.id)).toEqual(['coupon-a']);
  });
  it('タイトルで検索できる', () => {
    expect(filterCoupons(all, 'ノベルティ').map((c) => c.id)).toEqual(['coupon-b']);
  });
});

describe('isCouponCapReached（クーポン上限）', () => {
  it('上限未満は登録できる', () => {
    expect(isCouponCapReached(99, 100)).toBe(false);
    expect(isCouponCapReached(0, 100)).toBe(false);
  });
  it('上限に達したら登録できない', () => {
    expect(isCouponCapReached(100, 100)).toBe(true);
    expect(isCouponCapReached(101, 100)).toBe(true);
  });
  it('上限はイベントごとに変えられる前提で判定する', () => {
    expect(isCouponCapReached(100, 200)).toBe(false);
    expect(isCouponCapReached(200, 200)).toBe(true);
  });
});

describe('tallyClaimsByCoupon（取得・消込件数の集計）', () => {
  it('記録がなければ空の Map', () => {
    expect(tallyClaimsByCoupon([]).size).toBe(0);
  });
  it('クーポンごとに取得総数と消込数を数える', () => {
    const tally = tallyClaimsByCoupon([
      { couponId: 'coupon-a', status: 'claimed' },
      { couponId: 'coupon-a', status: 'redeemed' },
      { couponId: 'coupon-a', status: 'redeemed' },
      { couponId: 'coupon-b', status: 'claimed' },
    ]);
    expect(tally.get('coupon-a')).toEqual({ claimedCount: 3, redeemedCount: 2 });
    expect(tally.get('coupon-b')).toEqual({ claimedCount: 1, redeemedCount: 0 });
    expect(tally.get('coupon-c')).toBeUndefined();
  });
  it('全件消込済みなら取得数と消込数が一致する', () => {
    const tally = tallyClaimsByCoupon([
      { couponId: 'coupon-a', status: 'redeemed' },
      { couponId: 'coupon-a', status: 'redeemed' },
    ]);
    expect(tally.get('coupon-a')).toEqual({ claimedCount: 2, redeemedCount: 2 });
  });
});

describe('ID生成', () => {
  it('memberIdForPhone は決定的で電話番号そのものを含まない', () => {
    expect(memberIdForPhone('+819012345678')).toBe(memberIdForPhone('+819012345678'));
    expect(memberIdForPhone('+819012345678')).not.toContain('9012345678');
  });
  it('memberIdForDevice は決定的で、uid そのものを含まない64桁ハッシュ', () => {
    const uid = 'device-uid-abc123';
    expect(memberIdForDevice(uid)).toBe(memberIdForDevice(uid));
    expect(memberIdForDevice(uid)).toMatch(/^[0-9a-f]{64}$/);
    expect(memberIdForDevice(uid)).not.toContain(uid);
    // 前後の空白は取り除いてから導く（電話番号側と同じ作法）
    expect(memberIdForDevice(` ${uid} `)).toBe(memberIdForDevice(uid));
  });
  it('memberIdForDevice は電話番号の memberId と衝突しない', () => {
    // 同じ文字列でも、端末キーと電話キーでは別の本人として扱う
    expect(memberIdForDevice('+819012345678')).not.toBe(
      memberIdForPhone('+819012345678'),
    );
    expect(memberIdForDevice('uid-a')).not.toBe(memberIdForDevice('uid-b'));
  });
  it('claimId は memberId と couponId の組み合わせ', () => {
    expect(claimIdFor('m1', 'c1')).toBe('m1_c1');
  });
});

describe('parseExhibitorKind（アカウントの種類）', () => {
  it("'advertiser' だけを協賛、'spot' だけをスポットとし、それ以外は参加店に倒す", () => {
    expect(parseExhibitorKind('advertiser')).toBe('advertiser');
    expect(parseExhibitorKind('spot')).toBe('spot');
    expect(parseExhibitorKind('shop')).toBe('shop');
    // 旧ドキュメント（項目なし）は参加店
    expect(parseExhibitorKind(undefined)).toBe('shop');
    expect(parseExhibitorKind(null)).toBe('shop');
    expect(parseExhibitorKind('other')).toBe('shop');
    expect(parseExhibitorKind(1)).toBe('shop');
  });
});

describe('チェックポイント番号の読み取り（parseCheckpointNumber）', () => {
  it('1以上の整数だけが有効', () => {
    expect(parseCheckpointNumber(1)).toBe(1);
    expect(parseCheckpointNumber(12)).toBe(12);
    expect(parseCheckpointNumber(0)).toBeNull();
    expect(parseCheckpointNumber(-2)).toBeNull();
    expect(parseCheckpointNumber(1.5)).toBeNull();
    expect(parseCheckpointNumber('3')).toBeNull();
    expect(parseCheckpointNumber(undefined)).toBeNull();
    expect(parseCheckpointNumber(null)).toBeNull();
  });
});

describe('スタンプ認証方法（既定値・読み取り・正規化）', () => {
  it('種別の既定値: 参加店は店読み、スポットは置きQR、協賛はなし', () => {
    expect(defaultStampMethods('shop')).toEqual(['staff']);
    expect(defaultStampMethods('spot')).toEqual(['placed']);
    expect(defaultStampMethods('advertiser')).toEqual([]);
  });
  it('項目が無い旧ドキュメントは種別の既定値に倒す', () => {
    expect(parseStampMethods(undefined, 'shop')).toEqual(['staff']);
    expect(parseStampMethods(undefined, 'spot')).toEqual(['placed']);
    expect(parseStampMethods('staff', 'shop')).toEqual(['staff']);
  });
  it('保存済みの配列は有効な値だけを残す（空配列は尊重する）', () => {
    expect(parseStampMethods(['placed', 'staff', 'bogus'], 'shop')).toEqual([
      'staff',
      'placed',
    ]);
    expect(parseStampMethods([], 'shop')).toEqual([]);
    expect(parseStampMethods(['rotating'], 'spot')).toEqual(['rotating']);
  });
  it('書き込み時は1つ以上必須で、形式不正は例外', () => {
    expect(normalizeStampMethods(['rotating', 'placed'])).toEqual([
      'placed',
      'rotating',
    ]);
    expect(() => normalizeStampMethods([])).toThrow();
    expect(() => normalizeStampMethods(['bogus'])).toThrow();
    expect(() => normalizeStampMethods('staff')).toThrow();
  });
});

describe('findCheckpointNumberConflict（番号の重複）', () => {
  const base: EventExhibitor = {
    id: 'cp-a',
    name: 'A',
    email: null,
    address: null,
    hasAccessCode: false,
    lang: 'ja',
    kind: 'shop',
    source: 'admin',
    delistedAt: null,
    closedAt: null,
    stampCode: null,
    checkpointNumber: 2,
    stampMethods: ['staff'],
    gpsCheck: false,
    velocityCheck: false,
  };
  it('他のチェックポイントが同じ番号を持てば重複', () => {
    const conflict = findCheckpointNumberConflict([base], 'cp-b', 2);
    expect(conflict?.id).toBe('cp-a');
  });
  it('自分自身・協賛・閉店扱い・番号なしは重複に数えない', () => {
    expect(findCheckpointNumberConflict([base], 'cp-a', 2)).toBeNull();
    expect(
      findCheckpointNumberConflict(
        [{ ...base, id: 'cp-c', kind: 'advertiser' }],
        'cp-b',
        2,
      ),
    ).toBeNull();
    expect(
      findCheckpointNumberConflict(
        [{ ...base, id: 'cp-c', closedAt: '2026-11-01T00:00:00.000Z' }],
        'cp-b',
        2,
      ),
    ).toBeNull();
    expect(
      findCheckpointNumberConflict(
        [{ ...base, id: 'cp-c', checkpointNumber: null }],
        'cp-b',
        2,
      ),
    ).toBeNull();
    expect(findCheckpointNumberConflict([base], 'cp-b', 3)).toBeNull();
  });
});

describe('updateExhibitorCheckpointSettings（保存と重複エラー）', () => {
  beforeEach(() => {
    fakeExhibitorDocs.docs.clear();
    fakeExhibitorDocs.docs.set('event-1/cp-a', {
      name: '店A',
      kind: 'shop',
      checkpointNumber: 1,
      stampMethods: ['staff'],
    });
    fakeExhibitorDocs.docs.set('event-1/spot-b', {
      name: '展望台',
      kind: 'spot',
      checkpointNumber: 2,
      stampMethods: ['placed'],
    });
  });

  it('番号・認証方法・追加チェックを保存できる', async () => {
    const result = await updateExhibitorCheckpointSettings('event-1', 'spot-b', {
      checkpointNumber: 5,
      stampMethods: ['placed', 'rotating'],
      gpsCheck: true,
      velocityCheck: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.exhibitor.checkpointNumber).toBe(5);
      expect(result.exhibitor.stampMethods).toEqual(['placed', 'rotating']);
      expect(result.exhibitor.gpsCheck).toBe(true);
      expect(result.exhibitor.velocityCheck).toBe(true);
    }
  });

  it('他のチェックポイントと同じ番号は 409 で拒否する', async () => {
    const result = await updateExhibitorCheckpointSettings('event-1', 'spot-b', {
      checkpointNumber: 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toContain('店A');
    }
    // 保存されていないこと
    expect(fakeExhibitorDocs.docs.get('event-1/spot-b')?.checkpointNumber).toBe(2);
  });

  it('自分の番号のままなら重複にならない', async () => {
    const result = await updateExhibitorCheckpointSettings('event-1', 'cp-a', {
      checkpointNumber: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('番号のクリア（null）と不正な番号・方法なしを扱う', async () => {
    const cleared = await updateExhibitorCheckpointSettings('event-1', 'cp-a', {
      checkpointNumber: null,
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.exhibitor.checkpointNumber).toBeNull();

    const invalid = await updateExhibitorCheckpointSettings('event-1', 'cp-a', {
      checkpointNumber: 0,
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.status).toBe(400);

    const noMethods = await updateExhibitorCheckpointSettings('event-1', 'cp-a', {
      stampMethods: [],
    });
    expect(noMethods.ok).toBe(false);
    if (!noMethods.ok) expect(noMethods.status).toBe(400);
  });

  it('対象が無ければ 404、協賛は 400', async () => {
    const missing = await updateExhibitorCheckpointSettings('event-1', 'nope', {
      gpsCheck: true,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(404);

    fakeExhibitorDocs.docs.set('event-1/sponsor', {
      name: '協賛企業',
      kind: 'advertiser',
    });
    const sponsor = await updateExhibitorCheckpointSettings('event-1', 'sponsor', {
      gpsCheck: true,
    });
    expect(sponsor.ok).toBe(false);
    if (!sponsor.ok) expect(sponsor.status).toBe(400);
  });
});

describe('parseCouponIssuedBy（クーポンの発行元）', () => {
  it("'shop' だけを店舗発行とし、それ以外は主催者発行に倒す", () => {
    expect(parseCouponIssuedBy('shop')).toBe('shop');
    expect(parseCouponIssuedBy('admin')).toBe('admin');
    // 旧ドキュメント（項目なし）は主催者発行
    expect(parseCouponIssuedBy(undefined)).toBe('admin');
    expect(parseCouponIssuedBy(null)).toBe('admin');
    expect(parseCouponIssuedBy('other')).toBe('admin');
  });
});

describe('クーポンの取得・使用期間', () => {
  it('parseCouponWindowDate は形式が合う日付だけ通す', () => {
    expect(parseCouponWindowDate('2026-12-01')).toBe('2026-12-01');
    expect(parseCouponWindowDate('2026/12/01')).toBeNull();
    expect(parseCouponWindowDate(undefined)).toBeNull();
    expect(parseCouponWindowDate(null)).toBeNull();
    expect(parseCouponWindowDate(20261201)).toBeNull();
  });

  it('normalizeCouponWindows は未指定を制限なしにし、逆転した期間を弾く', () => {
    expect(normalizeCouponWindows({})).toEqual({
      claimFrom: null,
      claimUntil: null,
      useFrom: null,
      useUntil: null,
    });
    expect(
      normalizeCouponWindows({ claimFrom: '2026-11-01', useUntil: '2026-12-31' }),
    ).toEqual({
      claimFrom: '2026-11-01',
      claimUntil: null,
      useFrom: null,
      useUntil: '2026-12-31',
    });
    expect(() =>
      normalizeCouponWindows({ claimFrom: '2026-12-02', claimUntil: '2026-12-01' }),
    ).toThrow();
    expect(() =>
      normalizeCouponWindows({ useFrom: '2026-12-02', useUntil: '2026-12-01' }),
    ).toThrow();
    expect(() => normalizeCouponWindows({ claimFrom: '2026-02-31' })).toThrow();
    expect(() => normalizeCouponWindows({ claimFrom: '12/01' })).toThrow();
  });

  it('couponClaimState は開始前・期間内・終了後を切り分ける（境界日は期間内）', () => {
    const coupon = { claimFrom: '2026-11-10', claimUntil: '2026-11-20' };
    expect(couponClaimState(coupon, '2026-11-09')).toBe('upcoming');
    expect(couponClaimState(coupon, '2026-11-10')).toBe('open');
    expect(couponClaimState(coupon, '2026-11-20')).toBe('open');
    expect(couponClaimState(coupon, '2026-11-21')).toBe('closed');
    expect(couponClaimState({ claimFrom: null, claimUntil: null }, '2026-11-15')).toBe('open');
  });

  it('isCouponUseAllowedOn は使用期間の内外を判定する', () => {
    const coupon = { useFrom: '2026-12-01', useUntil: '2026-12-31' };
    expect(isCouponUseAllowedOn(coupon, '2026-11-30')).toBe(false);
    expect(isCouponUseAllowedOn(coupon, '2026-12-01')).toBe(true);
    expect(isCouponUseAllowedOn(coupon, '2026-12-31')).toBe(true);
    expect(isCouponUseAllowedOn(coupon, '2027-01-01')).toBe(false);
    expect(isCouponUseAllowedOn({ useFrom: null, useUntil: null }, '2026-12-15')).toBe(true);
  });

  it('jstTodayString は JST の日付を返す', () => {
    // UTC 2026-11-23 16:30 = JST 2026-11-24 01:30
    expect(jstTodayString(new Date('2026-11-23T16:30:00.000Z'))).toBe('2026-11-24');
    expect(jstTodayString(new Date('2026-11-23T14:59:00.000Z'))).toBe('2026-11-23');
  });

  it('evaluateRedemption は使用期間外を弾き、日付未指定では判定しない', () => {
    const windowed = { ...couponA, useFrom: '2026-12-01', useUntil: '2026-12-31' };
    expect(
      evaluateRedemption({ type: 'organizer' }, windowed, claimedClaim, '2026-11-30'),
    ).toEqual({ allowed: false, reason: 'outside-use-window' });
    expect(
      evaluateRedemption({ type: 'organizer' }, windowed, claimedClaim, '2026-12-15'),
    ).toEqual({ allowed: true });
    // 日付を渡さない従来の呼び出しでは期間判定をしない
    expect(evaluateRedemption({ type: 'organizer' }, windowed, claimedClaim)).toEqual({
      allowed: true,
    });
    // 消込済みは期間より先に already-redeemed で返す
    expect(
      evaluateRedemption({ type: 'organizer' }, windowed, redeemedClaim, '2026-11-30'),
    ).toEqual({ allowed: false, reason: 'already-redeemed' });
  });
});

describe('parseCouponApprovalStatus（クーポンの承認状態）', () => {
  it("'pending' / 'rejected' を読み、それ以外は承認済みに倒す", () => {
    expect(parseCouponApprovalStatus('pending')).toBe('pending');
    expect(parseCouponApprovalStatus('rejected')).toBe('rejected');
    expect(parseCouponApprovalStatus('approved')).toBe('approved');
    // 旧ドキュメント（項目なし）は承認済み（従来どおり公開されていた）
    expect(parseCouponApprovalStatus(undefined)).toBe('approved');
    expect(parseCouponApprovalStatus(null)).toBe('approved');
    expect(parseCouponApprovalStatus('other')).toBe('approved');
  });
});
