// app/api/events/[eventId]/social-posts/route.ts
// Instagram 投稿キューの投稿作成と一覧（主催者）。
// POST: 投稿を作って「投稿待ち」に入れる。実際の Instagram 投稿は
// 主催者自身の Muse がキュー確認 API 経由で行う（製品は投稿しない）。
// GET: 管理画面用の一覧（投稿済みも含む）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import {
  createSocialPost,
  listSocialPosts,
  parseSocialPostInput,
} from '@/lib/event-social';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  const parsed = parseSocialPostInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const post = await createSocialPost(db, eventId, parsed.value);
  return NextResponse.json({ ok: true, post });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const posts = await listSocialPosts(db, eventId);
  return NextResponse.json({ posts });
}
