// app/api/events/[eventId]/shop-billings/summary/route.ts
// 店舗課金オプション: 入金の集計（主催者）。集計レポート画面が使う。
// 明細CSV（生データ）とは別に、日次・月次・年次・店舗別月次へ畳んだ
// 集計を返す。集計は lib/event-billing.ts の summarizeBillingPayments。
// オプション OFF の契約では 404（明細 API と同じ）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { listExhibitors } from '@/lib/event-coupon';
import {
  findEnabledBillingOrganizer,
  listBillingPayments,
  summarizeBillingPayments,
} from '@/lib/event-billing';

export const dynamic = 'force-dynamic';

/** 集計は全件対象。実質上限としての十分大きな件数。 */
const SUMMARY_LIMIT = 100000;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const organizer = await findEnabledBillingOrganizer(guard.uid);
  if (!organizer) {
    return NextResponse.json({ error: '見つかりません' }, { status: 404 });
  }

  const [exhibitors, payments] = await Promise.all([
    listExhibitors(eventId),
    listBillingPayments(db, eventId, SUMMARY_LIMIT),
  ]);
  const summary = summarizeBillingPayments(payments, exhibitors);

  return NextResponse.json({
    summary,
    generatedAt: new Date().toISOString(),
  });
}
