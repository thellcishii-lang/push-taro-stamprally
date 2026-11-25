import { describe, expect, it } from 'vitest';
import {
  EventConfig,
  MAX_CONCURRENT_EVENTS,
  canCreateAnotherEvent,
  canDeleteEvent,
  countConcurrentEvents,
  countsTowardConcurrentCap,
  isFinalizationDue,
  isResetDue,
  isValidResetTime,
  isValidRankingMinReviews,
  isValidReviewCategories,
  isValidStampGoalCount,
  isValidStampRewardType,
  isValidAdsPrice,
  isValidAdsSlots,
  isValidCouponIssuePrice,
  isValidLoginBonusDays,
  isValidPushPrice,
  isValidShopMonthlyPrice,
  normalizeAdsPrice,
  normalizeAdsSlots,
  normalizeCouponIssuePrice,
  normalizePushPrice,
  normalizeReviewCategories,
  normalizeShopMonthlyPrice,
  normalizeStampBenefitText,
  normalizeStampMilestones,
  normalizeStampRewardType,
  parseAdsPrice,
  parseAdsSlots,
  parseCouponIssuePrice,
  parseLoginBonusDays,
  parsePushPrice,
  parseShopMonthlyPrice,
  parseRankingMinReviews,
  parseReviewCategories,
  parseStampBenefitText,
  parseStampGoalCount,
  parseStampMilestones,
  parseStampRewardType,
  validateStampRewardSettings,
  receivesCapsPropagation,
  resolveCreateStatus,
  subscriberUsage,
  jstDateString,
  jstTimeString,
} from './event';

const baseEvent: Pick<
  EventConfig,
  'startDate' | 'endDate' | 'resetTime' | 'lastResetDate' | 'status'
> = {
  startDate: '2026-11-07',
  endDate: '2026-11-08',
  resetTime: '00:00',
  lastResetDate: null,
  status: 'live',
};

// JST 2026-11-07 00:30 の Date（UTC では前日 15:30）
const jst = (isoUtc: string) => new Date(isoUtc);

describe('jstDateString / jstTimeString', () => {
  it('UTC 15:30 は JST 翌日 00:30 として扱う', () => {
    const d = jst('2026-11-06T15:30:00Z');
    expect(jstDateString(d)).toBe('2026-11-07');
    expect(jstTimeString(d)).toBe('00:30');
  });
});

describe('isValidResetTime', () => {
  it('正常系', () => {
    expect(isValidResetTime('00:00')).toBe(true);
    expect(isValidResetTime('04:30')).toBe(true);
    expect(isValidResetTime('23:59')).toBe(true);
  });
  it('異常系', () => {
    expect(isValidResetTime('24:00')).toBe(false);
    expect(isValidResetTime('9:00')).toBe(false);
    expect(isValidResetTime('00:60')).toBe(false);
  });
});

describe('isResetDue', () => {
  it('開催初日、設定時刻を過ぎていれば due', () => {
    expect(isResetDue(baseEvent, jst('2026-11-06T15:30:00Z'))).toBe(true);
  });

  it('設定時刻より前なら not due（夜間イベント想定: resetTime 04:00）', () => {
    const night = { ...baseEvent, resetTime: '04:00' };
    // JST 03:00
    expect(isResetDue(night, jst('2026-11-06T18:00:00Z'))).toBe(false);
    // JST 04:00 ちょうど
    expect(isResetDue(night, jst('2026-11-06T19:00:00Z'))).toBe(true);
  });

  it('今日分が実施済みなら not due（二重実行防止）', () => {
    const done = { ...baseEvent, lastResetDate: '2026-11-07' };
    expect(isResetDue(done, jst('2026-11-06T15:30:00Z'))).toBe(false);
  });

  it('開催期間外は not due', () => {
    // JST 2026-11-06（開始前）
    expect(isResetDue(baseEvent, jst('2026-11-05T15:30:00Z'))).toBe(false);
    // JST 2026-11-09（終了後）
    expect(isResetDue(baseEvent, jst('2026-11-08T15:30:00Z'))).toBe(false);
  });

  it('live でなければ not due', () => {
    expect(
      isResetDue({ ...baseEvent, status: 'draft' }, jst('2026-11-06T15:30:00Z')),
    ).toBe(false);
  });
});

describe('isFinalizationDue', () => {
  const fin = { endDate: '2026-11-08', finalizedAt: null as string | null };
  it('終了日の翌日以降で due', () => {
    // JST 2026-11-09
    expect(isFinalizationDue(fin, jst('2026-11-08T15:00:00Z'))).toBe(true);
  });
  it('終了日当日は not due', () => {
    // JST 2026-11-08
    expect(isFinalizationDue(fin, jst('2026-11-07T15:00:00Z'))).toBe(false);
  });
  it('finalized 済みなら not due', () => {
    expect(
      isFinalizationDue(
        { ...fin, finalizedAt: '2026-11-09T00:00:00.000Z' },
        jst('2026-11-08T15:00:00Z'),
      ),
    ).toBe(false);
  });
});

describe('同時イベント上限（MAX_CONCURRENT_EVENTS）', () => {
  const ev = (status: EventConfig['status']) => ({ status });

  it('上限は1（ポータルが1つだからラリーも1つ）', () => {
    expect(MAX_CONCURRENT_EVENTS).toBe(1);
  });

  it('終了したイベントは数えない', () => {
    expect(countsTowardConcurrentCap(ev('draft'))).toBe(true);
    expect(countsTowardConcurrentCap(ev('live'))).toBe(true);
    expect(countsTowardConcurrentCap(ev('ended'))).toBe(false);
    expect(
      countConcurrentEvents([ev('live'), ev('ended'), ev('draft'), ev('ended')]),
    ).toBe(2);
  });

  it('イベントが無ければ作成できる', () => {
    expect(canCreateAnotherEvent([])).toBe(true);
  });

  it('終了分だけなら作成できる（終了分は含めない）', () => {
    expect(canCreateAnotherEvent([ev('ended'), ev('ended')])).toBe(true);
  });

  it('下書きか開催中が1つでもあれば作成できない（上限1）', () => {
    expect(canCreateAnotherEvent([ev('draft')])).toBe(false);
    expect(canCreateAnotherEvent([ev('live'), ev('ended')])).toBe(false);
    expect(
      canCreateAnotherEvent([ev('draft'), ev('live'), ev('ended')]),
    ).toBe(false);
  });
});

describe('枠伝播の対象（receivesCapsPropagation）', () => {
  const ev = (status: EventConfig['status'], finalizedAt: string | null = null) => ({
    status,
    finalizedAt,
  });

  it('下書き・開催中は伝播対象', () => {
    expect(receivesCapsPropagation(ev('draft'))).toBe(true);
    expect(receivesCapsPropagation(ev('live'))).toBe(true);
  });

  it('終了したイベントは対象外（枠は履歴として触らない）', () => {
    expect(receivesCapsPropagation(ev('ended'))).toBe(false);
  });

  it('終了処理が完了したイベントはステータスによらず対象外', () => {
    expect(receivesCapsPropagation(ev('live', '2026-11-09T00:00:00.000Z'))).toBe(false);
    expect(receivesCapsPropagation(ev('draft', '2026-11-09T00:00:00.000Z'))).toBe(false);
  });
});

describe('作成時の状態指定（resolveCreateStatus）', () => {
  it('未指定は下書き', () => {
    expect(resolveCreateStatus(undefined)).toBe('draft');
    expect(resolveCreateStatus(null)).toBe('draft');
  });

  it('下書き・開催中はそのまま通す', () => {
    expect(resolveCreateStatus('draft')).toBe('draft');
    expect(resolveCreateStatus('live')).toBe('live');
  });

  it('終了や不正な値は例外（作成時には選べない）', () => {
    expect(() => resolveCreateStatus('ended')).toThrow();
    expect(() => resolveCreateStatus('published')).toThrow();
    expect(() => resolveCreateStatus(1)).toThrow();
    expect(() => resolveCreateStatus({})).toThrow();
  });
});

describe('削除できるイベント（canDeleteEvent）', () => {
  const ev = (status: EventConfig['status']) => ({ status });

  it('下書きと終了は削除できる', () => {
    expect(canDeleteEvent(ev('draft'))).toBe(true);
    expect(canDeleteEvent(ev('ended'))).toBe(true);
  });

  it('開催中は削除できない（先に終了させる運用）', () => {
    expect(canDeleteEvent(ev('live'))).toBe(false);
  });
});

describe('subscriberUsage', () => {
  it('通常域は percent を丸めて normal', () => {
    expect(subscriberUsage(250, 1000)).toEqual({ percent: 25, level: 'normal' });
    expect(subscriberUsage(0, 50000)).toEqual({ percent: 0, level: 'normal' });
  });

  it('90%以上で warning', () => {
    expect(subscriberUsage(900, 1000)).toEqual({ percent: 90, level: 'warning' });
    expect(subscriberUsage(899, 1000).level).toBe('normal');
  });

  it('上限到達で full、percent は 100 で頭打ち', () => {
    expect(subscriberUsage(1000, 1000)).toEqual({ percent: 100, level: 'full' });
    expect(subscriberUsage(1500, 1000)).toEqual({ percent: 100, level: 'full' });
  });

  it('枠が 0 以下なら 0% normal', () => {
    expect(subscriberUsage(10, 0)).toEqual({ percent: 0, level: 'normal' });
  });
});

describe('スタンプ達成個数（stampGoalCount）', () => {
  it('1〜200 の整数だけが有効', () => {
    expect(isValidStampGoalCount(1)).toBe(true);
    expect(isValidStampGoalCount(5)).toBe(true);
    expect(isValidStampGoalCount(10)).toBe(true);
    expect(isValidStampGoalCount(200)).toBe(true);
    expect(isValidStampGoalCount(0)).toBe(false);
    expect(isValidStampGoalCount(201)).toBe(false);
    expect(isValidStampGoalCount(2.5)).toBe(false);
    expect(isValidStampGoalCount('5')).toBe(false);
    expect(isValidStampGoalCount(undefined)).toBe(false);
    expect(isValidStampGoalCount(null)).toBe(false);
  });
  it('読み取り時は不正な値を既定値 5 に倒す', () => {
    expect(parseStampGoalCount(3)).toBe(3);
    expect(parseStampGoalCount(undefined)).toBe(5);
    expect(parseStampGoalCount(0)).toBe(5);
    expect(parseStampGoalCount(201)).toBe(5);
    expect(parseStampGoalCount('3')).toBe(5);
  });
});

describe('途中の特典（stampMilestones）', () => {
  it('読み取り時は有効な要素だけを個数の昇順で返す', () => {
    expect(
      parseStampMilestones([
        { count: 5, rewardType: 'benefit', benefitText: 'グッズ進呈' },
        { count: 2, rewardType: 'free-dish', benefitText: '' },
      ]),
    ).toEqual([
      { count: 2, rewardType: 'free-dish', benefitText: '' },
      { count: 5, rewardType: 'benefit', benefitText: 'グッズ進呈' },
    ]);
  });
  it('読み取り時は未設定・配列でない値を空配列に倒す', () => {
    expect(parseStampMilestones(undefined)).toEqual([]);
    expect(parseStampMilestones(null)).toEqual([]);
    expect(parseStampMilestones('x')).toEqual([]);
    expect(parseStampMilestones([])).toEqual([]);
  });
  it('読み取り時は不正な要素を落とす', () => {
    expect(
      parseStampMilestones([
        { count: 0, rewardType: 'free-dish', benefitText: '' },
        { count: 201, rewardType: 'free-dish', benefitText: '' },
        { count: 2.5, rewardType: 'free-dish', benefitText: '' },
        { count: '3', rewardType: 'free-dish', benefitText: '' },
        // benefit なのに内容が無い要素は発行できないため落とす
        { count: 3, rewardType: 'benefit', benefitText: '' },
        { count: 4, rewardType: 'unknown', benefitText: '' },
        'not-an-object',
        null,
        { count: 6, rewardType: 'free-dish', benefitText: '' },
      ]),
    ).toEqual([
      // 未知の種類は従来種別（free-dish）に倒して残る
      { count: 4, rewardType: 'free-dish', benefitText: '' },
      { count: 6, rewardType: 'free-dish', benefitText: '' },
    ]);
  });
  it('読み取り時は同じ個数が複数あれば最初の1件を採用する', () => {
    expect(
      parseStampMilestones([
        { count: 3, rewardType: 'benefit', benefitText: '最初の特典' },
        { count: 3, rewardType: 'free-dish', benefitText: '' },
      ]),
    ).toEqual([{ count: 3, rewardType: 'benefit', benefitText: '最初の特典' }]);
  });
  it('書き込み時は未指定を空配列にし、有効な入力を昇順で正規化する', () => {
    expect(normalizeStampMilestones(undefined)).toEqual([]);
    expect(normalizeStampMilestones(null)).toEqual([]);
    expect(
      normalizeStampMilestones([
        { count: 5, rewardType: 'benefit', benefitText: ' グッズ進呈 ' },
        { count: 2, rewardType: 'free-dish' },
      ]),
    ).toEqual([
      { count: 2, rewardType: 'free-dish', benefitText: '' },
      { count: 5, rewardType: 'benefit', benefitText: 'グッズ進呈' },
    ]);
  });
  it('書き込み時は不正な入力を throw する', () => {
    expect(() => normalizeStampMilestones('x')).toThrow();
    expect(() =>
      normalizeStampMilestones([{ count: 0, rewardType: 'free-dish' }]),
    ).toThrow();
    expect(() =>
      normalizeStampMilestones([{ count: 201, rewardType: 'free-dish' }]),
    ).toThrow();
    expect(() =>
      normalizeStampMilestones([{ count: 3, rewardType: 'benefit' }]),
    ).toThrow();
    expect(() =>
      normalizeStampMilestones([
        { count: 3, rewardType: 'free-dish' },
        { count: 3, rewardType: 'free-dish' },
      ]),
    ).toThrow();
  });
  it('件数の上限は設けない（多い件数でもそのまま通る）', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      count: i + 1,
      rewardType: 'free-dish' as const,
      benefitText: '',
    }));
    expect(parseStampMilestones(many)).toHaveLength(30);
    expect(normalizeStampMilestones(many)).toHaveLength(30);
  });
});

describe('ランキング最低レビュー件数（rankingMinReviews）', () => {
  it('1〜20 の整数だけが有効', () => {
    expect(isValidRankingMinReviews(1)).toBe(true);
    expect(isValidRankingMinReviews(3)).toBe(true);
    expect(isValidRankingMinReviews(20)).toBe(true);
    expect(isValidRankingMinReviews(0)).toBe(false);
    expect(isValidRankingMinReviews(21)).toBe(false);
    expect(isValidRankingMinReviews(2.5)).toBe(false);
    expect(isValidRankingMinReviews('3')).toBe(false);
    expect(isValidRankingMinReviews(undefined)).toBe(false);
    expect(isValidRankingMinReviews(null)).toBe(false);
  });
  it('読み取り時は不正な値を既定値 3 に倒す', () => {
    expect(parseRankingMinReviews(5)).toBe(5);
    expect(parseRankingMinReviews(undefined)).toBe(3);
    expect(parseRankingMinReviews(0)).toBe(3);
    expect(parseRankingMinReviews(99)).toBe(3);
    expect(parseRankingMinReviews('5')).toBe(3);
  });
});

describe('レビューの項目別評価の項目（reviewCategories）', () => {
  const defaults = ['味', '接客', '雰囲気', '盛り付け'];

  it('1〜6件・各1〜10文字・重複なしだけが有効', () => {
    expect(isValidReviewCategories(defaults)).toBe(true);
    expect(isValidReviewCategories(['味'])).toBe(true);
    expect(isValidReviewCategories(['a', 'b', 'c', 'd', 'e', 'f'])).toBe(true);
    expect(isValidReviewCategories([])).toBe(false);
    expect(isValidReviewCategories(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe(false);
    expect(isValidReviewCategories([''])).toBe(false);
    expect(isValidReviewCategories(['   '])).toBe(false);
    expect(isValidReviewCategories(['あ'.repeat(10)])).toBe(true);
    expect(isValidReviewCategories(['あ'.repeat(11)])).toBe(false);
    expect(isValidReviewCategories(['味', '味'])).toBe(false);
    expect(isValidReviewCategories(['味', ' 味 '])).toBe(false);
    expect(isValidReviewCategories(['味', 5])).toBe(false);
    expect(isValidReviewCategories('味')).toBe(false);
    expect(isValidReviewCategories(undefined)).toBe(false);
    expect(isValidReviewCategories(null)).toBe(false);
  });

  it('読み取り時は未設定・不正な値を既定の4項目に倒し、有効な値は空白を落とす', () => {
    expect(parseReviewCategories(undefined)).toEqual(defaults);
    expect(parseReviewCategories(null)).toEqual(defaults);
    expect(parseReviewCategories([])).toEqual(defaults);
    expect(parseReviewCategories(['味', '味'])).toEqual(defaults);
    expect(parseReviewCategories([' コスパ ', '味'])).toEqual(['コスパ', '味']);
    expect(parseReviewCategories(defaults)).toEqual(defaults);
  });

  it('書き込み時は未指定を既定の4項目にし、不正な値は throw する', () => {
    expect(normalizeReviewCategories(undefined)).toEqual(defaults);
    expect(normalizeReviewCategories(null)).toEqual(defaults);
    expect(normalizeReviewCategories([' 量 ', 'コスパ'])).toEqual(['量', 'コスパ']);
    expect(() => normalizeReviewCategories([])).toThrow();
    expect(() => normalizeReviewCategories(['味', '味'])).toThrow();
    expect(() => normalizeReviewCategories(['あ'.repeat(11)])).toThrow();
    expect(() => normalizeReviewCategories('味')).toThrow();
  });
});

describe('スタンプ達成特典（stampRewardType / stampBenefitText）', () => {
  it('種類は free-dish と benefit だけが有効', () => {
    expect(isValidStampRewardType('free-dish')).toBe(true);
    expect(isValidStampRewardType('benefit')).toBe(true);
    expect(isValidStampRewardType('free')).toBe(false);
    expect(isValidStampRewardType('')).toBe(false);
    expect(isValidStampRewardType(undefined)).toBe(false);
    expect(isValidStampRewardType(null)).toBe(false);
    expect(isValidStampRewardType(1)).toBe(false);
  });
  it('読み取り時は未設定・不正な値を free-dish（従来の挙動）に倒す', () => {
    expect(parseStampRewardType('benefit')).toBe('benefit');
    expect(parseStampRewardType('free-dish')).toBe('free-dish');
    expect(parseStampRewardType(undefined)).toBe('free-dish');
    expect(parseStampRewardType(null)).toBe('free-dish');
    expect(parseStampRewardType('unknown')).toBe('free-dish');
  });
  it('特典の内容の読み取りは未設定を空文字にし、上限で切り詰める', () => {
    expect(parseStampBenefitText('特製グッズをプレゼント')).toBe(
      '特製グッズをプレゼント',
    );
    expect(parseStampBenefitText(undefined)).toBe('');
    expect(parseStampBenefitText(null)).toBe('');
    expect(parseStampBenefitText(123)).toBe('');
    expect(parseStampBenefitText('あ'.repeat(150))).toBe('あ'.repeat(100));
  });
  it('保存時は種類を検証し、未指定は free-dish', () => {
    expect(normalizeStampRewardType(undefined)).toBe('free-dish');
    expect(normalizeStampRewardType(null)).toBe('free-dish');
    expect(normalizeStampRewardType('benefit')).toBe('benefit');
    expect(() => normalizeStampRewardType('free')).toThrow();
    expect(() => normalizeStampRewardType(1)).toThrow();
  });
  it('保存時は特典の内容を検証し、100文字を超えたらエラー', () => {
    expect(normalizeStampBenefitText(undefined)).toBe('');
    expect(normalizeStampBenefitText('  特製グッズ  ')).toBe('特製グッズ');
    expect(normalizeStampBenefitText('あ'.repeat(100))).toBe('あ'.repeat(100));
    expect(() => normalizeStampBenefitText('あ'.repeat(101))).toThrow();
    expect(() => normalizeStampBenefitText(123)).toThrow();
  });
  it('benefit で内容が空なら組み合わせエラー（free-dish は空でも可）', () => {
    expect(() =>
      validateStampRewardSettings('benefit', ''),
    ).toThrow('特典の内容を入力してください');
    expect(() =>
      validateStampRewardSettings('benefit', '特製グッズをプレゼント'),
    ).not.toThrow();
    expect(() => validateStampRewardSettings('free-dish', '')).not.toThrow();
    expect(() =>
      validateStampRewardSettings('free-dish', '残っている文面'),
    ).not.toThrow();
  });
});

describe('ログインボーナス設定（loginBonusEnabled / loginBonusDays）', () => {
  it('必要日数は 5〜20 の整数だけを受け付ける', () => {
    expect(isValidLoginBonusDays(5)).toBe(true);
    expect(isValidLoginBonusDays(7)).toBe(true);
    expect(isValidLoginBonusDays(20)).toBe(true);
    expect(isValidLoginBonusDays(4)).toBe(false);
    expect(isValidLoginBonusDays(21)).toBe(false);
    expect(isValidLoginBonusDays(7.5)).toBe(false);
    expect(isValidLoginBonusDays('7')).toBe(false);
    expect(isValidLoginBonusDays(null)).toBe(false);
  });

  it('読み取り用 parse は不正値を既定の 7 に倒す', () => {
    expect(parseLoginBonusDays(10)).toBe(10);
    expect(parseLoginBonusDays(undefined)).toBe(7);
    expect(parseLoginBonusDays(4)).toBe(7);
    expect(parseLoginBonusDays(21)).toBe(7);
    expect(parseLoginBonusDays('10')).toBe(7);
  });

});

describe('広告設定（adsEnabled / adsSlots / adsPrice）', () => {
  it('枠数は 1〜50 の整数だけを受け付ける', () => {
    expect(isValidAdsSlots(1)).toBe(true);
    expect(isValidAdsSlots(5)).toBe(true);
    expect(isValidAdsSlots(50)).toBe(true);
    expect(isValidAdsSlots(0)).toBe(false);
    expect(isValidAdsSlots(51)).toBe(false);
    expect(isValidAdsSlots(2.5)).toBe(false);
  });

  it('枠数の parse は不正値を既定の 5 に倒し、normalize は throw', () => {
    expect(parseAdsSlots(12)).toBe(12);
    expect(parseAdsSlots(undefined)).toBe(5);
    expect(parseAdsSlots(0)).toBe(5);
    expect(normalizeAdsSlots(undefined)).toBe(5);
    expect(normalizeAdsSlots(3)).toBe(3);
    expect(() => normalizeAdsSlots(0)).toThrow();
    expect(() => normalizeAdsSlots(51)).toThrow();
  });

  it('広告料金は 0（無料）を含む 0 以上の整数だけを受け付ける', () => {
    expect(isValidAdsPrice(0)).toBe(true);
    expect(isValidAdsPrice(3000)).toBe(true);
    expect(isValidAdsPrice(-1)).toBe(false);
    expect(isValidAdsPrice(100.5)).toBe(false);
    expect(isValidAdsPrice('3000')).toBe(false);
    expect(isValidAdsPrice(null)).toBe(false);
  });

  it('広告料金の parse は 0 を 0 として読み、不正値は null（未設定）', () => {
    expect(parseAdsPrice(0)).toBe(0);
    expect(parseAdsPrice(3000)).toBe(3000);
    expect(parseAdsPrice(undefined)).toBeNull();
    expect(parseAdsPrice(null)).toBeNull();
    expect(parseAdsPrice(-100)).toBeNull();
  });

  it('広告料金の normalize は未指定を null、0 を 0 として通す', () => {
    expect(normalizeAdsPrice(undefined)).toBeNull();
    expect(normalizeAdsPrice(null)).toBeNull();
    expect(normalizeAdsPrice(0)).toBe(0);
    expect(normalizeAdsPrice(5000)).toBe(5000);
    expect(() => normalizeAdsPrice(-1)).toThrow();
    expect(() => normalizeAdsPrice(100.5)).toThrow();
  });
});

describe('店舗手数料（couponIssuePrice / pushPrice）', () => {
  it('クーポン発行手数料は 0（無料）を含む 0 以上の整数だけを受け付ける', () => {
    expect(isValidCouponIssuePrice(0)).toBe(true);
    expect(isValidCouponIssuePrice(500)).toBe(true);
    expect(isValidCouponIssuePrice(1000000)).toBe(true);
    expect(isValidCouponIssuePrice(1000001)).toBe(false);
    expect(isValidCouponIssuePrice(-1)).toBe(false);
    expect(isValidCouponIssuePrice(100.5)).toBe(false);
    expect(isValidCouponIssuePrice('500')).toBe(false);
    expect(isValidCouponIssuePrice(null)).toBe(false);
  });

  it('クーポン発行手数料の parse は 0 を 0 として読み、不正値は null（未設定）', () => {
    expect(parseCouponIssuePrice(0)).toBe(0);
    expect(parseCouponIssuePrice(500)).toBe(500);
    expect(parseCouponIssuePrice(undefined)).toBeNull();
    expect(parseCouponIssuePrice(null)).toBeNull();
    expect(parseCouponIssuePrice(-100)).toBeNull();
  });

  it('クーポン発行手数料の normalize は未指定を null、0 を 0 として通す', () => {
    expect(normalizeCouponIssuePrice(undefined)).toBeNull();
    expect(normalizeCouponIssuePrice(null)).toBeNull();
    expect(normalizeCouponIssuePrice(0)).toBe(0);
    expect(normalizeCouponIssuePrice(500)).toBe(500);
    expect(() => normalizeCouponIssuePrice(-1)).toThrow();
    expect(() => normalizeCouponIssuePrice(100.5)).toThrow();
  });

  it('プッシュ配信手数料は 0（無料）を含む 0 以上の整数だけを受け付ける', () => {
    expect(isValidPushPrice(0)).toBe(true);
    expect(isValidPushPrice(3000)).toBe(true);
    expect(isValidPushPrice(1000000)).toBe(true);
    expect(isValidPushPrice(1000001)).toBe(false);
    expect(isValidPushPrice(-1)).toBe(false);
    expect(isValidPushPrice(100.5)).toBe(false);
    expect(isValidPushPrice('3000')).toBe(false);
    expect(isValidPushPrice(null)).toBe(false);
  });

  it('プッシュ配信手数料の parse は 0 を 0 として読み、不正値は null（未設定）', () => {
    expect(parsePushPrice(0)).toBe(0);
    expect(parsePushPrice(3000)).toBe(3000);
    expect(parsePushPrice(undefined)).toBeNull();
    expect(parsePushPrice(null)).toBeNull();
    expect(parsePushPrice(-100)).toBeNull();
  });

  it('プッシュ配信手数料の normalize は未指定を null、0 を 0 として通す', () => {
    expect(normalizePushPrice(undefined)).toBeNull();
    expect(normalizePushPrice(null)).toBeNull();
    expect(normalizePushPrice(0)).toBe(0);
    expect(normalizePushPrice(3000)).toBe(3000);
    expect(() => normalizePushPrice(-1)).toThrow();
    expect(() => normalizePushPrice(100.5)).toThrow();
  });
});

describe('参加店の自己登録の月額料金（shopMonthlyPrice）', () => {
  it('0（無料）〜1,000,000 の整数だけが有効', () => {
    expect(isValidShopMonthlyPrice(0)).toBe(true);
    expect(isValidShopMonthlyPrice(3000)).toBe(true);
    expect(isValidShopMonthlyPrice(1_000_000)).toBe(true);
    expect(isValidShopMonthlyPrice(1_000_001)).toBe(false);
    expect(isValidShopMonthlyPrice(-1)).toBe(false);
    expect(isValidShopMonthlyPrice(100.5)).toBe(false);
    expect(isValidShopMonthlyPrice('3000')).toBe(false);
    expect(isValidShopMonthlyPrice(null)).toBe(false);
  });

  it('読み取りは未設定・不正値を null（受け付けない）に倒し、0 は保持する', () => {
    expect(parseShopMonthlyPrice(0)).toBe(0);
    expect(parseShopMonthlyPrice(3000)).toBe(3000);
    expect(parseShopMonthlyPrice(undefined)).toBeNull();
    expect(parseShopMonthlyPrice(null)).toBeNull();
    expect(parseShopMonthlyPrice(-5)).toBeNull();
  });

  it('正規化は未指定・null を未設定にし、不正値で throw する', () => {
    expect(normalizeShopMonthlyPrice(undefined)).toBeNull();
    expect(normalizeShopMonthlyPrice(null)).toBeNull();
    expect(normalizeShopMonthlyPrice(0)).toBe(0);
    expect(normalizeShopMonthlyPrice(3000)).toBe(3000);
    expect(() => normalizeShopMonthlyPrice(-1)).toThrow();
    expect(() => normalizeShopMonthlyPrice(100.5)).toThrow();
  });
});
