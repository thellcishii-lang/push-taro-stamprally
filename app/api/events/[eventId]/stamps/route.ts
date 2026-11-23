// app/api/events/[eventId]/stamps/route.ts
// スタンプの付与と、当日に自店が押したスタンプの一覧。
// 実行できるのは参加店セッション（プロジェクト専用コードのカスタム
// トークン）だけ。主催者（プロジェクト所有者）はスタンプを押せない
// （押すのは店だけ、という製品ルール。ガードは requireEventExhibitor）。
import { NextResponse } from 'next/server';
import { requireEventExhibitor } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  grantStamp,
  listTodayStampsByExhibitor,
} from '@/lib/event-stamp';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventExhibitor(request, eventId);
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
  const memberId =
    typeof body.memberId === 'string' ? body.memberId.trim() : '';
  if (!memberId) {
    return NextResponse.json({ error: 'memberId が必要です' }, { status: 400 });
  }

  const result = await grantStamp(db, {
    eventId,
    exhibitor: guard.exhibitor,
    memberId,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    stampId: result.stampId,
    round: result.round,
    countInRound: result.countInRound,
    goalCount: result.goalCount,
    completed: result.completed,
    freeCouponId: result.freeCouponId,
    // 達成時の完了メッセージの出し分け用（発行クーポンの特典スナップショット）
    rewardType: result.rewardType,
    benefitText: result.benefitText,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const scope = new URL(request.url).searchParams.get('scope');
  if (scope !== 'mine-today') {
    return NextResponse.json({ error: 'scope が不正です' }, { status: 400 });
  }
  const guard = await requireEventExhibitor(request, eventId);
  if ('error' in guard) return guard.error;

  const stamps = await listTodayStampsByExhibitor(
    db,
    eventId,
    guard.exhibitor.id,
  );
  return NextResponse.json({ stamps });
}
