// app/api/events/[eventId]/shop-billings/[exhibitorId]/manual-payments/route.ts
// 店舗課金オプション: Stripe を通らない入金（銀行振込・現金など）を
// 主催者が手動で記録する。記録は入金一覧・集計・CSV にそのまま載る。
// - 月額: 店の課金状態を支払い済みにし、期間を1ヶ月延ばす。
// - 単発課金で対象（クーポン／プッシュ申請）を指定した場合は、金額を
//   突き合わせて対象を有効化する（Stripe 経由と同じ経路）。
// オプション OFF の契約では 404 にして機能の存在自体を隠す。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import { requireEventOwner } from '@/lib/event-auth';
import { getExhibitor } from '@/lib/event-coupon';
import { findEnabledBillingOrganizer } from '@/lib/event-billing';
import {
  parseManualPaymentInput,
  recordManualBillingPayment,
} from '@/lib/event-manual-payment';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string; exhibitorId: string }> },
) {
  const { eventId, exhibitorId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const organizer = await findEnabledBillingOrganizer(guard.uid);
  if (!organizer) {
    return NextResponse.json({ error: '見つかりません' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 });
  }
  const parsed = parseManualPaymentInput(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const exhibitor = await getExhibitor(eventId, exhibitorId);
  if (!exhibitor) {
    return NextResponse.json({ error: '参加店が見つかりません' }, { status: 404 });
  }

  const result = await recordManualBillingPayment(
    db,
    eventId,
    exhibitorId,
    parsed.value,
  );
  return NextResponse.json({
    payment: result.payment,
    applied: result.applied,
    ...(result.reason ? { reason: result.reason } : {}),
  });
}
