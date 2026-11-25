// app/api/events/[eventId]/stamps/placed-qr/route.ts
// 場所QR方式のスタンプ付与。チェックポイントに貼った QR をお客さん本人が
// 読み、来場者ページが ?stamp={stampCode} からこの API を呼ぶ。
// 本人特定は来場者トークン（lib/event-member-auth.ts）、スポットの特定と
// 会員・周・重複の検証はすべてサーバー側（lib/event-stamp.ts）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import { grantStampByPlacedQr } from '@/lib/event-stamp';

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

  const result = await grantStampByPlacedQr(db, {
    eventId,
    memberId: auth.memberId,
    stampCode: body.stampCode,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        // 順番モードの順番違いでは、次の番号を画面の案内に使えるよう返す
        ...(result.nextCheckpointNumber !== undefined
          ? { nextCheckpointNumber: result.nextCheckpointNumber }
          : {}),
      },
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
