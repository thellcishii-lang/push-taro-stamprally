import { describe, expect, it } from 'vitest';
import {
  buildActionReportCsv,
  summarizeActionReport,
  type ActionReportSponsors,
  type ActionReportUsageRecord,
} from './action-report';

const sponsors: ActionReportSponsors = {
  sponsorCount: 3,
  shopCount: 12,
  adSlotLiveCount: 2,
  adSlotTotalCount: 4,
  liveShopAdCount: 5,
};

function record(
  overrides: Partial<ActionReportUsageRecord> = {},
): ActionReportUsageRecord {
  return {
    claimId: 'claim-1',
    couponId: 'coupon-1',
    couponTitle: 'カレー100円引き',
    exhibitorId: 'shop-1',
    exhibitorName: 'カレー食堂',
    memberId: 'member-1',
    redeemedAt: '2026-11-10T03:00:00.000Z', // JST 2026-11-10 12:00
    ageBand: '30s',
    gender: 'female',
    ...overrides,
  };
}

describe('summarizeActionReport', () => {
  it('クーポン別・店舗別・年代別・性別に集計する', () => {
    const summary = summarizeActionReport(
      [
        record(),
        record({
          claimId: 'claim-2',
          couponId: 'coupon-2',
          couponTitle: 'ドリンク無料',
          ageBand: '30s',
          gender: 'male',
        }),
        record({
          claimId: 'claim-3',
          exhibitorId: 'shop-2',
          exhibitorName: 'そば処',
          ageBand: null,
          gender: null,
        }),
      ],
      sponsors,
    );
    expect(summary.totalUsed).toBe(3);
    expect(summary.sponsors).toEqual(sponsors);
    expect(summary.byCoupon).toHaveLength(2);
    expect(summary.byCoupon[0]).toMatchObject({ couponId: 'coupon-1', count: 2 });
    expect(summary.byShop).toHaveLength(2);
    const age = new Map(summary.byAgeBand.map((r) => [r.key, r.count]));
    expect(age.get('30s')).toBe(2);
    expect(age.get('unanswered')).toBe(1);
    const gender = new Map(summary.byGender.map((r) => [r.key, r.count]));
    expect(gender.get('female')).toBe(1);
    expect(gender.get('male')).toBe(1);
    expect(gender.get('unanswered')).toBe(1);
  });

  it('「回答しない」(no-answer) と「未回答」(null) を区別する', () => {
    const summary = summarizeActionReport(
      [
        record({ ageBand: 'no-answer', gender: 'no-answer' }),
        record({ claimId: 'claim-2', ageBand: null, gender: null }),
      ],
      sponsors,
    );
    const age = new Map(summary.byAgeBand.map((r) => [r.key, r.count]));
    expect(age.get('no-answer')).toBe(1);
    expect(age.get('unanswered')).toBe(1);
    const gender = new Map(summary.byGender.map((r) => [r.key, r.count]));
    expect(gender.get('no-answer')).toBe(1);
    expect(gender.get('unanswered')).toBe(1);
  });

  it('年代別・性別の行は全コード＋未回答を常に出す', () => {
    const summary = summarizeActionReport([], sponsors);
    expect(summary.byAgeBand).toHaveLength(10); // 9コード + 未回答
    expect(summary.byGender).toHaveLength(5); // 4コード + 未回答
    expect(summary.byAgeBand.at(-1)?.key).toBe('unanswered');
    expect(summary.byGender.at(-1)?.key).toBe('unanswered');
    expect(summary.totalUsed).toBe(0);
  });

  it('日次・月次は JST で切り分ける', () => {
    const summary = summarizeActionReport(
      [
        // UTC 2026-11-10 16:30 = JST 2026-11-11 01:30
        record({ redeemedAt: '2026-11-10T16:30:00.000Z' }),
        record({ claimId: 'claim-2', redeemedAt: '2026-11-10T03:00:00.000Z' }),
      ],
      sponsors,
    );
    expect(summary.daily).toEqual([
      { period: '2026-11-10', count: 1 },
      { period: '2026-11-11', count: 1 },
    ]);
    expect(summary.monthly).toEqual([{ period: '2026-11', count: 2 }]);
  });

  it('使用履歴は新しい順、日付として読めない記録は除く', () => {
    const summary = summarizeActionReport(
      [
        record({ claimId: 'old', redeemedAt: '2026-11-01T00:00:00.000Z' }),
        record({ claimId: 'new', redeemedAt: '2026-11-20T00:00:00.000Z' }),
        record({ claimId: 'bad', redeemedAt: 'not-a-date' }),
      ],
      sponsors,
    );
    expect(summary.usage.map((r) => r.claimId)).toEqual(['new', 'old']);
    expect(summary.totalUsed).toBe(2);
  });

  it('月・店舗・年代・性別のフィルターが効く', () => {
    const records = [
      record(),
      record({
        claimId: 'claim-2',
        exhibitorId: 'shop-2',
        exhibitorName: 'そば処',
        ageBand: '60s',
        gender: 'male',
        redeemedAt: '2026-10-05T03:00:00.000Z',
      }),
      record({ claimId: 'claim-3', ageBand: null, gender: null }),
    ];
    expect(summarizeActionReport(records, sponsors, { month: '2026-11' }).totalUsed).toBe(2);
    expect(summarizeActionReport(records, sponsors, { month: '2026-10' }).totalUsed).toBe(1);
    expect(
      summarizeActionReport(records, sponsors, { exhibitorId: 'shop-2' }).totalUsed,
    ).toBe(1);
    expect(
      summarizeActionReport(records, sponsors, { ageBand: '60s' }).totalUsed,
    ).toBe(1);
    expect(
      summarizeActionReport(records, sponsors, { ageBand: 'unanswered' }).totalUsed,
    ).toBe(1);
    expect(
      summarizeActionReport(records, sponsors, { gender: 'unanswered' }).totalUsed,
    ).toBe(1);
    expect(
      summarizeActionReport(records, sponsors, { gender: 'female' }).totalUsed,
    ).toBe(1);
  });
});

describe('buildActionReportCsv', () => {
  it('BOM付きで、協賛・広告と使用履歴のセクションを含む', () => {
    const summary = summarizeActionReport([record()], sponsors);
    const csv = buildActionReportCsv(summary);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('協賛社数,3');
    expect(csv).toContain('広告枠（掲載可/総数）,2,4');
    expect(csv).toContain('使用総数,1');
    expect(csv).toContain('カレー100円引き,カレー食堂,1');
    expect(csv).toContain('30代,1');
    expect(csv).toContain('女性,1');
    expect(csv).toContain('2026-11-10 12:00,カレー100円引き,カレー食堂,30代,女性');
    // 個人情報（電話番号など）は含めない設計: memberId は出さない
    expect(csv).not.toContain('member-1');
  });
});
