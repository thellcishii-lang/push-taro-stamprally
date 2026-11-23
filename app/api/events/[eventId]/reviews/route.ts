// app/api/events/[eventId]/reviews/route.ts
// レビューの投稿（来場者）と、全件一覧（主催者）。
// POST: 認証方式に応じたトークンから本人を特定し（lib/event-member-auth.ts）、
// その店のスタンプをもらった客だけが書ける（資格判定は
// lib/event-review.ts の upsertReview）。
// 1人1店1件で、再投稿は同じレビューの更新になる。
// GET: 管理画面用の一覧（非表示も含む）。プロジェクト所有者だけ。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { memberIdFromRequest } from '@/lib/event-member-auth';
import { requireEventOwner } from '@/lib/event-auth';
import {
  listReviewsForAdmin,
  parseReviewInput,
  upsertReview,
} from '@/lib/event-review';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const auth = await memberIdFromRequest(request, eventId);
  if ('error' in auth) return auth.error;
  const memberId = auth.memberId;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  const parsed = parseReviewInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const result = await upsertReview(db, {
    eventId,
    memberId,
    value: parsed.value,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    reviewId: result.reviewId,
    created: result.created,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const reviews = await listReviewsForAdmin(db, eventId);
  return NextResponse.json({ reviews });
}
