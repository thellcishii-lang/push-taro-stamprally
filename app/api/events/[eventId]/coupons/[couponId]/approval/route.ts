// app/api/events/[eventId]/coupons/[couponId]/approval/route.ts
// 主催者向け: 参加店が発行したクーポンの承認・却下。
// 承認すると、支払い待ちでないクーポンは公開される（支払い待ちの場合は
// 支払いが確定した時点で公開される）。却下したクーポンは公開されない。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { setCouponApproval } from '@/lib/event-coupon';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; couponId: string }> },
) {
  const { eventId, couponId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 });
  }
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'rejected') {
    return NextResponse.json(
      { error: 'decision は approved / rejected のいずれかです' },
      { status: 400 },
    );
  }

  const coupon = await setCouponApproval(eventId, couponId, decision);
  if (!coupon) {
    return NextResponse.json({ error: 'クーポンが見つかりません' }, { status: 404 });
  }
  return NextResponse.json({ coupon });
}
