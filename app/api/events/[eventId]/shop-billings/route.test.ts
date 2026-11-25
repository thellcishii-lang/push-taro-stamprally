// app/api/events/[eventId]/shop-billings/route.test.ts
// 課金一覧 API: 所有者ガード、オプション OFF の隠蔽（404）、
// 店別状態と収支サマリがローカル記録から返ることを検証する。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventOwner: vi.fn(),
  listExhibitors: vi.fn(),
  findEnabledBillingOrganizer: vi.fn(),
  listShopBillings: vi.fn(),
  listBillingPayments: vi.fn(),
  summarizePaymentsByMonth: vi.fn(),
}));

vi.mock('@/lib/firebase-admin', () => ({ db: { __db: true } }));
vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
vi.mock('@/lib/event-coupon', () => ({
  listExhibitors: mocks.listExhibitors,
}));
vi.mock('@/lib/event-billing', () => ({
  findEnabledBillingOrganizer: mocks.findEnabledBillingOrganizer,
  listShopBillings: mocks.listShopBillings,
  listBillingPayments: mocks.listBillingPayments,
  summarizePaymentsByMonth: mocks.summarizePaymentsByMonth,
}));

import { GET } from './route';

const EVENT_ID = 'event-1';

function callGet() {
  return GET(new Request(`http://localhost/api/events/${EVENT_ID}/shop-billings`), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEventOwner.mockResolvedValue({
    uid: 'owner-1',
    event: { id: EVENT_ID },
  });
  mocks.findEnabledBillingOrganizer.mockResolvedValue({
    contractId: 'contract-1',
    billingOptionEnabled: true,
  });
  mocks.listExhibitors.mockResolvedValue([
    // 実 lib の listExhibitors は kind を必ず返す（旧データは 'shop' に倒す）
    { id: 'shop-1', name: '店A', email: null, hasAccessCode: true, lang: 'ja', kind: 'shop' },
  ]);
  mocks.listShopBillings.mockResolvedValue([
    { exhibitorId: 'shop-1', status: 'active', monthlyAmount: 3000 },
  ]);
  mocks.listBillingPayments.mockImplementation(
    async (_db: unknown, _eventId: string, limit: number) =>
      limit > 50
        ? [
            {
              id: 'evt_1',
              exhibitorId: 'shop-1',
              amount: 3000,
              status: 'paid',
              paidAt: '2026-11-02T00:00:00.000Z',
              occurredAt: '2026-11-02T00:00:00.000Z',
            },
          ]
        : [],
  );
  mocks.summarizePaymentsByMonth.mockReturnValue({
    currentMonthKey: '2026-11',
    currentMonthTotal: 3000,
    previousMonthKey: '2026-10',
    previousMonthTotal: 0,
  });
});

describe('GET /api/events/[eventId]/shop-billings', () => {
  it('所有者でなければガードのエラーをそのまま返す', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '権限がありません' }, { status: 403 }),
    });
    const response = await callGet();
    expect(response.status).toBe(403);
    expect(mocks.listShopBillings).not.toHaveBeenCalled();
  });

  it('オプション OFF は 404 で存在を隠す', async () => {
    mocks.findEnabledBillingOrganizer.mockResolvedValue(null);
    const response = await callGet();
    expect(response.status).toBe(404);
    expect(mocks.listShopBillings).not.toHaveBeenCalled();
  });

  it('店一覧・課金状態・収支サマリを返す', async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exhibitors).toEqual([{ id: 'shop-1', name: '店A', address: null }]);
    expect(body.billings).toHaveLength(1);
    expect(body.billings[0].status).toBe('active');
    expect(body.summary).toEqual({
      currentMonthKey: '2026-11',
      currentMonthTotal: 3000,
      previousMonthKey: '2026-10',
      previousMonthTotal: 0,
    });
  });
});
