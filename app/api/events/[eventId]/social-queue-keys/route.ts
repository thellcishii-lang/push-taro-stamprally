// app/api/events/[eventId]/social-queue-keys/route.ts
// Instagram 投稿キューの「連携キー」発行と一覧（主催者）。
// このキーは、主催者自身の Muse がキュー確認／完了 API を叩くための
// 認証情報。平文は発行時（POST）のレスポンスで一度だけ返し、
// GET ではメタ情報（発行日時・失効状態）だけを返す（平文・ハッシュは
// 絶対に返さない）。保存はハッシュのみ（lib/event-social.ts）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { issueQueueKey, listQueueKeys } from '@/lib/event-social';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const material = await issueQueueKey(db, eventId);
  return NextResponse.json({
    ok: true,
    keyId: material.keyId,
    key: material.key,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const keys = await listQueueKeys(db, eventId);
  return NextResponse.json({ keys });
}
