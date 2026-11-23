// app/api/events/[eventId]/registration-status/route.ts
// 来場者本人の登録状態確認: この端末がこのプロジェクトに登録済みかを返す。
// 来場者ページが開いた直後に呼び、登録済みの端末には登録バナー
// （通知許可の段階）を出さず、そのまま利用画面へ進めるために使う。
// 認証は他の来場者 API と同じ作法: ID トークンから memberId を導き
// （lib/event-member-auth.ts）、購読者レコードの有無で判定する。
// スタンプラリーのプロジェクトは常設で、スケジューラ（event-tick）は日次
// リセットを行わないため、購読者レコードが存在することがそのまま
// 「登録済み」を意味する（リセットやラウンドでの絞り込みは無い）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { EVENT_SUBCOLLECTIONS } from '@/lib/event';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import { getEvent } from '@/lib/event-store';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const auth = await memberIdFromRequest(request, eventId);
  if ('error' in auth) return auth.error;
  const memberId = auth.memberId;

  const event = await getEvent(eventId);
  if (!event) {
    return NextResponse.json({ error: 'イベントが見つかりません' }, { status: 404 });
  }

  const subscriberSnap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_SUBCOLLECTIONS.subscribers)
    .doc(memberId)
    .get();
  return NextResponse.json({ registered: subscriberSnap.exists });
}
