// app/api/events/[eventId]/site-image/route.ts
// 特設サイトの画像アップロード（主催者本人だけ）。
// フォーム項目 kind で用途を受ける: 'hero'（ヒーロー画像、既定）/
// 'icon'（ヘッダー用アイコン）。保存先・検証は共通で、どちらの URL も
// site-settings の PUT で保存する（アップロードしただけでは表示は
// 変わらない。ヒーロー画像と同じ作法）。
// 店舗写真・レビュー写真と同じ方式: Admin SDK で Storage に保存し、
// 表示用 URL を返す。
// 保存先: events/{eventId}/site-images/{uuid}.{ext}
// 検証（jpg/png/webp、1枚5MBまで）はレビュー写真と同じ純粋関数を流用する。
// 書き込みは Admin SDK 経由のみで、storage.rules 側は読み取りだけを
// 公開する（クライアントからの直接書き込みは許可しない）。
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { getStorage } from 'firebase-admin/storage';
import { requireEventOwner } from '@/lib/event-auth';
import { validateReviewPhoto } from '@/lib/event-review';
import { siteImageStoragePath } from '@/lib/event-site';

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
  // 用途（未指定はヒーロー画像）。値そのものは保存先に影響しないが、
  // 呼び出し側がどちらの画像として扱うかを明示できるように受ける。
  const kindRaw = formData.get('kind');
  const kind = kindRaw === null || kindRaw === '' ? 'hero' : kindRaw;
  if (kind !== 'hero' && kind !== 'icon') {
    return NextResponse.json(
      { error: 'kind の形式が不正です' },
      { status: 400 },
    );
  }

  const validation = validateReviewPhoto({
    contentType: file.type,
    size: file.size,
  });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  const storagePath = siteImageStoragePath(
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
    return NextResponse.json({ url, storagePath, kind });
  } catch (error) {
    console.error('[site-image] Storage 保存に失敗:', error);
    return NextResponse.json(
      { error: '画像のアップロードに失敗しました' },
      { status: 500 },
    );
  }
}
