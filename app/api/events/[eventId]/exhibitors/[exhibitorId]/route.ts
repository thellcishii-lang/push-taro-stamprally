// app/api/events/[eventId]/exhibitors/[exhibitorId]/route.ts
// 主催者向け: チェックポイント設定（番号・スタンプ認証方法・追加
// チェック）の更新。対象は参加店とスポット（協賛には設定が無い）。
// 検証と保存は lib/event-coupon.ts の updateExhibitorCheckpointSettings。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { updateExhibitorCheckpointSettings } from '@/lib/event-coupon';

export const dynamic = 'force-dynamic';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
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

  const result = await updateExhibitorCheckpointSettings(eventId, exhibitorId, {
    checkpointNumber:
      body.checkpointNumber === undefined
        ? undefined
        : (body.checkpointNumber as number | null),
    stampMethods: body.stampMethods,
    gpsCheck: body.gpsCheck,
    velocityCheck: body.velocityCheck,
  });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ exhibitor: result.exhibitor });
}
