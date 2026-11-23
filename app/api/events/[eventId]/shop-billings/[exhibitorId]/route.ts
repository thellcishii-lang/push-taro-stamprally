// app/api/events/[eventId]/shop-billings/[exhibitorId]/route.ts
// 店舗課金オプション: 店の月額プランを作り、支払いページ（Stripe
// Checkout）の URL を発行する（主催者）。カード情報は Stripe の
// ホスト型ページで扱い、このアプリには一切触れない。
// 発行した URL は課金レコードに保存され、管理画面に表示される
// （主催者がコピーして店に渡す運用）。
// 既にサブスクリプションがある店には再発行しない（金額を変えたい
// 場合は解約してから作り直す）。Checkout 未完了の店は再発行できる。
// オプション OFF の契約では 404 にして機能の存在自体を隠す。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { getExhibitor } from '@/lib/event-coupon';
import {
  findEnabledBillingOrganizer,
  getShopBilling,
  parseMonthlyAmount,
  startShopBilling,
} from '@/lib/event-billing';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const organizer = await findEnabledBillingOrganizer(guard.uid);
  if (!organizer) {
    return NextResponse.json({ error: '見つかりません' }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 });
  }
  const amount = parseMonthlyAmount(body.monthlyAmount);
  if (!amount.ok) {
    return NextResponse.json({ error: amount.error }, { status: 400 });
  }

  const exhibitor = await getExhibitor(eventId, exhibitorId);
  if (!exhibitor) {
    return NextResponse.json({ error: '参加店が見つかりません' }, { status: 404 });
  }

  const existing = await getShopBilling(db, eventId, exhibitorId);
  if (
    existing?.stripeSubscriptionId &&
    existing.status !== 'canceled'
  ) {
    return NextResponse.json(
      {
        error:
          'この店には既にサブスクリプションがあります。金額を変更する場合は解約してから再度お作りください',
      },
      { status: 409 },
    );
  }

  try {
    const result = await startShopBilling(db, {
      contractId: organizer.contractId,
      eventId,
      exhibitorId,
      exhibitorName: exhibitor.name,
      monthlyAmount: amount.value,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({
      ok: true,
      billing: result.billing,
      checkoutUrl: result.checkoutUrl,
    });
  } catch {
    return NextResponse.json(
      { error: 'Stripeとの通信に失敗しました。時間をおいて再度お試しください' },
      { status: 502 },
    );
  }
}
