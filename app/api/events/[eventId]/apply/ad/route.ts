// app/api/events/[eventId]/apply/ad/route.ts
// 広告の自己申込の開始（公開・認証なし）。
// 事業者名＋メールを受け取り、料金が有料なら主催者自身の Stripe の
// Checkout URL を返し、無料ならその場で申込を完了する。
// 支払いの確認と協賛レコードの作成は lib/event-apply.ts が担う
// （Webhook と戻り照会の両経路で実体化される）。広告の掲載自体は
// 申込後に広告編集画面で内容を申請し、主催者の承認を経る（既存の仕組み）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { startAdApplication } from '@/lib/event-apply';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  try {
    const result = await startAdApplication(db, eventId, body);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }
    return NextResponse.json({
      status: result.status,
      checkoutUrl: result.checkoutUrl,
    });
  } catch (error) {
    console.error('[apply/ad] 申込の開始に失敗:', error);
    return NextResponse.json(
      { error: '申込の受付に失敗しました。時間をおいて再度お試しください' },
      { status: 502 },
    );
  }
}
