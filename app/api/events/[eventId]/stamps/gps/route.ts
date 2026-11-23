// app/api/events/[eventId]/stamps/gps/route.ts
// GPS方式のスタンプ付与。お客さん本人が来場者ページでスポットを選び、
// 端末の現在地（lat/lng）と exhibitorId を送る。距離判定はサーバー側
// （lib/event-stamp.ts）で行い、お客さんの座標は保存しない。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import { grantStampByGps } from '@/lib/event-stamp';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const auth = await memberIdFromRequest(request, eventId);
  if ('error' in auth) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  const exhibitorId =
    typeof body.exhibitorId === 'string' ? body.exhibitorId.trim() : '';
  if (!exhibitorId) {
    return NextResponse.json(
      { error: 'exhibitorId が必要です' },
      { status: 400 },
    );
  }

  const result = await grantStampByGps(db, {
    eventId,
    memberId: auth.memberId,
    exhibitorId,
    point: { lat: body.lat, lng: body.lng },
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    stampId: result.stampId,
    exhibitorId: result.exhibitorId,
    exhibitorName: result.exhibitorName,
    round: result.round,
    countInRound: result.countInRound,
    goalCount: result.goalCount,
    completed: result.completed,
    freeCouponId: result.freeCouponId,
    rewardType: result.rewardType,
    benefitText: result.benefitText,
  });
}
