// app/api/events/[eventId]/push-requests/[requestId]/reject/route.ts
// 主催者向け: プッシュ配信申請の却下。承認待ちの申請だけを却下でき、
// 申請は破棄される（状態と却下日時だけが店への表示用に残る）。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { rejectPushRequest } from '@/lib/event-push-request';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; requestId: string }> },
) {
  const { eventId, requestId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;
  const result = await rejectPushRequest(db, eventId, requestId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, request: result.request });
}
