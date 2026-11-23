// app/api/events/[eventId]/social-queue/route.ts
// Muse 用のキュー確認 API。主催者自身の Muse が朝・昼・夜に叩き、
// 投稿待ち（queued）の投稿を古い順に受け取る。
// 認証は連携キー（ヘッダ X-Queue-Key）。キーが無い・失効・不一致は 401。
// レスポンスの各要素が、そのまま Instagram 投稿に使える形
// （id / text / photoUrls / createdAt）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { listQueuedPosts, verifyQueueKey } from '@/lib/event-social';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const presented = request.headers.get('X-Queue-Key');
  const verified = await verifyQueueKey(db, eventId, presented);
  if (!verified) {
    return NextResponse.json(
      { error: '連携キーが無効です' },
      { status: 401 },
    );
  }

  const posts = await listQueuedPosts(db, eventId);
  return NextResponse.json({
    posts: posts.map((post) => ({
      id: post.id,
      text: post.text,
      photoUrls: post.photoUrls,
      createdAt: post.createdAt,
    })),
  });
}
