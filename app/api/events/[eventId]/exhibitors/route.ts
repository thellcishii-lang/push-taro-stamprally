// app/api/events/[eventId]/exhibitors/route.ts
// 主催者向け: 出店者（会社）の一覧と登録。出店者はイベント所有者だけが管理する。
// 登録すると、そのイベント専用のログインパスワード（アクセスコード）が発行
// され、出店者のメールアドレス宛てに送信される（lib/exhibitor-access.ts）。
// 出店者は Firebase Auth のアカウントを持たない。
// スポット（kind='spot'）はチェックポイント専用で、メールもアクセス
// コードも発行しない（名前・説明・住所だけで登録する）。
// 店舗課金オプションが有効な契約では、登録時に住所（管理用・非公開）が
// 必須になる。画面側は GET の billingAddressRequired で入力欄の出し分けを
// 行い、サーバー側でも同じ条件で必須を強制する。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  createExhibitor,
  ensureExhibitorStampCode,
  listExhibitors,
  parseExhibitorKind,
} from '@/lib/event-coupon';
import {
  updateShopProfile,
  validateShopProfileInput,
} from '@/lib/event-shop';
import {
  ExhibitorAccessError,
  parseRegistrationAddress,
  registerExhibitor,
} from '@/lib/exhibitor-access';
import { findOrganizerByOwnerUid } from '@/lib/organizers';

export const dynamic = 'force-dynamic';

/** 店舗課金オプションが有効な契約かどうか（住所必須の判定）。 */
async function isBillingOptionEnabled(ownerUid: string): Promise<boolean> {
  const organizer = await findOrganizerByOwnerUid(ownerUid);
  return organizer?.billingOptionEnabled === true;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;
  const [listed, billingAddressRequired] = await Promise.all([
    listExhibitors(eventId),
    isBillingOptionEnabled(guard.uid),
  ]);
  // 場所QR用スタンプコードの遅延発行: 導入前の旧参加店にはコンソール
  // 表示のタイミングで発行し、この応答から使えるようにする。
  const exhibitors = await Promise.all(
    listed.map(async (exhibitor) => {
      if (exhibitor.stampCode) return exhibitor;
      const stampCode = await ensureExhibitorStampCode(eventId, exhibitor);
      return stampCode ? { ...exhibitor, stampCode } : exhibitor;
    }),
  );
  return NextResponse.json({ exhibitors, billingAddressRequired });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name.trim()) {
    return NextResponse.json({ error: '出店者名が必要です' }, { status: 400 });
  }
  // アカウントの種類: 'advertiser'（協賛・広告専用）と 'spot'
  // （スポット・チェックポイント専用）だけを特別扱いし、それ以外は
  // 参加店（'shop'）として発行する。
  const kind = parseExhibitorKind(body.kind);

  // スポットはログインを持たないため、メールアドレスもアクセスコードも
  // 発行しない。名前だけで登録し、説明・住所は公開プロフィール
  // （特設サイト・参加者画面の表示用）として保存する。住所からは
  // 地図表示用の座標も引く（updateShopProfile のサーバー側解決）。
  if (kind === 'spot') {
    const validation = validateShopProfileInput({
      address: typeof body.address === 'string' ? body.address : '',
      description: typeof body.description === 'string' ? body.description : '',
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    try {
      const exhibitor = await createExhibitor(eventId, {
        name,
        kind: 'spot',
      });
      await updateShopProfile(db, eventId, exhibitor.id, validation.value);
      return NextResponse.json({ exhibitor }, { status: 201 });
    } catch {
      return NextResponse.json(
        { error: 'スポットの登録に失敗しました' },
        { status: 500 },
      );
    }
  }

  const email = typeof body.email === 'string' ? body.email : '';

  // 店舗課金オプションが有効な契約では住所が必須（画面の出し分けに
  // 頼らず、サーバー側でも強制する）。
  const addressRequired = await isBillingOptionEnabled(guard.uid);
  const addressResult = parseRegistrationAddress(body.address, addressRequired);
  if (!addressResult.ok) {
    return NextResponse.json({ error: addressResult.error }, { status: 400 });
  }

  try {
    const result = await registerExhibitor({
      eventId,
      name,
      email,
      eventName: guard.event.name,
      ...(addressResult.value ? { address: addressResult.value } : {}),
      kind,
    });
    const exhibitors = await listExhibitors(eventId);
    const exhibitor = exhibitors.find((e) => e.id === result.exhibitorId) ?? {
      id: result.exhibitorId,
      name: name.trim(),
      email: result.email,
      address: addressResult.value || null,
      hasAccessCode: true,
      lang: guard.event.defaultLocale,
      kind,
      source: 'admin' as const,
      delistedAt: null,
      closedAt: null,
      stampCode: null,
      checkpointNumber: null,
      stampMethods: kind === 'advertiser' ? [] : ['staff' as const],
      gpsCheck: false,
      velocityCheck: false,
    };
    // コード自体はレスポンスに含めない（メールでのみ出店者に渡る）。
    // メール送信の成否は mailSent で返す（失敗しても登録は成立しているので、
    // 画面側は成功表示とは別に警告を出すために使う）。
    return NextResponse.json(
      { exhibitor, mailSent: result.mailSent },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ExhibitorAccessError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: '出店者の登録に失敗しました' },
      { status: 500 },
    );
  }
}
