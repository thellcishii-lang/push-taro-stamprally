// app/api/events/[eventId]/shop-coupons/route.ts
// 参加店向け: 自店のクーポン一覧と、自店クーポンの発行。
// 店舗発行のクーポンは、無料・有料を問わず主催者の承認が済むまで
// 公開されない（承認待ちで作られる）。
// 発行手数料（プロジェクト設定 couponIssuePrice、1件あたり）:
// - 無料（0円・未設定）: 承認されればそのまま公開される。
// - 有料: クーポンは支払い待ち（非公開・取得不可）で作られ、主催者
//   自身の Stripe の Checkout で支払うと支払いが確定する。支払いの
//   反映は戻り時の照会（shop-charges/verify）と Webhook の2経路で冪等。
//   承認と支払いの両方が済んだ時点で公開される。
// exhibitorId はセッションから決める（他店の分は作れない）。
// 協賛（広告専用）アカウントは使えない。
import { NextResponse } from 'next/server';
import { requireEventExhibitor } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import { createCoupon, listCoupons } from '@/lib/event-coupon';
import { resolveAdAvailability } from '@/lib/event-ads';
import {
  COUPON_ISSUE_KIND,
  chargeRequiresPayment,
  couponIssueFeeOf,
  isShopListedForCharges,
  setCouponChargeSession,
  startOneTimeCharge,
} from '@/lib/event-charges';

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
      { error: '協賛アカウントではクーポンを発行できません' },
      { status: 403 },
    );
  }
  const coupons = (await listCoupons(eventId)).filter(
    (coupon) => coupon.exhibitorId === exhibitor.id,
  );
  return NextResponse.json({
    fee: couponIssueFeeOf(event),
    coupons,
  });
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
      { error: '協賛アカウントではクーポンを発行できません' },
      { status: 403 },
    );
  }
  // 掲載中（プロフィール公開・課金停止でない）店だけが発行できる
  const listed = await isShopListedForCharges(db, eventId, exhibitor.id);
  if (!listed) {
    return NextResponse.json(
      { error: '掲載中の店舗だけがクーポンを発行できます' },
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
  if (!title.trim()) {
    return NextResponse.json(
      { error: 'クーポンのタイトルが必要です' },
      { status: 400 },
    );
  }
  const description =
    typeof body.description === 'string' ? body.description : undefined;
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((k): k is string => typeof k === 'string')
    : undefined;

  const fee = couponIssueFeeOf(event);
  const paid = chargeRequiresPayment(fee);

  // 有料のときは、先に課金レール（主催者の Stripe）が使えることを
  // 確認してから作る（支払えないクーポンを量産しないため）。
  let contractId: string | null = null;
  if (paid) {
    const availability = await resolveAdAvailability(db, event.ownerUid);
    if (!availability.available || !availability.organizer) {
      return NextResponse.json(
        { error: '現在クーポン発行のお支払いを受け付けていません' },
        { status: 404 },
      );
    }
    contractId = availability.organizer.contractId;
  }

  let coupon;
  try {
    coupon = await createCoupon(eventId, {
      exhibitorId: exhibitor.id,
      title,
      description,
      keywords,
      issuedBy: 'shop',
      paymentPending: paid,
      feeAmount: paid ? fee : null,
      approvalStatus: 'pending',
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'クーポンの発行に失敗しました',
      },
      { status: 400 },
    );
  }

  if (!paid || !contractId) {
    return NextResponse.json({ coupon, checkoutUrl: null }, { status: 201 });
  }

  // 支払いページを発行する。失敗してもクーポン（支払い待ち）は残り、
  // 店舗ページの「お支払いへ」から再開できる。
  try {
    const charge = await startOneTimeCharge(db, {
      contractId,
      eventId,
      exhibitorId: exhibitor.id,
      kind: COUPON_ISSUE_KIND,
      targetId: coupon.id,
      amount: fee,
    });
    if (!charge.ok) {
      return NextResponse.json(
        { coupon, checkoutUrl: null, chargeError: charge.error },
        { status: 201 },
      );
    }
    await setCouponChargeSession(db, eventId, coupon.id, charge.sessionId);
    return NextResponse.json(
      { coupon, checkoutUrl: charge.checkoutUrl },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { coupon, checkoutUrl: null, chargeError: '支払いページの発行に失敗しました' },
      { status: 201 },
    );
  }
}
