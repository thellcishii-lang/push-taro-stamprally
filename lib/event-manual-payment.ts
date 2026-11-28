// lib/event-manual-payment.ts
// 店舗課金の手動入金記録（銀行振込・現金など、Stripe を通らない入金）。
//
// - 支払い記録は Stripe 経由と同じ billingPayments に source: 'manual' で
//   残すため、入金一覧・集計・CSV にそのまま載る。
// - 月額（subscription）は、記録と同時に店の課金状態を支払い済みにし、
//   期間を1ヶ月延ばし、掲載停止中なら解除する（markShopBillingPaidManually）。
// - 単発課金（coupon-issue / push-send）で対象が指定された場合は、Stripe
//   経由と同じ反映経路（applyChargeEffect）を使い、金額の突き合わせと
//   対象の有効化まで行う。対象が無い場合は記録だけ残す。
import type { Firestore } from 'firebase-admin/firestore';
import {
  BILLING_PAYMENTS_COLLECTION,
  getShopBilling,
  markShopBillingPaidManually,
  type BillingPaymentKind,
  type BillingPaymentRecord,
} from './event-billing';
import { applyChargeEffect, type ChargeKind } from './event-charges';

export interface ManualPaymentInput {
  kind: BillingPaymentKind;
  /** 金額（円） */
  amount: number;
  /** 入金日 'YYYY-MM-DD'（JST） */
  paidDate: string;
  /** メモ（任意、200字まで） */
  note: string | null;
  /** 単発課金の対象ID（クーポン／プッシュ申請）。月額では常に null */
  targetId: string | null;
}

export type ParseManualPaymentResult =
  | { ok: true; value: ManualPaymentInput }
  | { ok: false; error: string };

const MAX_MANUAL_AMOUNT = 10_000_000;

/** 手動入金リクエストの検証（純粋関数）。 */
export function parseManualPaymentInput(body: unknown): ParseManualPaymentResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'リクエスト形式が不正です' };
  }
  const b = body as Record<string, unknown>;
  const kind = b.kind;
  if (kind !== 'subscription' && kind !== 'coupon-issue' && kind !== 'push-send') {
    return { ok: false, error: '種別が不正です' };
  }
  const amount = b.amount;
  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount <= 0 ||
    amount > MAX_MANUAL_AMOUNT
  ) {
    return { ok: false, error: '金額は1円以上の整数で入力してください' };
  }
  const paidDate = b.paidDate;
  if (
    typeof paidDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(paidDate) ||
    Number.isNaN(new Date(`${paidDate}T00:00:00+09:00`).getTime())
  ) {
    return { ok: false, error: '入金日が不正です' };
  }
  let note: string | null = null;
  if (b.note !== undefined && b.note !== null && b.note !== '') {
    if (typeof b.note !== 'string') return { ok: false, error: 'メモが不正です' };
    note = b.note.trim().slice(0, 200) || null;
  }
  let targetId: string | null = null;
  if (b.targetId !== undefined && b.targetId !== null && b.targetId !== '') {
    if (typeof b.targetId !== 'string') return { ok: false, error: '対象が不正です' };
    targetId = b.targetId;
  }
  if (kind === 'subscription') targetId = null;
  return { ok: true, value: { kind, amount, paidDate, note, targetId } };
}

/**
 * 入金日（JST）から paidAt の ISO 文字列を作る。JST 正午で固定し、
 * 集計の日付（JST の日付部分）が入金日とずれないようにする。
 */
export function manualPaidAtIso(paidDate: string): string {
  return new Date(`${paidDate}T12:00:00+09:00`).toISOString();
}

/** 手動入金後の期間終了: 現在の期間終了と支払日の遅い方から1ヶ月後。 */
export function nextManualPeriodEnd(
  currentPeriodEnd: string | null,
  paidAtIso: string,
): string {
  const base =
    currentPeriodEnd && currentPeriodEnd > paidAtIso
      ? new Date(currentPeriodEnd)
      : new Date(paidAtIso);
  const next = new Date(base.getTime());
  next.setUTCMonth(next.getUTCMonth() + 1);
  return next.toISOString();
}

export interface RecordManualPaymentResult {
  payment: BillingPaymentRecord;
  /** 対象の有効化・状態反映までできたか。金額不一致などは false で reason が付く */
  applied: boolean;
  reason?: string;
}

function manualRecord(
  paymentId: string,
  exhibitorId: string,
  input: ManualPaymentInput,
  paidAt: string,
  occurredAt: string,
): BillingPaymentRecord {
  return {
    id: paymentId,
    exhibitorId,
    kind: input.kind,
    amount: input.amount,
    status: 'paid',
    paidAt,
    occurredAt,
    stripeEventId: paymentId,
    stripeInvoiceId: null,
    source: 'manual',
    targetId: input.targetId,
    note: input.note,
  };
}

/** 手動入金を記録し、種別に応じた反映まで行う。 */
export async function recordManualBillingPayment(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  input: ManualPaymentInput,
): Promise<RecordManualPaymentResult> {
  const paidAt = manualPaidAtIso(input.paidDate);
  const paymentsRef = db
    .collection('events')
    .doc(eventId)
    .collection(BILLING_PAYMENTS_COLLECTION);
  const paymentId = `manual_${paymentsRef.doc().id}`;

  // 単発課金で対象が指定されている場合は、Stripe 経由と同じ反映経路を使う
  if (
    (input.kind === 'coupon-issue' || input.kind === 'push-send') &&
    input.targetId
  ) {
    const result = await applyChargeEffect(db, {
      eventId,
      kind: input.kind as ChargeKind,
      exhibitorId,
      targetId: input.targetId,
      sessionId: paymentId,
      amount: input.amount,
      paidAt,
      stripeEventId: null,
      source: 'manual',
      note: input.note,
    });
    return {
      payment: manualRecord(paymentId, exhibitorId, input, paidAt, paidAt),
      applied: result.applied,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  }

  const occurredAt = new Date().toISOString();
  await paymentsRef.doc(paymentId).create({
    exhibitorId,
    kind: input.kind,
    targetId: null,
    amount: input.amount,
    status: 'paid',
    paidAt,
    occurredAt,
    stripeEventId: null,
    stripeInvoiceId: null,
    stripeCheckoutSessionId: null,
    source: 'manual',
    note: input.note,
  });

  if (input.kind === 'subscription') {
    const existing = await getShopBilling(db, eventId, exhibitorId);
    await markShopBillingPaidManually(db, eventId, exhibitorId, {
      amount: input.amount,
      currentPeriodEnd: nextManualPeriodEnd(
        existing?.currentPeriodEnd ?? null,
        paidAt,
      ),
    });
  }

  return {
    payment: manualRecord(
      paymentId,
      exhibitorId,
      { ...input, targetId: null },
      paidAt,
      occurredAt,
    ),
    applied: true,
  };
}
