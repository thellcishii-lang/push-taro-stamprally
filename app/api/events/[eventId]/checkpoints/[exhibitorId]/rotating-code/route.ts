// app/api/events/[eventId]/checkpoints/[exhibitorId]/rotating-code/route.ts
// 回転QRの表示ページ専用: 現在のコードだけを返す。
// 認証は表示用トークン（表示リンク）だけ。トークンはそのチェック
// ポイントのコード取得以外には使えない。次のコードは返さない
// （表示ページがウィンドウごとに取り直す）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { eventRotatingStampUrl } from '@/lib/app-origin';
import {
  EVENT_EXHIBITORS_COLLECTION,
  mapExhibitor,
} from '@/lib/event-coupon';
import {
  ROTATING_WINDOW_SECONDS,
  buildRotatingCode,
  ensureExhibitorRotatingSecret,
  rotatingWindowIndex,
  rotatingWindowRemainingSeconds,
  verifyExhibitorDisplayToken,
} from '@/lib/stamp-rotating';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  {
    params,
  }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const url = new URL(request.url);
  const bearer = request.headers
    .get('authorization')
    ?.replace(/^Bearer\s+/i, '');
  const displayToken = url.searchParams.get('dt') ?? bearer ?? '';

  const allowed = await verifyExhibitorDisplayToken(
    db,
    eventId,
    exhibitorId,
    displayToken,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: '表示リンクが無効です' },
      { status: 403 },
    );
  }

  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId)
    .get();
  if (!snap.exists) {
    return NextResponse.json(
      { error: 'チェックポイントが見つかりません' },
      { status: 404 },
    );
  }
  const exhibitor = mapExhibitor(snap.id, snap.data()!);
  if (exhibitor.kind === 'advertiser') {
    return NextResponse.json(
      { error: 'このチェックポイントでは回転QRは使えません' },
      { status: 403 },
    );
  }

  const secret = await ensureExhibitorRotatingSecret(db, eventId, exhibitorId);
  if (!secret) {
    return NextResponse.json(
      { error: 'チェックポイントが見つかりません' },
      { status: 404 },
    );
  }
  const nowMs = Date.now();
  const code = buildRotatingCode(
    secret,
    eventId,
    exhibitorId,
    rotatingWindowIndex(nowMs),
  );
  return NextResponse.json({
    code,
    url: eventRotatingStampUrl(eventId, code),
    exhibitorName: exhibitor.name,
    windowSeconds: ROTATING_WINDOW_SECONDS,
    // 表示ページが次のコードを取り直すタイミング（秒）
    refreshInSeconds: rotatingWindowRemainingSeconds(nowMs),
  });
}
