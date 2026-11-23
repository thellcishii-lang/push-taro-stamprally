// app/api/events/[eventId]/push-requests/[requestId]/approve/route.ts
// 主催者向け: プッシュ配信申請の承認。承認した申請はその場で通常の
// 配信（campaigns）として実行される。配信に失敗した場合は申請が
// 'failed' になり、理由が店側にも表示される。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { approveAndSendPushRequest } from '@/lib/event-push-request';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; requestId: string }> },
) {
  const { eventId, requestId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;
  const result = await approveAndSendPushRequest(db, eventId, requestId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, request: result.request });
}
