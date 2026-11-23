// app/api/events/[eventId]/shop-charges/verify/route.ts
// 参加店向け: 単発課金（クーポン発行・プッシュ配信申請）の支払い照会。
// 店が Stripe Checkout から店舗ページに戻ったときに叩く。サーバーが
// 主催者の Stripe でセッションを照会し、支払い済みで所属（プロジェ
// クト・参加店）が自分と一致することを確認してから反映する。
// Webhook でも同じ反映が走るため、ここが失敗しても支払いは失われない。
import { NextResponse } from 'next/server';
import { requireEventExhibitor } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { resolveAdAvailability } from '@/lib/event-ads';
import { verifyAndApplyCharge } from '@/lib/event-charges';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventExhibitor(request, eventId);
  if ('error' in guard) return guard.error;
  const { event, exhibitor } = guard;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    return NextResponse.json(
      { error: 'sessionId が必要です' },
      { status: 400 },
    );
  }

  const availability = await resolveAdAvailability(db, event.ownerUid);
  if (!availability.available || !availability.organizer) {
    return NextResponse.json(
      { error: 'Stripe設定が未完了です' },
      { status: 404 },
    );
  }

  const result = await verifyAndApplyCharge(db, {
    contractId: availability.organizer.contractId,
    sessionId,
    eventId,
    exhibitorId: exhibitor.id,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    applied: result.applied,
    duplicate: result.duplicate,
    kind: result.kind,
    targetId: result.targetId,
  });
}
