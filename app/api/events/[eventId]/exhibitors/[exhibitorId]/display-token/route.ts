// app/api/events/[eventId]/exhibitors/[exhibitorId]/display-token/route.ts
// 主催者向け: 回転QRの表示リンク（表示用トークン）の状態確認と発行。
// 発行した平文トークンはこの応答でしか見られない（保存はハッシュだけ）。
// 再発行すると以前のリンクは使えなくなる。対象は参加店とスポット。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { checkpointDisplayUrl } from '@/lib/app-origin';
import {
  EVENT_EXHIBITORS_COLLECTION,
  mapExhibitor,
} from '@/lib/event-coupon';
import {
  hasExhibitorDisplayToken,
  issueExhibitorDisplayToken,
} from '@/lib/stamp-rotating';

export const dynamic = 'force-dynamic';

async function loadCheckpoint(eventId: string, exhibitorId: string) {
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId)
    .get();
  if (!snap.exists) return null;
  return mapExhibitor(snap.id, snap.data()!);
}

export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const exhibitor = await loadCheckpoint(eventId, exhibitorId);
  if (!exhibitor) {
    return NextResponse.json(
      { error: 'チェックポイントが見つかりません' },
      { status: 404 },
    );
  }
  const hasLink = await hasExhibitorDisplayToken(db, eventId, exhibitorId);
  return NextResponse.json({ hasLink });
}

export async function POST(
  request: Request,
  {
    params,
  }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const exhibitor = await loadCheckpoint(eventId, exhibitorId);
  if (!exhibitor) {
    return NextResponse.json(
      { error: 'チェックポイントが見つかりません' },
      { status: 404 },
    );
  }
  if (exhibitor.kind === 'advertiser') {
    return NextResponse.json(
      { error: '協賛アカウントには表示リンクは発行できません' },
      { status: 403 },
    );
  }
  const token = await issueExhibitorDisplayToken(db, eventId, exhibitorId);
  if (!token) {
    return NextResponse.json(
      { error: 'チェックポイントが見つかりません' },
      { status: 404 },
    );
  }
  return NextResponse.json({
    url: checkpointDisplayUrl(eventId, exhibitorId, token),
  });
}
