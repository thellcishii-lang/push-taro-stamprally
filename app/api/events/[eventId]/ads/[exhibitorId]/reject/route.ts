// app/api/events/[eventId]/ads/[exhibitorId]/reject/route.ts
// 広告の却下（主催者だけ）。申請中（pending）の版は破棄され、
// 掲載中（live）の版はそのまま残る。申請中が無ければ 409。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  isAdsActionAllowed,
  rejectShopAd,
  resolveAdsOptionEnabled,
} from '@/lib/event-ads';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  // 広告オプション（契約）が無効な間は却下もできない。
  const adsOptionEnabled = await resolveAdsOptionEnabled(guard.event.ownerUid);
  if (
    !isAdsActionAllowed('review', {
      adsOptionEnabled,
      adsEnabled: guard.event.adsEnabled,
    })
  ) {
    return NextResponse.json(
      { error: '広告オプションが有効でないため、広告を却下できません' },
      { status: 403 },
    );
  }

  const result = await rejectShopAd(db, eventId, exhibitorId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, ad: result.ad });
}
