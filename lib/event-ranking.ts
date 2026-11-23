// lib/event-ranking.ts
// Push-taro.スタンプラリー の週次ランキング基盤（events/{eventId} 配下）。
//
// - 集計期間は週次（JST の月曜〜日曜）。対象は、その週に投稿された
//   可視レビュー（visible）だけ。決め方（Ishii 決定）: 平均星で順位を
//   付け、最低レビュー件数（EventConfig.rankingMinReviews）に届いた
//   参加店だけを対象にし、件数も一緒に表示する。
// - 保存先は rankings/{weekKey}（weekKey = 期間開始日 'YYYY-MM-DD'）。
//   再計算は同じ内容で上書きするだけの冪等処理。
// - tick（15分間隔）が live プロジェクトについて「直近で完了した週」の
//   未保存分を補う（ensurePreviousWeekRanking）。週の途中で結果は
//   出さず、完了した週だけを確定させる。
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { jstDateString, type EventConfig } from './event';
import {
  EVENT_EXHIBITORS_COLLECTION,
  parseExhibitorKind,
} from './event-coupon';
import {
  filterVisibleReviews,
  listAllReviews,
  type EventReview,
} from './event-review';

// rankings はリセット・終了削除の対象外（電話番号を含まない台帳）。
// reviews と同じ扱い（プロジェクトの完全削除は listCollections で拾う）。
export const EVENT_RANKINGS_COLLECTION = 'rankings';

/** 週の期間（JST の日付）。start が月曜、end が日曜。 */
export interface WeekPeriod {
  start: string;
  end: string;
}

export interface RankingEntry {
  exhibitorId: string;
  exhibitorName: string;
  /** その週の平均星（小数1桁） */
  avgStars: number;
  /** その週のレビュー件数 */
  reviewCount: number;
}

export interface WeeklyRanking {
  /** 期間開始日（ドキュメントID） */
  weekKey: string;
  periodStart: string;
  periodEnd: string;
  entries: RankingEntry[];
  computedAt: string | null;
}

// ─── 純粋関数: 週の期間 ───

function addDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** 'YYYY-MM-DD' の曜日（0=日曜〜6=土曜）。日付部分だけを UTC で読む。 */
function weekdayOfDateStr(dateStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/**
 * その日を含む週（JST の月曜〜日曜）。
 * まず JST の日付に直してから日付演算するので、UTC と JST で
 * 日付がずれる時刻でも JST の週で判定できる。
 */
export function weekPeriodJst(date: Date): WeekPeriod {
  const today = jstDateString(date);
  const daysSinceMonday = (weekdayOfDateStr(today) + 6) % 7;
  const start = addDays(today, -daysSinceMonday);
  return { start, end: addDays(start, 6) };
}

/** 直近で完了した週（先週）の期間。 */
export function previousWeekPeriodJst(date: Date): WeekPeriod {
  const current = weekPeriodJst(date);
  return { start: addDays(current.start, -7), end: addDays(current.start, -1) };
}

/** ランキングのドキュメントID（期間開始日）。 */
export function weekKeyOf(period: WeekPeriod): string {
  return period.start;
}

// ─── 純粋関数: 期間フィルタと集計 ───

/**
 * 期間内（JST の start 00:00 〜 end 24:00）に投稿されたレビューだけを残す。
 * createdAt は ISO 文字列（UTC）なので、期間の境界を UTC に直して比較する。
 */
export function filterReviewsInPeriod<T extends { createdAt: string | null }>(
  reviews: T[],
  period: WeekPeriod,
): T[] {
  const fromIso = new Date(`${period.start}T00:00:00+09:00`).toISOString();
  const toIso = new Date(
    `${addDays(period.end, 1)}T00:00:00+09:00`,
  ).toISOString();
  return reviews.filter(
    (review) =>
      review.createdAt !== null &&
      review.createdAt >= fromIso &&
      review.createdAt < toIso,
  );
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * ランキングを組み立てる（純粋関数）。
 * - 対象は visible なレビューだけ（期間の絞り込みは呼び出し側）。
 * - 店名は参加店台帳（exhibitors）の登録名を正とし、台帳に無い店の
 *   レビューは対象外（削除済みの店を出さない）。
 * - 平均星（小数1桁）が高い順、同点は件数が多い順、さらに店名順で
 *   決定的に並べる。minCount 未満の店は含めない。
 */
export function buildRanking(
  reviews: Array<
    Pick<EventReview, 'exhibitorId' | 'exhibitorName' | 'stars' | 'visible'>
  >,
  exhibitors: Array<{ id: string; name: string }>,
  minCount: number,
): RankingEntry[] {
  const nameById = new Map(exhibitors.map((e) => [e.id, e.name]));
  const tally = new Map<string, { sum: number; count: number }>();
  for (const review of filterVisibleReviews(reviews)) {
    if (!nameById.has(review.exhibitorId)) continue;
    const current = tally.get(review.exhibitorId) ?? { sum: 0, count: 0 };
    current.sum += review.stars;
    current.count += 1;
    tally.set(review.exhibitorId, current);
  }
  return [...tally.entries()]
    .filter(([, t]) => t.count >= minCount)
    .map(([exhibitorId, t]) => ({
      exhibitorId,
      exhibitorName: nameById.get(exhibitorId) ?? '',
      avgStars: roundToTenth(t.sum / t.count),
      reviewCount: t.count,
    }))
    .sort(
      (a, b) =>
        b.avgStars - a.avgStars ||
        b.reviewCount - a.reviewCount ||
        a.exhibitorName.localeCompare(b.exhibitorName, 'ja'),
    );
}

// ─── Firestore 読み書き ───

function rankingsRef(db: Firestore, eventId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_RANKINGS_COLLECTION);
}

function toIsoString(value: unknown): string | null {
  const timestamp = value as { toDate?: () => Date } | undefined;
  return timestamp?.toDate?.().toISOString() ?? null;
}

function mapRanking(
  id: string,
  data: FirebaseFirestore.DocumentData,
): WeeklyRanking {
  const rawEntries = Array.isArray(data.entries) ? data.entries : [];
  const entries: RankingEntry[] = rawEntries
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      exhibitorId: String(entry.exhibitorId ?? ''),
      exhibitorName: String(entry.exhibitorName ?? ''),
      avgStars: typeof entry.avgStars === 'number' ? entry.avgStars : 0,
      reviewCount: typeof entry.reviewCount === 'number' ? entry.reviewCount : 0,
    }));
  return {
    weekKey: id,
    periodStart: String(data.periodStart ?? id),
    periodEnd: String(data.periodEnd ?? ''),
    entries,
    computedAt: toIsoString(data.computedAt),
  };
}

/**
 * 週次ランキングを計算して保存する（冪等: 同じ週は同じ内容で上書き）。
 * 対象レビューが無ければ entries は空で保存する（「計算済み」を残し、
 * tick が毎回再計算しないようにする）。
 */
export async function computeWeeklyRanking(
  db: Firestore,
  eventId: string,
  period: WeekPeriod,
  minCount: number,
): Promise<WeeklyRanking> {
  const [reviews, exhibitorsSnap] = await Promise.all([
    listAllReviews(db, eventId),
    db
      .collection('events')
      .doc(eventId)
      .collection(EVENT_EXHIBITORS_COLLECTION)
      .get(),
  ]);
  const exhibitors = exhibitorsSnap.docs
    // 協賛（広告専用）アカウントはランキングの対象にしない
    .filter((doc) => parseExhibitorKind(doc.data().kind) === 'shop')
    .map((doc) => ({
      id: doc.id,
      name: String(doc.data().name ?? ''),
    }));
  const entries = buildRanking(
    filterReviewsInPeriod(reviews, period),
    exhibitors,
    minCount,
  );
  const computedAt = new Date();
  await rankingsRef(db, eventId)
    .doc(weekKeyOf(period))
    .set({
      periodStart: period.start,
      periodEnd: period.end,
      entries,
      computedAt: FieldValue.serverTimestamp(),
    });
  return {
    weekKey: weekKeyOf(period),
    periodStart: period.start,
    periodEnd: period.end,
    entries,
    computedAt: computedAt.toISOString(),
  };
}

/** 保存済みランキングを1週分読む。無ければ null。 */
export async function getStoredRanking(
  db: Firestore,
  eventId: string,
  weekKey: string,
): Promise<WeeklyRanking | null> {
  const snap = await rankingsRef(db, eventId).doc(weekKey).get();
  if (!snap.exists) return null;
  return mapRanking(snap.id, snap.data()!);
}

/** 最新（期間開始日が一番新しい）の保存済みランキング。無ければ null。 */
export async function getLatestRanking(
  db: Firestore,
  eventId: string,
): Promise<WeeklyRanking | null> {
  const snap = await rankingsRef(db, eventId)
    .orderBy('periodStart', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return mapRanking(doc.id, doc.data());
}

/**
 * 「直近で完了した週」のランキングが未保存なら計算して保存する（tick 用）。
 * 既に保存済みなら何もしない。計算したら true、済みなら false を返す。
 * 冪等なので、失敗しても次の tick で再試行できる（catch-up）。
 */
export async function ensurePreviousWeekRanking(
  db: Firestore,
  event: Pick<EventConfig, 'id' | 'rankingMinReviews'>,
  now: Date,
): Promise<boolean> {
  const period = previousWeekPeriodJst(now);
  const existing = await getStoredRanking(db, event.id, weekKeyOf(period));
  if (existing) return false;
  await computeWeeklyRanking(db, event.id, period, event.rankingMinReviews);
  return true;
}
