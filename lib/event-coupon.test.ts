// lib/event-coupon.test.ts
import { describe, expect, it } from 'vitest';
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
  parseCouponIssuedBy,
  parseCouponWindowDate,
  parseExhibitorKind,
  tallyClaimsByCoupon,
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
  it("'advertiser' だけを協賛とし、それ以外は参加店に倒す", () => {
    expect(parseExhibitorKind('advertiser')).toBe('advertiser');
    expect(parseExhibitorKind('shop')).toBe('shop');
    // 旧ドキュメント（項目なし）は参加店
    expect(parseExhibitorKind(undefined)).toBe('shop');
    expect(parseExhibitorKind(null)).toBe('shop');
    expect(parseExhibitorKind('other')).toBe('shop');
    expect(parseExhibitorKind(1)).toBe('shop');
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
