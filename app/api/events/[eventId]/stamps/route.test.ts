// app/api/events/[eventId]/stamps/route.test.ts
// スタンプ付与 API: 参加店ガードを通したうえで lib の結果をそのまま
// ステータスに写すことを検証する（認可の実体は requireEventExhibitor、
// 付与の実体は grantStamp 側で担保される）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventExhibitor: vi.fn(),
  grantStamp: vi.fn(),
  listTodayStampsByExhibitor: vi.fn(),
}));

vi.mock('@/lib/event-auth', () => ({
  requireEventExhibitor: mocks.requireEventExhibitor,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: {} }));
vi.mock('@/lib/event-stamp', () => ({
  grantStamp: mocks.grantStamp,
  listTodayStampsByExhibitor: mocks.listTodayStampsByExhibitor,
}));

import { GET, POST } from './route';

const EVENT_ID = 'event-1';
const EXHIBITOR = { id: 'shop-a', name: '店A' };

function postRequest(body: unknown) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/stamps`, {
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
  mocks.requireEventExhibitor.mockResolvedValue({
    exhibitor: EXHIBITOR,
    event: { id: EVENT_ID },
  });
});

describe('POST /api/events/[eventId]/stamps', () => {
  it('未認証（ガードの 401）をそのまま返し、付与しない', async () => {
    mocks.requireEventExhibitor.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callPost({ memberId: 'member-a' });
    expect(response.status).toBe(401);
    expect(mocks.grantStamp).not.toHaveBeenCalled();
  });

  it('主催者（ガードの 403）は押せない', async () => {
    mocks.requireEventExhibitor.mockResolvedValue({
      error: NextResponse.json(
        { error: 'この操作は参加店だけが行えます' },
        { status: 403 },
      ),
    });
    const response = await callPost({ memberId: 'member-a' });
    expect(response.status).toBe(403);
    expect(mocks.grantStamp).not.toHaveBeenCalled();
  });

  it('正常付与で進捗を返す', async () => {
    mocks.grantStamp.mockResolvedValue({
      ok: true,
      stampId: 'member-a_1_shop-a',
      round: 1,
      countInRound: 3,
      goalCount: 5,
      completed: false,
      freeCouponId: null,
    });
    const response = await callPost({ memberId: 'member-a' });
    expect(response.status).toBe(200);
    expect(mocks.grantStamp).toHaveBeenCalledWith(
      {},
      { eventId: EVENT_ID, exhibitor: EXHIBITOR, memberId: 'member-a' },
    );
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      stampId: 'member-a_1_shop-a',
      round: 1,
      countInRound: 3,
      goalCount: 5,
      completed: false,
      freeCouponId: null,
    });
  });

  it('達成時は completed と freeCouponId を返す', async () => {
    mocks.grantStamp.mockResolvedValue({
      ok: true,
      stampId: 'member-a_1_shop-e',
      round: 1,
      countInRound: 5,
      goalCount: 5,
      completed: true,
      freeCouponId: 'free-1',
    });
    const response = await callPost({ memberId: 'member-a' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.completed).toBe(true);
    expect(body.freeCouponId).toBe('free-1');
  });

  it('同じ周の重複は 409（二重押し防止）', async () => {
    mocks.grantStamp.mockResolvedValue({
      ok: false,
      status: 409,
      error: 'この周では、すでにこのお店のスタンプを押しています',
    });
    const response = await callPost({ memberId: 'member-a' });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('すでにこのお店のスタンプ');
  });

  it('非購読者は 404', async () => {
    mocks.grantStamp.mockResolvedValue({
      ok: false,
      status: 404,
      error: '登録が見つかりません',
    });
    const response = await callPost({ memberId: 'member-x' });
    expect(response.status).toBe(404);
  });

  it('memberId が無ければ 400 で、付与しない', async () => {
    const response = await callPost({});
    expect(response.status).toBe(400);
    expect(mocks.grantStamp).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/[eventId]/stamps?scope=mine-today', () => {
  it('当日の自店スタンプ一覧を返す', async () => {
    mocks.listTodayStampsByExhibitor.mockResolvedValue([
      { id: 'member-a_1_shop-a', exhibitorId: 'shop-a' },
    ]);
    const request = new Request(
      `http://localhost/api/events/${EVENT_ID}/stamps?scope=mine-today`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    expect(mocks.listTodayStampsByExhibitor).toHaveBeenCalledWith(
      {},
      EVENT_ID,
      'shop-a',
    );
    const body = await response.json();
    expect(body.stamps).toHaveLength(1);
  });

  it('scope が不正なら 400', async () => {
    const request = new Request(
      `http://localhost/api/events/${EVENT_ID}/stamps?scope=all`,
    );
    const response = await GET(request, {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(400);
    expect(mocks.listTodayStampsByExhibitor).not.toHaveBeenCalled();
  });
});
