// app/api/events/[eventId]/social-posts/photo/route.ts
// 投稿写真のアップロード（主催者）。プロジェクト所有者を確認のうえ、
// Admin SDK で Storage に保存し、表示用 URL を返す。
// 保存先: events/{eventId}/social-photos/{uuid}.{ext}
// 検証（jpg/png/webp、1枚5MBまで）はレビュー写真と同じ純粋関数。
// 書き込みは Admin SDK 経由のみで、storage.rules 側は読み取りだけを
// 公開する（クライアントからの直接書き込みは許可しない）。
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStorage } from 'firebase-admin/storage';
import { requireEventOwner } from '@/lib/event-auth';
import { validateReviewPhoto } from '@/lib/event-review';
import { socialPhotoStoragePath } from '@/lib/event-social';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file が必要です' }, { status: 400 });
  }

  const validation = validateReviewPhoto({
    contentType: file.type,
    size: file.size,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const storagePath = socialPhotoStoragePath(
    eventId,
    `${randomUUID()}.${validation.extension}`,
  );
  try {
    const bucket = getStorage().bucket();
    const storedFile = bucket.file(storagePath);
    const buffer = Buffer.from(await file.arrayBuffer());
    await storedFile.save(buffer, {
      metadata: { contentType: file.type },
    });
    await storedFile.makePublic();
    const url = `https://storage.googleapis.com/${bucket.name}/${storagePath}`;
    return NextResponse.json({ url, storagePath });
  } catch (error) {
    console.error('[social-posts/photo] Storage 保存に失敗:', error);
    return NextResponse.json(
      { error: '写真のアップロードに失敗しました' },
      { status: 500 },
    );
  }
}
