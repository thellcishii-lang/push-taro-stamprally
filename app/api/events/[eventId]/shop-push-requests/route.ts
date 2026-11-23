// app/api/events/[eventId]/shop-push-requests/route.ts
// 参加店向け: プッシュ配信申請の一覧と作成。
// 手数料（プロジェクト設定 pushPrice、1回あたり）:
// - 無料（0円・未設定）: 申請はそのまま主催者の承認待ちになる。
// - 有料: 申請は支払い待ちで作られ、主催者自身の Stripe で支払いが
//   確認できてから承認待ちになる（未払いは承認キューに出ない）。
// 配信そのものは主催者の承認時に通常の配信として実行される。
// 協賛（広告専用）アカウントは使えない。
import { NextResponse } from 'next/server';
import { requireEventExhibitor } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { resolveAdAvailability } from '@/lib/event-ads';
import {
  PUSH_SEND_KIND,
  chargeRequiresPayment,
  isShopListedForCharges,
  pushFeeOf,
  startOneTimeCharge,
} from '@/lib/event-charges';
import {
  createPushRequest,
  listPushRequestsForShop,
  setPushRequestChargeSession,
} from '@/lib/event-push-request';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventExhibitor(request, eventId);
  if ('error' in guard) return guard.error;
  const { event, exhibitor } = guard;
  if (exhibitor.kind === 'advertiser') {
    return NextResponse.json(
      { error: '協賛アカウントではプッシュ配信を申請できません' },
      { status: 403 },
    );
  }
  const requests = await listPushRequestsForShop(db, eventId, exhibitor.id);
  return NextResponse.json({ fee: pushFeeOf(event), requests });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventExhibitor(request, eventId);
  if ('error' in guard) return guard.error;
  const { event, exhibitor } = guard;
  if (exhibitor.kind === 'advertiser') {
    return NextResponse.json(
      { error: '協賛アカウントではプッシュ配信を申請できません' },
      { status: 403 },
    );
  }
  // 掲載中（プロフィール公開・課金停止でない）店だけが申請できる
  const listed = await isShopListedForCharges(db, eventId, exhibitor.id);
  if (!listed) {
    return NextResponse.json(
      { error: '掲載中の店舗だけがプッシュ配信を申請できます' },
      { status: 403 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }
  const title = typeof body.title === 'string' ? body.title : '';
  const pushBody = typeof body.body === 'string' ? body.body : '';
  if (!title.trim() || !pushBody.trim()) {
    return NextResponse.json(
      { error: 'タイトルと本文が必要です' },
      { status: 400 },
    );
  }

  const fee = pushFeeOf(event);
  const paid = chargeRequiresPayment(fee);

  // 有料のときは、先に課金レール（主催者の Stripe）が使えることを確認する
  let contractId: string | null = null;
  if (paid) {
    const availability = await resolveAdAvailability(db, event.ownerUid);
    if (!availability.available || !availability.organizer) {
      return NextResponse.json(
        { error: '現在プッシュ配信のお支払いを受け付けていません' },
        { status: 404 },
      );
    }
    contractId = availability.organizer.contractId;
  }

  let pushRequest;
  try {
    pushRequest = await createPushRequest(db, eventId, {
      exhibitorId: exhibitor.id,
      exhibitorName: exhibitor.name,
      title,
      body: pushBody,
      feeAmount: fee,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : '申請の作成に失敗しました',
      },
      { status: 400 },
    );
  }

  if (!paid || !contractId) {
    return NextResponse.json(
      { request: pushRequest, checkoutUrl: null },
      { status: 201 },
    );
  }

  // 支払いページを発行する。失敗しても申請（支払い待ち）は残り、
  // 店舗ページの「お支払いへ」から再開できる。
  try {
    const charge = await startOneTimeCharge(db, {
      contractId,
      eventId,
      exhibitorId: exhibitor.id,
      kind: PUSH_SEND_KIND,
      targetId: pushRequest.id,
      amount: fee,
    });
    if (!charge.ok) {
      return NextResponse.json(
        { request: pushRequest, checkoutUrl: null, chargeError: charge.error },
        { status: 201 },
      );
    }
    await setPushRequestChargeSession(db, eventId, pushRequest.id, charge.sessionId);
    return NextResponse.json(
      { request: { ...pushRequest, chargeSessionId: charge.sessionId }, checkoutUrl: charge.checkoutUrl },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { request: pushRequest, checkoutUrl: null, chargeError: '支払いページの発行に失敗しました' },
      { status: 201 },
    );
  }
}
