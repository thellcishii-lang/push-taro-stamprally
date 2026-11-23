// app/api/events/[eventId]/shop-billings/export/route.ts
// 店舗課金オプション: 入金一覧の CSV ダウンロード（主催者）。
// 画面の直近50件ではなく、支払い記録の全件を店名・登録住所・種別つきで
// 返す（経理・収支への取り込み用）。並びと整形は
// lib/event-billing.ts の buildBillingPaymentsCsv が担う。
// オプション OFF の契約では 404 にして機能の存在自体を隠す（一覧 API と同じ）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { listExhibitors } from '@/lib/event-coupon';
import {
  buildBillingPaymentsCsv,
  findEnabledBillingOrganizer,
  listBillingPayments,
  listShopBillings,
} from '@/lib/event-billing';

export const dynamic = 'force-dynamic';

/** CSV は全件対象。実質上限としての十分大きな件数。 */
const EXPORT_LIMIT = 100000;

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

  const [exhibitors, billings, payments] = await Promise.all([
    listExhibitors(eventId),
    listShopBillings(db, eventId),
    listBillingPayments(db, eventId, EXPORT_LIMIT),
  ]);
  const csv = buildBillingPaymentsCsv(payments, exhibitors, billings);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="billing-payments-${eventId}.csv"`,
    },
  });
}
