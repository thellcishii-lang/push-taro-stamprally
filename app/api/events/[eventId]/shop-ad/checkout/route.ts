// app/api/events/[eventId]/shop-ad/checkout/route.ts
// 広告の申込: 自店分の Stripe Checkout セッションを発行し、支払い
// ページの URL を返す（参加店セッションだけ）。トップ掲載の申込と
// 同じ作法。料金 0（無料）のプロジェクトでは課金自体が無いため 404。
// 実際の掲載可否は Webhook（invoice.paid）で確定する。
// 既に有効な契約（active / past_due）がある店は再申込できない。
import { NextResponse } from 'next/server';
import { requireEventExhibitor } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  getAdPlacement,
  isAdsActionAllowed,
  resolveAdAvailability,
  resolveAdsOptionEnabled,
  startAdPlacement,
} from '@/lib/event-ads';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventExhibitor(request, eventId);
  if ('error' in guard) return guard.error;
  const { event, exhibitor } = guard;

  if (!event.adsEnabled || event.adsPrice === null || event.adsPrice <= 0) {
    return NextResponse.json(
      { error: '現在広告のお申し込みは受け付けていません' },
      { status: 404 },
    );
  }

  // 広告オプション（主催者の契約）が無効な間は新規の申込はできない
  // （既存の契約の解約は shop-ad/cancel 側で引き続き可能）。
  const adsOptionEnabled = await resolveAdsOptionEnabled(event.ownerUid);
  if (
    !isAdsActionAllowed('checkout', {
      adsOptionEnabled,
      adsEnabled: event.adsEnabled,
    })
  ) {
    return NextResponse.json(
      { error: '広告オプションが有効でないため、現在広告のお申し込みは受け付けていません' },
      { status: 403 },
    );
  }

  const availability = await resolveAdAvailability(db, event.ownerUid);
  if (!availability.available || !availability.organizer) {
    return NextResponse.json(
      { error: '現在広告のお申し込みは受け付けていません' },
      { status: 404 },
    );
  }

  const existing = await getAdPlacement(db, eventId, exhibitor.id);
  if (
    existing?.stripeSubscriptionId &&
    (existing.status === 'active' || existing.status === 'past_due')
  ) {
    return NextResponse.json(
      { error: '既に広告の契約があります' },
      { status: 409 },
    );
  }

  try {
    const result = await startAdPlacement(db, {
      contractId: availability.organizer.contractId,
      eventId,
      exhibitorId: exhibitor.id,
      exhibitorName: exhibitor.name,
      monthlyAmount: event.adsPrice,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({
      ok: true,
      checkoutUrl: result.checkoutUrl,
      placement: result.placement,
    });
  } catch {
    return NextResponse.json(
      { error: 'Stripeとの通信に失敗しました。時間をおいて再度お試しください' },
      { status: 502 },
    );
  }
}
