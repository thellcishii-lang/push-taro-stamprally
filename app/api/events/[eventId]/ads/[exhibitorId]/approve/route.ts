// app/api/events/[eventId]/ads/[exhibitorId]/approve/route.ts
// 広告の承認（主催者だけ）。申請中（pending）の版が掲載版（live）に
// 繰り上がる。申請中が無ければ 409。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  approveShopAd,
  isAdsActionAllowed,
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

  // 広告オプション（契約）が無効な間は承認できない。
  const adsOptionEnabled = await resolveAdsOptionEnabled(guard.event.ownerUid);
  if (
    !isAdsActionAllowed('review', {
      adsOptionEnabled,
      adsEnabled: guard.event.adsEnabled,
    })
  ) {
    return NextResponse.json(
      { error: '広告オプションが有効でないため、広告を承認できません' },
      { status: 403 },
    );
  }

  const result = await approveShopAd(db, eventId, exhibitorId);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: result.status },
    );
  }
  return NextResponse.json({ ok: true, ad: result.ad });
}
