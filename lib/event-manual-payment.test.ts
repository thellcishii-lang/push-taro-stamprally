// lib/event-manual-payment.test.ts
// 手動入金記録の純粋関数（入力検証・日付計算）のテスト。
import { describe, expect, it } from 'vitest';
import {
  manualPaidAtIso,
  nextManualPeriodEnd,
  parseManualPaymentInput,
} from './event-manual-payment';

describe('parseManualPaymentInput', () => {
  it('正しい入力を受け付ける', () => {
    const result = parseManualPaymentInput({
      kind: 'subscription',
      amount: 3000,
      paidDate: '2026-11-28',
      note: '銀行振込',
      targetId: null,
    });
    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'subscription',
        amount: 3000,
        paidDate: '2026-11-28',
        note: '銀行振込',
        targetId: null,
      },
    });
  });

  it('月額では対象IDを落とす', () => {
    const result = parseManualPaymentInput({
      kind: 'subscription',
      amount: 3000,
      paidDate: '2026-11-28',
      targetId: 'coupon-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.targetId).toBeNull();
  });

  it('単発課金では対象IDを保持する', () => {
    const result = parseManualPaymentInput({
      kind: 'coupon-issue',
      amount: 500,
      paidDate: '2026-11-28',
      targetId: 'coupon-1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.targetId).toBe('coupon-1');
  });

  it('不正な種別・金額・日付を弾く', () => {
    expect(
      parseManualPaymentInput({ kind: 'other', amount: 100, paidDate: '2026-11-28' }).ok,
    ).toBe(false);
    expect(
      parseManualPaymentInput({ kind: 'subscription', amount: 0, paidDate: '2026-11-28' }).ok,
    ).toBe(false);
    expect(
      parseManualPaymentInput({ kind: 'subscription', amount: 100.5, paidDate: '2026-11-28' }).ok,
    ).toBe(false);
    expect(
      parseManualPaymentInput({ kind: 'subscription', amount: 100, paidDate: '2026/11/28' }).ok,
    ).toBe(false);
    expect(
      parseManualPaymentInput({ kind: 'subscription', amount: 100, paidDate: '2026-13-40' }).ok,
    ).toBe(false);
    expect(parseManualPaymentInput(null).ok).toBe(false);
  });

  it('メモは200字で切り、空は null にする', () => {
    const long = parseManualPaymentInput({
      kind: 'subscription',
      amount: 100,
      paidDate: '2026-11-28',
      note: 'あ'.repeat(300),
    });
    expect(long.ok).toBe(true);
    if (long.ok) expect(long.value.note).toHaveLength(200);
    const empty = parseManualPaymentInput({
      kind: 'subscription',
      amount: 100,
      paidDate: '2026-11-28',
      note: '  ',
    });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value.note).toBeNull();
  });
});

describe('manualPaidAtIso', () => {
  it('JST の日付がそのまま集計日になる ISO を返す', () => {
    // JST 正午 = UTC 03:00
    expect(manualPaidAtIso('2026-11-28')).toBe('2026-11-28T03:00:00.000Z');
  });
});

describe('nextManualPeriodEnd', () => {
  it('期間が無ければ支払日から1ヶ月後', () => {
    expect(nextManualPeriodEnd(null, '2026-11-28T03:00:00.000Z')).toBe(
      '2026-12-28T03:00:00.000Z',
    );
  });

  it('現在の期間終了が先なら、そこから1ヶ月後', () => {
    expect(
      nextManualPeriodEnd('2026-12-15T00:00:00.000Z', '2026-11-28T03:00:00.000Z'),
    ).toBe('2027-01-15T00:00:00.000Z');
  });

  it('期間が過ぎていれば支払日から1ヶ月後', () => {
    expect(
      nextManualPeriodEnd('2026-10-01T00:00:00.000Z', '2026-11-28T03:00:00.000Z'),
    ).toBe('2026-12-28T03:00:00.000Z');
  });
});
