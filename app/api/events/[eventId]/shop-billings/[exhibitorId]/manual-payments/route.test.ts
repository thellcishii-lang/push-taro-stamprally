// app/api/events/[eventId]/shop-billings/[exhibitorId]/manual-payments/route.test.ts
// 手動入金記録 API: 所有者ガード、オプション OFF の隠蔽（404）、
// 入力検証、店の存在確認、記録の委譲を検証する。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventOwner: vi.fn(),
  findEnabledBillingOrganizer: vi.fn(),
  getExhibitor: vi.fn(),
  recordManualBillingPayment: vi.fn(),
}));

vi.mock('@/lib/firebase-admin', () => ({ db: { __db: true } }));
vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
vi.mock('@/lib/event-coupon', () => ({
  getExhibitor: mocks.getExhibitor,
}));
vi.mock('@/lib/event-billing', () => ({
  findEnabledBillingOrganizer: mocks.findEnabledBillingOrganizer,
}));
vi.mock('@/lib/event-manual-payment', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/event-manual-payment')>();
  return {
    ...actual,
    recordManualBillingPayment: mocks.recordManualBillingPayment,
  };
});

import { POST } from './route';

const EVENT_ID = 'event-1';
const EXHIBITOR_ID = 'shop-1';

function callPost(body: unknown) {
  return POST(
    new Request(
      `http://localhost/api/events/${EVENT_ID}/shop-billings/${EXHIBITOR_ID}/manual-payments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ eventId: EVENT_ID, exhibitorId: EXHIBITOR_ID }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEventOwner.mockResolvedValue({ uid: 'owner-1' });
  mocks.findEnabledBillingOrganizer.mockResolvedValue({ contractId: 'contract-1' });
  mocks.getExhibitor.mockResolvedValue({ id: EXHIBITOR_ID, name: '店A' });
  mocks.recordManualBillingPayment.mockResolvedValue({
    payment: { id: 'manual_x', amount: 3000 },
    applied: true,
  });
});

describe('POST manual-payments', () => {
  it('所有者でなければガードのエラーをそのまま返す', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '権限がありません' }, { status: 403 }),
    });
    const response = await callPost({
      kind: 'subscription',
      amount: 3000,
      paidDate: '2026-11-28',
    });
    expect(response.status).toBe(403);
    expect(mocks.recordManualBillingPayment).not.toHaveBeenCalled();
  });

  it('オプション OFF は 404 で存在を隠す', async () => {
    mocks.findEnabledBillingOrganizer.mockResolvedValue(null);
    const response = await callPost({
      kind: 'subscription',
      amount: 3000,
      paidDate: '2026-11-28',
    });
    expect(response.status).toBe(404);
  });

  it('不正な入力は 400', async () => {
    const response = await callPost({
      kind: 'subscription',
      amount: -5,
      paidDate: '2026-11-28',
    });
    expect(response.status).toBe(400);
    expect(mocks.recordManualBillingPayment).not.toHaveBeenCalled();
  });

  it('店が無ければ 404', async () => {
    mocks.getExhibitor.mockResolvedValue(null);
    const response = await callPost({
      kind: 'subscription',
      amount: 3000,
      paidDate: '2026-11-28',
    });
    expect(response.status).toBe(404);
  });

  it('正しい入力で記録を委譲し、結果を返す', async () => {
    const response = await callPost({
      kind: 'coupon-issue',
      amount: 500,
      paidDate: '2026-11-28',
      note: '銀行振込',
      targetId: 'coupon-1',
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.applied).toBe(true);
    expect(mocks.recordManualBillingPayment).toHaveBeenCalledWith(
      { __db: true },
      EVENT_ID,
      EXHIBITOR_ID,
      {
        kind: 'coupon-issue',
        amount: 500,
        paidDate: '2026-11-28',
        note: '銀行振込',
        targetId: 'coupon-1',
      },
    );
  });
});
