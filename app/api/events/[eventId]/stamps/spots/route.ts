// app/api/events/[eventId]/stamps/spots/route.ts
// GPS スタンプ用のスポット一覧（公開）。来場者ページが「近い順」表示と
// スポット選択に使う。返すのは参加店の名前と GPS 判定用座標だけ
// （お店の場所は公開情報）。閉店扱いの店は出さない。
import { NextResponse } from 'next/server';
import { getEvent } from '@/lib/event-store';
import { listExhibitors } from '@/lib/event-coupon';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const event = await getEvent(eventId);
  if (!event) {
    return NextResponse.json(
      { error: 'プロジェクトが見つかりません' },
      { status: 404 },
    );
  }
  const exhibitors = await listExhibitors(eventId);
  const spots = exhibitors
    .filter((e) => e.kind === 'shop' && !e.closedAt)
    .map((e) => ({
      exhibitorId: e.id,
      name: e.name,
      location: e.stampLocation,
    }));
  return NextResponse.json({ spots });
}
