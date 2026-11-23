// app/api/events/[eventId]/push-requests/route.ts
// 主催者向け: 参加店からのプッシュ配信申請の一覧。
// 承認待ち（支払い済み・無料）だけが承認の対象。未払いの申請も
// 状態確認のために一覧には含める（画面側で区別して出す）。
// 文面は言語別プレビュー用に解決済みの形も付ける。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { localizedCampaignTexts } from '@/lib/event-push';
import { listPushRequestsForAdmin } from '@/lib/event-push-request';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;
  const requests = await listPushRequestsForAdmin(db, eventId);
  return NextResponse.json({
    requests: requests.map((pushRequest) => ({
      ...pushRequest,
      texts: localizedCampaignTexts(pushRequest, guard.event.defaultLocale),
    })),
  });
}
