// app/api/events/[eventId]/stamps/gps/route.test.ts
// GPS付与 API: 来場者認証を通したうえで座標とスポットIDを lib に渡し、
// 結果をそのままステータスに写すことを検証する（距離判定の実体は
// lib/event-stamp.ts の evaluateGpsStamp / grantStampByGps 側）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  memberIdFromRequest: vi.fn(),
  grantStampByGps: vi.fn(),
}));

vi.mock('@/lib/event-member-auth', () => ({
  memberIdFromRequest: mocks.memberIdFromRequest,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: {} }));
vi.mock('@/lib/event-stamp', () => ({
  grantStampByGps: mocks.grantStampByGps,
}));

import { POST } from './route';

const EVENT_ID = 'event-1';

function postRequest(body: unknown) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/stamps/gps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function callPost(body: unknown) {
  return POST(postRequest(body), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memberIdFromRequest.mockResolvedValue({ memberId: 'member-a' });
});

describe('POST /api/events/[eventId]/stamps/gps', () => {
  it('未認証なら認証エラーをそのまま返し、付与しない', async () => {
    mocks.memberIdFromRequest.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callPost({
      exhibitorId: 'shop-a',
      lat: 35.85,
      lng: 139.32,
    });
    expect(response.status).toBe(401);
    expect(mocks.grantStampByGps).not.toHaveBeenCalled();
  });

  it('座標とスポットIDを lib に渡し、正常付与で進捗を返す', async () => {
    mocks.grantStampByGps.mockResolvedValue({
      ok: true,
      stampId: 'member-a_1_shop-a',
      exhibitorId: 'shop-a',
      exhibitorName: '店A',
      round: 1,
      countInRound: 1,
      goalCount: 5,
      completed: false,
      freeCouponId: null,
      rewardType: 'free-dish',
      benefitText: '',
    });
    const response = await callPost({
      exhibitorId: 'shop-a',
      lat: 35.8544,
      lng: 139.3211,
    });
    expect(response.status).toBe(200);
    expect(mocks.grantStampByGps).toHaveBeenCalledWith(
      {},
      {
        eventId: EVENT_ID,
        memberId: 'member-a',
        exhibitorId: 'shop-a',
        point: { lat: 35.8544, lng: 139.3211 },
      },
    );
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, exhibitorName: '店A' });
  });

  it('exhibitorId が無ければ 400 で、付与しない', async () => {
    const response = await callPost({ lat: 35.85, lng: 139.32 });
    expect(response.status).toBe(400);
    expect(mocks.grantStampByGps).not.toHaveBeenCalled();
  });

  it('範囲外は lib の 403（距離入りの文言）をそのまま返す', async () => {
    mocks.grantStampByGps.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'スポットの近くでないとスタンプは押せません（あと約850m 近づいてください）',
    });
    const response = await callPost({
      exhibitorId: 'shop-a',
      lat: 35.86,
      lng: 139.32,
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('近づいてください');
  });

  it('座標が不正なら lib の 400 をそのまま返す', async () => {
    mocks.grantStampByGps.mockResolvedValue({
      ok: false,
      status: 400,
      error: '位置情報が取得できませんでした。位置情報の許可を確認してください',
    });
    const response = await callPost({ exhibitorId: 'shop-a' });
    expect(response.status).toBe(400);
  });
});
