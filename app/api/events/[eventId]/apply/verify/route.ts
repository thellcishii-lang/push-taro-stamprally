// app/api/events/[eventId]/apply/verify/route.ts
// 自己申込の Checkout からの戻りの検証（公開・認証なし）。
// セッション ID は申込者だけに渡る控えであり、サーバーが主催者の
// Stripe で照会して支払い済みを確認してから実体化する
// （Webhook でも同じ実体化が冪等に行われる）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { verifyAndApplyApplication } from '@/lib/event-apply';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
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
      { error: '支払い情報が不正です' },
      { status: 400 },
    );
  }
  try {
    const result = await verifyAndApplyApplication(db, { eventId, sessionId });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({
      ok: true,
      type: result.type,
      alreadyCompleted: result.alreadyCompleted,
    });
  } catch (error) {
    console.error('[apply/verify] 検証に失敗:', error);
    return NextResponse.json(
      { error: '支払いの確認に失敗しました。時間をおいて再度お試しください' },
      { status: 502 },
    );
  }
}
