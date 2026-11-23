// app/api/events/[eventId]/end/route.ts
// 主催者向けプロジェクト終了 API: 開催中（live）のプロジェクトを
// 終了（ended）に遷移させる。
// スタンプラリーでは終了してもデータ（スタンプ・レビュー等）は残す。
// EVENT の終了処理のようなデータ消去は一切しない
// （削除したい場合は終了後に DELETE で行う）。
import { NextResponse } from 'next/server';
import { getUidFromRequest } from '@/lib/event-auth';
import { getEvent, updateEvent } from '@/lib/event-store';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;

  const uid = await getUidFromRequest(request);
  if (!uid) {
    return NextResponse.json({ error: '認証が必要です' }, { status: 401 });
  }
  const event = await getEvent(eventId);
  if (!event) {
    return NextResponse.json(
      { error: 'プロジェクトが見つかりません' },
      { status: 404 },
    );
  }
  if (event.ownerUid !== uid) {
    return NextResponse.json({ error: '権限がありません' }, { status: 403 });
  }

  // 終了できるのは開催中だけ。下書き・終了済みは 409。
  if (event.status !== 'live') {
    return NextResponse.json(
      { error: '終了できるのは開催中のプロジェクトだけです' },
      { status: 409 },
    );
  }

  try {
    await updateEvent(eventId, { status: 'ended' });
    const updated = await getEvent(eventId);
    return NextResponse.json({ event: updated });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : '終了に失敗しました',
      },
      { status: 500 },
    );
  }
}
