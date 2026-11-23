// app/api/events/[eventId]/social-queue-keys/[keyId]/route.ts
// 連携キーの失効（主催者）。失効したキーはその場で使えなくなる。
// キーが漏れた可能性があるときは、失効して新しいキーを発行する。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { revokeQueueKey } from '@/lib/event-social';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ eventId: string; keyId: string }> },
) {
  const { eventId, keyId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const revoked = await revokeQueueKey(db, eventId, keyId);
  if (!revoked) {
    return NextResponse.json(
      { error: 'キーが見つかりません' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
