// app/api/events/[eventId]/shop-billings/route.ts
// 店舗課金オプション: 店ごとの課金状態一覧と収支サマリ（主催者）。
// 状態・合計はすべてローカル記録（Webhook で蓄積した Firestore）が正で、
// Stripe API へは問い合わせない。
// オプション OFF の契約では 404 にして機能の存在自体を隠す。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { listCoupons, listExhibitors } from '@/lib/event-coupon';
import { listPushRequestsForAdmin } from '@/lib/event-push-request';
import {
  findEnabledBillingOrganizer,
  listBillingPayments,
  listShopBillings,
  summarizePaymentsByMonth,
} from '@/lib/event-billing';

export const dynamic = 'force-dynamic';

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

  const [exhibitors, billings, recentPayments, allPayments, coupons, pushRequests] =
    await Promise.all([
      listExhibitors(eventId),
      listShopBillings(db, eventId),
      listBillingPayments(db, eventId, 50),
      listBillingPayments(db, eventId, 1000),
      listCoupons(eventId),
      listPushRequestsForAdmin(db, eventId),
    ]);
  const summary = summarizePaymentsByMonth(allPayments, new Date());

  // 手動入金の対象候補: 支払い待ちのクーポンとプッシュ申請を店ごとに引く
  const pendingTargets: Record<
    string,
    {
      coupons: Array<{ id: string; title: string; feeAmount: number | null }>;
      pushRequests: Array<{ id: string; title: string; feeAmount: number }>;
    }
  > = {};
  for (const coupon of coupons) {
    if (!coupon.paymentPending) continue;
    (pendingTargets[coupon.exhibitorId] ??= { coupons: [], pushRequests: [] }).coupons.push({
      id: coupon.id,
      title: coupon.title,
      feeAmount: coupon.feeAmount,
    });
  }
  for (const pushRequest of pushRequests) {
    if (pushRequest.status !== 'unpaid') continue;
    (pendingTargets[pushRequest.exhibitorId] ??= { coupons: [], pushRequests: [] }).pushRequests.push({
      id: pushRequest.id,
      title: pushRequest.title,
      feeAmount: pushRequest.feeAmount,
    });
  }

  return NextResponse.json({
    // 店舗課金は参加店だけが対象（協賛は広告専用、スポットはチェック
    // ポイント専用で、どちらもここには出さない）
    exhibitors: exhibitors
      .filter((exhibitor) => exhibitor.kind === 'shop')
      .map((exhibitor) => ({
        id: exhibitor.id,
        name: exhibitor.name,
        // 登録住所（管理用）。課金画面の店舗カードにだけ出す。
        address: exhibitor.address ?? null,
        // 未払い確定で掲載停止になった日時（停止中でなければ null）。
        // 停止から3ヶ月を過ぎると閉店扱いになり新規登録が通る。
        delistedAt: exhibitor.delistedAt,
        closedAt: exhibitor.closedAt,
        // 登録の入口（主催者発行 'admin' / 自己申込 'self'）
        source: exhibitor.source,
      })),
    billings,
    payments: recentPayments,
    pendingTargets,
    summary: {
      currentMonthKey: summary.currentMonthKey,
      currentMonthTotal: summary.currentMonthTotal,
      previousMonthKey: summary.previousMonthKey,
      previousMonthTotal: summary.previousMonthTotal,
    },
  });
}
