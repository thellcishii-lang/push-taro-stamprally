// app/api/events/[eventId]/exhibitors/[exhibitorId]/stamp-code/route.ts
// 主催者向け: 場所QR用スタンプコードの再発行。保存値を差し替えるだけ
// なので、旧コードの QR はその時点で無効になる。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { regenerateExhibitorStampCode } from '@/lib/event-coupon';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const stampCode = await regenerateExhibitorStampCode(eventId, exhibitorId);
  if (!stampCode) {
    return NextResponse.json(
      { error: '参加店が見つかりません' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, stampCode });
}
