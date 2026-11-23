// app/api/events/[eventId]/social-posts/[postId]/route.ts
// 投稿キューの投稿削除（主催者）。投稿待ちのものだけ削除できる。
// 投稿済みのものは Instagram 側に実物があるため履歴として残す。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { deleteQueuedPost } from '@/lib/event-social';

export const dynamic = 'force-dynamic';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ eventId: string; postId: string }> },
) {
  const { eventId, postId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const result = await deleteQueuedPost(db, eventId, postId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true });
}
