// app/api/events/[eventId]/exhibitors/[exhibitorId]/stamp-location/route.ts
// 主催者向け: GPS スタンプ用のスポット座標の設定。
// - { lat, lng }: 数値の手入力（検証を通ったものだけ保存）
// - { address }: 住所をジオコーディングして設定（lib/geocode.ts）
// - { location: null }: 座標の解除（そのスポットは GPS で押せなくなる）
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { updateExhibitorStampLocation } from '@/lib/event-coupon';
import { geocodeAddress, parseGeoPoint } from '@/lib/geocode';

export const dynamic = 'force-dynamic';

export async function PUT(
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

  // 解除
  if (body.location === null) {
    const saved = await updateExhibitorStampLocation(
      eventId,
      exhibitorId,
      null,
    );
    if (!saved) {
      return NextResponse.json(
        { error: '参加店が見つかりません' },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true, stampLocation: null });
  }

  // 数値の手入力
  let point = parseGeoPoint({ lat: body.lat, lng: body.lng });
  // 住所からのジオコーディング
  if (!point && typeof body.address === 'string' && body.address.trim()) {
    point = await geocodeAddress(body.address.trim());
    if (!point) {
      return NextResponse.json(
        { error: '住所から座標が取得できませんでした' },
        { status: 422 },
      );
    }
  }
  if (!point) {
    return NextResponse.json(
      { error: '緯度・経度が正しくありません' },
      { status: 400 },
    );
  }

  const saved = await updateExhibitorStampLocation(eventId, exhibitorId, point);
  if (!saved) {
    return NextResponse.json(
      { error: '参加店が見つかりません' },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true, stampLocation: point });
}
