// app/api/events/[eventId]/shop-billings/summary/export/route.ts
// 店舗課金オプション: 集計CSVのダウンロード（主催者）。
// 日次・月次・年次・店舗別月次の集計を、セクション見出しつきの
// 1ファイルで返す（集計ソフトへの取り込み・月次締め用）。
// 整形は lib/event-billing.ts の buildBillingSummaryCsv が担う。
// オプション OFF の契約では 404（明細CSVと同じ）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { listExhibitors } from '@/lib/event-coupon';
import {
  buildBillingSummaryCsv,
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
  const csv = buildBillingSummaryCsv(
    summarizeBillingPayments(payments, exhibitors),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="billing-summary-${eventId}.csv"`,
    },
  });
}
