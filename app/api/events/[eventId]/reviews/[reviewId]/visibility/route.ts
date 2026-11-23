// app/api/events/[eventId]/reviews/[reviewId]/visibility/route.ts
// レビューの表示／非表示の切り替え。プロジェクト所有者（主催者）だけ。
// 不適切なレビューを主催者が非表示にするための操作で、参加店は触れない。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { setReviewVisibility } from '@/lib/event-review';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; reviewId: string }> },
) {
  const { eventId, reviewId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  if (typeof body.visible !== 'boolean') {
    return NextResponse.json(
      { error: 'visible が必要です' },
      { status: 400 },
    );
  }

  const result = await setReviewVisibility(db, {
    eventId,
    reviewId,
    visible: body.visible,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, visible: result.visible });
}
