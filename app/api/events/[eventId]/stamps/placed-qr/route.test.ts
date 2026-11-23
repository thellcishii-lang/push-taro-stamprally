// app/api/events/[eventId]/stamps/placed-qr/route.test.ts
// 場所QR付与 API: 来場者認証（memberIdFromRequest）を通したうえで、
// lib の結果をそのままステータスに写すことを検証する（スポット特定・
// 会員・周の検証の実体は lib/event-stamp.ts 側で担保される）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  memberIdFromRequest: vi.fn(),
  grantStampByPlacedQr: vi.fn(),
}));

vi.mock('@/lib/event-member-auth', () => ({
  memberIdFromRequest: mocks.memberIdFromRequest,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: {} }));
vi.mock('@/lib/event-stamp', () => ({
  grantStampByPlacedQr: mocks.grantStampByPlacedQr,
}));

import { POST } from './route';

const EVENT_ID = 'event-1';
const CODE = 'ABCDEFGHJKMNPQRSTUVW';

function postRequest(body: unknown) {
  return new Request(
    `http://localhost/api/events/${EVENT_ID}/stamps/placed-qr`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
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

describe('POST /api/events/[eventId]/stamps/placed-qr', () => {
  it('未認証なら認証エラーをそのまま返し、付与しない', async () => {
    mocks.memberIdFromRequest.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callPost({ stampCode: CODE });
    expect(response.status).toBe(401);
    expect(mocks.grantStampByPlacedQr).not.toHaveBeenCalled();
  });

  it('正常付与でスポット名と進捗を返す', async () => {
    mocks.grantStampByPlacedQr.mockResolvedValue({
      ok: true,
      stampId: 'member-a_1_shop-a',
      exhibitorId: 'shop-a',
      exhibitorName: '店A',
      round: 1,
      countInRound: 2,
      goalCount: 5,
      completed: false,
      freeCouponId: null,
      rewardType: 'free-dish',
      benefitText: '',
    });
    const response = await callPost({ stampCode: CODE });
    expect(response.status).toBe(200);
    expect(mocks.grantStampByPlacedQr).toHaveBeenCalledWith(
      {},
      { eventId: EVENT_ID, memberId: 'member-a', stampCode: CODE },
    );
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      exhibitorId: 'shop-a',
      exhibitorName: '店A',
      countInRound: 2,
      completed: false,
    });
  });

  it('不正なコードは lib の 400 をそのまま返す', async () => {
    mocks.grantStampByPlacedQr.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'QRコードが正しくありません',
    });
    const response = await callPost({ stampCode: 'bad' });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('QRコードが正しくありません');
  });

  it('同じ周の重複は 409', async () => {
    mocks.grantStampByPlacedQr.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'この周では、すでにこのお店のスタンプを押しています',
    });
    const response = await callPost({ stampCode: CODE });
    expect(response.status).toBe(409);
  });

  it('未登録の来場者は 404', async () => {
    mocks.grantStampByPlacedQr.mockResolvedValue({
      ok: false,
      status: 404,
      error: '登録が見つかりません',
    });
    const response = await callPost({ stampCode: CODE });
    expect(response.status).toBe(404);
  });
});
