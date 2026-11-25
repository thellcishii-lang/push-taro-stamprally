// app/api/events/[eventId]/stamps/placed-qr/route.ts
// 場所QR方式のスタンプ付与。チェックポイントに貼った QR をお客さん本人が
// 読み、来場者ページが ?stamp={stampCode} からこの API を呼ぶ。
// 本人特定は来場者トークン（lib/event-member-auth.ts）、スポットの特定と
// 会員・周・重複の検証はすべてサーバー側（lib/event-stamp.ts）。
// GET は付与前の事前情報（GPSエリアチェックの要否と判定用座標）。
// POST の withinRange は端末内で「50m以内」と判定した申告で、
// 座標そのものは送られてこない。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import {
  getPlacedQrCheckpointInfo,
  grantStampByPlacedQr,
} from '@/lib/event-stamp';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const auth = await memberIdFromRequest(request, eventId);
  if ('error' in auth) return auth.error;

  const code = new URL(request.url).searchParams.get('code') ?? '';
  const result = await getPlacedQrCheckpointInfo(db, {
    eventId,
    stampCode: code,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ info: result.info });
}

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
