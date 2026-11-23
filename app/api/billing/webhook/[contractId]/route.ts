// app/api/billing/webhook/[contractId]/route.ts
// 店舗課金オプションの Stripe Webhook 受信口。
// 店舗課金とトップ掲載（特設サイトの先頭5枠）と広告と店舗の単発
// 課金（クーポン発行・プッシュ申請）と自己申込（参加店登録・広告
// 申込）で共用し、metadata.kind = 'top-placement' / 'ad-placement' /
// 'coupon-issue' / 'push-send' / 'shop-registration' /
// 'ad-application' のイベントはそれぞれの処理へ振り分ける。
// パスで主催者（契約）を特定し、その主催者自身の Webhook シークレットで
// 署名を検証する。検証は生ボディに対して行う（JSON に変換してからでは
// 署名が一致しない）。署名検証に失敗したら 400。
// 処理結果はローカル記録（Firestore）に反映され、それが課金状態の正。
// オプション OFF／未設定の契約には 404 を返して存在を隠す。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { getOrganizer } from '@/lib/organizers';
import {
  applyStripeWebhookEffect,
  getStripeBillingSettings,
  verifyStripeWebhookEvent,
  type StripeWebhookEventLike,
} from '@/lib/event-billing';
import {
  applyTopPlacementWebhookEffect,
  stripeEventKind,
  TOP_PLACEMENT_KIND,
} from '@/lib/event-placement';
import {
  applyAdWebhookEffect,
  AD_PLACEMENT_KIND,
} from '@/lib/event-ads';
import {
  applyChargeWebhookEffect,
  isChargeKind,
} from '@/lib/event-charges';
import {
  applyApplicationWebhookEffect,
  isApplicationKind,
} from '@/lib/event-apply';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ contractId: string }> },
) {
  const { contractId } = await params;
  const organizer = await getOrganizer(contractId);
  if (!organizer || !organizer.billingOptionEnabled) {
    return NextResponse.json({ error: '見つかりません' }, { status: 404 });
  }
  const settings = await getStripeBillingSettings(db, contractId);
  if (!settings) {
    return NextResponse.json(
      { error: 'Stripe設定が未完了です' },
      { status: 400 },
    );
  }
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: '署名がありません' }, { status: 400 });
  }
  const rawBody = await request.text();

  let event;
  try {
    event = verifyStripeWebhookEvent(
      settings.secretKey,
      settings.webhookSecret,
      rawBody,
      signature,
    );
  } catch {
    return NextResponse.json({ error: '署名検証に失敗しました' }, { status: 400 });
  }

  // metadata.kind で振り分ける: 'top-placement' はトップ掲載、
  // 'ad-placement' は広告、'coupon-issue' / 'push-send' は店舗の単発
  // 課金（クーポン発行・プッシュ申請の都度払い）、
  // 'shop-registration' / 'ad-application' は自己申込の実体化、
  // それ以外（kind なし）は店舗課金として処理する。
  // 申込のサブスクリプション自体は店舗課金／広告の metadata で
  // 作られるため、申込用 kind が付くのは Checkout 完了イベントだけ
  // （以後の請求書・契約イベントは従来の振り分けに乗る）。
  const eventLike = event as unknown as StripeWebhookEventLike;
  const kind = stripeEventKind(eventLike);
  const result =
    kind === TOP_PLACEMENT_KIND
      ? await applyTopPlacementWebhookEffect(db, contractId, eventLike)
      : kind === AD_PLACEMENT_KIND
        ? await applyAdWebhookEffect(db, contractId, eventLike)
        : isChargeKind(kind)
          ? await applyChargeWebhookEffect(db, eventLike)
          : isApplicationKind(kind)
            ? await applyApplicationWebhookEffect(db, eventLike)
            : await applyStripeWebhookEffect(db, contractId, eventLike);
  return NextResponse.json({
    received: true,
    applied: result.applied,
    duplicate: result.duplicate,
  });
}
