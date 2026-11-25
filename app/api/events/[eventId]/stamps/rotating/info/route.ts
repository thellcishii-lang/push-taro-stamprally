// app/api/events/[eventId]/stamps/rotating/info/route.ts
// 回転QR方式の付与前の事前情報。コードを検証し、GPSエリアチェックの
// 要否と、端末内判定に使うチェックポイントの座標を返す（座標は
// チェックが必要な場合だけ）。検証は lib/event-stamp.ts。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import { getRotatingCheckpointInfo } from '@/lib/event-stamp';

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

  const result = await getRotatingCheckpointInfo(db, {
    eventId,
    token: body.token,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ info: result.info });
}
