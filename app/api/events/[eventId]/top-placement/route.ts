// app/api/events/[eventId]/top-placement/route.ts
// トップ掲載（特設サイトの先頭5枠）の自店向け状態取得（店舗ページ用）。
// 実行できるのは参加店セッションだけ（自店の状態のみ）。
// 購入できるかどうか（available）は、プロジェクト設定（有効＋料金）・
// 契約の店舗課金オプション・主催者の Stripe 設定がすべて揃っている
// 場合にだけ true になる。揃っていない理由は店には出さない
// （カード自体を出さない運用）。
import { NextResponse } from 'next/server';
import { requireEventExhibitor } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  getTopPlacement,
  isTopFeaturedForStatus,
  resolveTopPlacementAvailability,
} from '@/lib/event-placement';
import { getShopPlacementOptIn } from '@/lib/event-shop';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventExhibitor(request, eventId);
  if ('error' in guard) return guard.error;
  const { event, exhibitor } = guard;
  // 協賛（広告専用）アカウントはトップ掲載の対象外
  if (exhibitor.kind === 'advertiser') {
    return NextResponse.json(
      { error: '協賛アカウントはトップ掲載を利用できません' },
      { status: 403 },
    );
  }

  const placement = await getTopPlacement(db, eventId, exhibitor.id);
  const availability = await resolveTopPlacementAvailability(
    db,
    event.ownerUid,
  );
  const freeMode =
    event.topPlacementEnabled && event.topPlacementPrice === 0;
  const purchasable =
    event.topPlacementEnabled &&
    event.topPlacementPrice !== null &&
    event.topPlacementPrice > 0 &&
    availability.available;
  const optedIn = freeMode
    ? await getShopPlacementOptIn(db, eventId, exhibitor.id)
    : false;

  return NextResponse.json({
    // プロジェクトのトップ掲載設定（公開情報と同じ値）
    enabled: event.topPlacementEnabled,
    price: event.topPlacementPrice,
    // 料金 0: 課金なしで参加表明だけで掲載される
    freeMode,
    // 無料時の自店の参加表明（有料の間は常に false で、意味を持たない）
    optedIn,
    // 今この店が買える状態かどうか（設定・オプション・Stripe が全部揃っている）
    available: purchasable,
    // 自店の契約状態（未申込なら status は null）
    status: placement?.status ?? null,
    // 掲載中かどうかは料金で切り替わる（有料=契約状態／無料=参加表明）
    featured: freeMode
      ? optedIn
      : placement
        ? isTopFeaturedForStatus(placement.status)
        : false,
    monthlyAmount: placement?.monthlyAmount ?? null,
  });
}
