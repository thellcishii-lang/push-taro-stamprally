// lib/action-report.ts
// 主催者向け「行動レポート」の集計（純粋関数）。
// 報告書として出す3点 — (1) 協賛・広告の数 (2) クーポン使用履歴
// (3) クーポン使用の年代別・性別統計 — を、画面表示と CSV で共有する。
// データの読み込みは lib/action-report-data.ts が担い、ここは整形だけ。
//
// 守ること:
// - 電話番号はそもそも入力に含めない（レポートに出すのは件数と集計だけ）。
// - 年代・性別は「未回答」（null = 未選択・未取得）を別枠で集計する。
//   明示的に「回答しない」を選んだ 'no-answer' とは区別する。
// - 日付の切り分けは明細・集計CSVと同じ JST 基準。
import {
  AGE_BANDS,
  GENDERS,
  isAgeBand,
  isGender,
  type AgeBand,
  type Gender,
} from './member-demographics';
import { formatJstDateTime } from './event-billing';

/** クーポン使用1件（消込済み）。年代・性別は使用者の登録値。 */
export interface ActionReportUsageRecord {
  claimId: string;
  couponId: string;
  couponTitle: string;
  /** クーポンの発行元（チェックポイント＝参加店）。 */
  exhibitorId: string;
  exhibitorName: string;
  memberId: string;
  /** 消込日時（ISO文字列）。 */
  redeemedAt: string;
  /** null は「未回答」（未選択・未取得）。'no-answer' は明示の「回答しない」。 */
  ageBand: AgeBand | null;
  gender: Gender | null;
}

/** 協賛・広告まわりの件数（スナップショット。期間フィルターの対象外）。 */
export interface ActionReportSponsors {
  /** 協賛（kind='advertiser'）の数。 */
  sponsorCount: number;
  /** 参加店（kind='shop'）の数。 */
  shopCount: number;
  /** 広告枠のうち掲載可（active / past_due）の数。 */
  adSlotLiveCount: number;
  /** 広告枠の総数。 */
  adSlotTotalCount: number;
  /** 店舗広告で掲載中の件数。 */
  liveShopAdCount: number;
}

export type DemographicFilter<T extends string> = T | 'unanswered';

export interface ActionReportFilters {
  /** 'YYYY-MM'（JST）。その月の使用だけに絞る。 */
  month?: string;
  exhibitorId?: string;
  ageBand?: DemographicFilter<AgeBand>;
  gender?: DemographicFilter<Gender>;
}

export interface ActionReportCountRow<K extends string> {
  key: K;
  count: number;
}

export interface ActionReportCouponRow {
  couponId: string;
  couponTitle: string;
  exhibitorId: string;
  exhibitorName: string;
  count: number;
}

export interface ActionReportShopRow {
  exhibitorId: string;
  exhibitorName: string;
  count: number;
}

export interface ActionReportPeriodRow {
  period: string;
  count: number;
}

export interface ActionReportSummary {
  sponsors: ActionReportSponsors;
  /** フィルター適用後のクーポン使用総数。 */
  totalUsed: number;
  /** フィルター適用後の使用履歴（新しい順）。 */
  usage: ActionReportUsageRecord[];
  byCoupon: ActionReportCouponRow[];
  byShop: ActionReportShopRow[];
  /** AGE_BANDS の順＋最後に 'unanswered'。 */
  byAgeBand: ActionReportCountRow<AgeBand | 'unanswered'>[];
  /** GENDERS の順＋最後に 'unanswered'。 */
  byGender: ActionReportCountRow<Gender | 'unanswered'>[];
  daily: ActionReportPeriodRow[];
  monthly: ActionReportPeriodRow[];
}

/** クエリパラメータ（month / exhibitorId / ageBand / gender）をフィルターに寄せる。 */
export function parseActionReportFilters(
  searchParams: URLSearchParams,
): ActionReportFilters {
  const filters: ActionReportFilters = {};
  const month = searchParams.get('month');
  if (month && /^\d{4}-\d{2}$/.test(month)) filters.month = month;
  const exhibitorId = searchParams.get('exhibitorId');
  if (exhibitorId) filters.exhibitorId = exhibitorId;
  const ageBand = searchParams.get('ageBand');
  if (ageBand === 'unanswered') filters.ageBand = 'unanswered';
  else if (isAgeBand(ageBand)) filters.ageBand = ageBand;
  const gender = searchParams.get('gender');
  if (gender === 'unanswered') filters.gender = 'unanswered';
  else if (isGender(gender)) filters.gender = gender;
  return filters;
}

function matchesFilter<T extends string>(
  value: T | null,
  filter: DemographicFilter<T> | undefined,
): boolean {
  if (!filter) return true;
  if (filter === 'unanswered') return value === null;
  return value === filter;
}

const byCountThenName = (
  a: { count: number; name: string },
  b: { count: number; name: string },
): number => b.count - a.count || a.name.localeCompare(b.name, 'ja');

export function summarizeActionReport(
  records: ActionReportUsageRecord[],
  sponsors: ActionReportSponsors,
  filters: ActionReportFilters = {},
): ActionReportSummary {
  const filtered: ActionReportUsageRecord[] = [];
  for (const record of records) {
    const date = formatJstDateTime(record.redeemedAt).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (filters.month && date.slice(0, 7) !== filters.month) continue;
    if (filters.exhibitorId && record.exhibitorId !== filters.exhibitorId) {
      continue;
    }
    if (!matchesFilter(record.ageBand, filters.ageBand)) continue;
    if (!matchesFilter(record.gender, filters.gender)) continue;
    filtered.push(record);
  }
  filtered.sort((a, b) => b.redeemedAt.localeCompare(a.redeemedAt));

  const couponMap = new Map<string, ActionReportCouponRow>();
  const shopMap = new Map<string, ActionReportShopRow>();
  const ageMap = new Map<AgeBand | 'unanswered', number>();
  const genderMap = new Map<Gender | 'unanswered', number>();
  const dailyMap = new Map<string, number>();
  const monthlyMap = new Map<string, number>();

  for (const record of filtered) {
    const coupon = couponMap.get(record.couponId) ?? {
      couponId: record.couponId,
      couponTitle: record.couponTitle,
      exhibitorId: record.exhibitorId,
      exhibitorName: record.exhibitorName,
      count: 0,
    };
    coupon.count += 1;
    couponMap.set(record.couponId, coupon);

    const shop = shopMap.get(record.exhibitorId) ?? {
      exhibitorId: record.exhibitorId,
      exhibitorName: record.exhibitorName,
      count: 0,
    };
    shop.count += 1;
    shopMap.set(record.exhibitorId, shop);

    const ageKey = record.ageBand ?? 'unanswered';
    ageMap.set(ageKey, (ageMap.get(ageKey) ?? 0) + 1);
    const genderKey = record.gender ?? 'unanswered';
    genderMap.set(genderKey, (genderMap.get(genderKey) ?? 0) + 1);

    const date = formatJstDateTime(record.redeemedAt).slice(0, 10);
    dailyMap.set(date, (dailyMap.get(date) ?? 0) + 1);
    const month = date.slice(0, 7);
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + 1);
  }

  const byAgeBand: ActionReportSummary['byAgeBand'] = [
    ...AGE_BANDS.map((band) => ({ key: band, count: ageMap.get(band) ?? 0 })),
    { key: 'unanswered' as const, count: ageMap.get('unanswered') ?? 0 },
  ];
  const byGender: ActionReportSummary['byGender'] = [
    ...GENDERS.map((g) => ({ key: g, count: genderMap.get(g) ?? 0 })),
    { key: 'unanswered' as const, count: genderMap.get('unanswered') ?? 0 },
  ];

  return {
    sponsors,
    totalUsed: filtered.length,
    usage: filtered,
    byCoupon: [...couponMap.values()].sort((a, b) =>
      byCountThenName(
        { count: a.count, name: a.couponTitle },
        { count: b.count, name: b.couponTitle },
      ),
    ),
    byShop: [...shopMap.values()].sort((a, b) =>
      byCountThenName(
        { count: a.count, name: a.exhibitorName },
        { count: b.count, name: b.exhibitorName },
      ),
    ),
    byAgeBand,
    byGender,
    daily: [...dailyMap.entries()]
      .map(([period, count]) => ({ period, count }))
      .sort((a, b) => a.period.localeCompare(b.period)),
    monthly: [...monthlyMap.entries()]
      .map(([period, count]) => ({ period, count }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

// ─── CSV ───

function csvEscape(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(values: (string | number)[]): string {
  return values.map((v) => csvEscape(String(v))).join(',');
}

/** 年代コードの表示名（CSV用・日本語）。 */
export const AGE_BAND_LABEL_JA: Record<AgeBand | 'unanswered', string> = {
  'under-10': '10歳未満',
  '10s': '10代',
  '20s': '20代',
  '30s': '30代',
  '40s': '40代',
  '50s': '50代',
  '60s': '60代',
  '70-plus': '70歳以上',
  'no-answer': '回答しない',
  unanswered: '未回答',
};

/** 性別コードの表示名（CSV用・日本語）。 */
export const GENDER_LABEL_JA: Record<Gender | 'unanswered', string> = {
  male: '男性',
  female: '女性',
  other: 'その他',
  'no-answer': '回答しない',
  unanswered: '未回答',
};

/**
 * 行動レポートの CSV。画面と同じ集計を、セクション見出しつきの
 * 1ファイルで返す（提出・取り込み用）。BOM + CRLF（集計CSVと同じ）。
 * 電話番号などの個人情報は含めない。
 */
export function buildActionReportCsv(summary: ActionReportSummary): string {
  const lines: string[] = [];
  lines.push('行動レポート');
  lines.push('');
  lines.push('■ 協賛・広告');
  lines.push(csvRow(['協賛社数', summary.sponsors.sponsorCount]));
  lines.push(csvRow(['参加店数', summary.sponsors.shopCount]));
  lines.push(
    csvRow([
      '広告枠（掲載可/総数）',
      summary.sponsors.adSlotLiveCount,
      summary.sponsors.adSlotTotalCount,
    ]),
  );
  lines.push(csvRow(['掲載中の店舗広告', summary.sponsors.liveShopAdCount]));
  lines.push('');
  lines.push('■ クーポン使用');
  lines.push(csvRow(['使用総数', summary.totalUsed]));
  lines.push('');
  lines.push('クーポン別');
  lines.push(csvRow(['クーポン', '店舗', '使用数']));
  for (const row of summary.byCoupon) {
    lines.push(csvRow([row.couponTitle, row.exhibitorName, row.count]));
  }
  lines.push('');
  lines.push('店舗別');
  lines.push(csvRow(['店舗', '使用数']));
  for (const row of summary.byShop) {
    lines.push(csvRow([row.exhibitorName, row.count]));
  }
  lines.push('');
  lines.push('年代別');
  lines.push(csvRow(['年代', '使用数']));
  for (const row of summary.byAgeBand) {
    lines.push(csvRow([AGE_BAND_LABEL_JA[row.key], row.count]));
  }
  lines.push('');
  lines.push('性別');
  lines.push(csvRow(['性別', '使用数']));
  for (const row of summary.byGender) {
    lines.push(csvRow([GENDER_LABEL_JA[row.key], row.count]));
  }
  lines.push('');
  lines.push('日次');
  lines.push(csvRow(['日付', '使用数']));
  for (const row of summary.daily) {
    lines.push(csvRow([row.period, row.count]));
  }
  lines.push('');
  lines.push('月次');
  lines.push(csvRow(['月', '使用数']));
  for (const row of summary.monthly) {
    lines.push(csvRow([row.period, row.count]));
  }
  lines.push('');
  lines.push('■ クーポン使用履歴');
  lines.push(csvRow(['日時', 'クーポン', '店舗', '年代', '性別']));
  for (const record of summary.usage) {
    lines.push(
      csvRow([
        formatJstDateTime(record.redeemedAt).replace('T', ' ').slice(0, 16),
        record.couponTitle,
        record.exhibitorName,
        AGE_BAND_LABEL_JA[record.ageBand ?? 'unanswered'],
        GENDER_LABEL_JA[record.gender ?? 'unanswered'],
      ]),
    );
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}
