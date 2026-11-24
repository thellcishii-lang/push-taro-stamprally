// app/api/events/[eventId]/coupons/public/route.test.ts
// 来場者向けクーポン一覧: 有効なクーポンだけを返し、店舗課金で
// 掲載停止中の店のクーポンは出さないことを検証する。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listCoupons: vi.fn(),
  getEvent: vi.fn(),
  listBillingSuspendedExhibitorIds: vi.fn(),
}));

vi.mock('@/lib/firebase-admin', () => ({ db: { __db: true } }));
vi.mock('@/lib/event-coupon', () => ({
  listCoupons: mocks.listCoupons,
  // 実物と同じ意味の最小実装（空クエリは全件）。
  filterCoupons: (coupons: unknown[], query: string) =>
    query.trim()
      ? (coupons as Array<{ title: string }>).filter((c) =>
          c.title.includes(query.trim()),
        )
      : coupons,
  // 実物と同じ意味の最小実装。
  jstTodayString: () => '2026-11-24',
  couponClaimState: (
    coupon: { claimFrom?: string | null; claimUntil?: string | null },
    today: string,
  ) => {
    if (coupon.claimFrom && today < coupon.claimFrom) return 'upcoming';
    if (coupon.claimUntil && today > coupon.claimUntil) return 'closed';
    return 'open';
  },
}));
vi.mock('@/lib/event-store', () => ({
  getEvent: mocks.getEvent,
}));
vi.mock('@/lib/event-shop', () => ({
  listBillingSuspendedExhibitorIds: mocks.listBillingSuspendedExhibitorIds,
}));
vi.mock('@/lib/i18n', () => ({
  normalizeLocale: () => 'ja',
  pickLocalizedText: () => '',
}));

import { GET } from './route';

const EVENT_ID = 'event-1';

function coupon(overrides: Record<string, unknown>) {
  return {
    id: 'coupon-1',
    exhibitorId: 'shop-1',
    exhibitorName: '店A',
    title: 'クーポン',
    description: '',
    titleI18n: {},
    descriptionI18n: {},
    keywords: [],
    active: true,
    ...overrides,
  };
}

function callGet() {
  return GET(new Request(`http://localhost/api/events/${EVENT_ID}/coupons/public`), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEvent.mockResolvedValue({ defaultLocale: 'ja' });
  mocks.listBillingSuspendedExhibitorIds.mockResolvedValue(new Set<string>());
  mocks.listCoupons.mockResolvedValue([
    coupon({ id: 'coupon-1', exhibitorId: 'shop-1', title: '通常クーポン' }),
    coupon({ id: 'coupon-2', exhibitorId: 'shop-2', title: '停止店のクーポン' }),
    coupon({ id: 'coupon-3', exhibitorId: 'shop-1', title: '無効クーポン', active: false }),
  ]);
});

describe('GET /api/events/[eventId]/coupons/public', () => {
  it('停止店がいなければ有効なクーポンをすべて返す', async () => {
    const response = await callGet();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.coupons.map((c: { id: string }) => c.id)).toEqual([
      'coupon-1',
      'coupon-2',
    ]);
  });

  it('掲載停止中の店のクーポンは出さない', async () => {
    mocks.listBillingSuspendedExhibitorIds.mockResolvedValue(
      new Set(['shop-2']),
    );
    const response = await callGet();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.coupons.map((c: { id: string }) => c.id)).toEqual(['coupon-1']);
  });
});
