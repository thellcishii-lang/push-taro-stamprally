// app/api/events/[eventId]/stamps/rotating/route.ts
// 回転QR方式のスタンプ付与。チェックポイントに固定したディスプレイの
// QR（数秒ごとに切り替わる署名つきコード）をお客さん本人が読み、
// 来場者ページが ?rstamp={code} からこの API を呼ぶ。
// コードの検証（署名・鮮度）と会員・周・重複の検証はすべてサーバー側
// （lib/event-stamp.ts / lib/stamp-rotating.ts）。
// withinRange は端末内で「50m以内」と判定した申告（座標は送らない）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import { grantStampByRotatingQr } from '@/lib/event-stamp';

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

  const result = await grantStampByRotatingQr(db, {
    eventId,
    memberId: auth.memberId,
    token: body.token,
    withinRange: body.withinRange === true,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        // 追加チェックの拒否は、画面が文言を出し分けられるようコードも返す
        ...(result.code ? { code: result.code } : {}),
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
