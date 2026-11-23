// app/api/events/[eventId]/ranking/recompute/route.test.ts
// 手動再計算 API: 主催者ガードを通し、対象週（既定は先週、weekStart
// 指定時はその週）を lib の計算に渡すことを検証する。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventOwner: vi.fn(),
  computeWeeklyRanking: vi.fn(),
}));

vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: {} }));
vi.mock('@/lib/event-ranking', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/event-ranking')>();
  return {
    ...actual,
    computeWeeklyRanking: mocks.computeWeeklyRanking,
  };
});

import { POST } from './route';

const EVENT_ID = 'event-1';
const EVENT = { id: EVENT_ID, rankingMinReviews: 3 };

function callPost(body?: unknown) {
  const request = new Request(
    `http://localhost/api/events/${EVENT_ID}/ranking/recompute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  return POST(request, { params: Promise.resolve({ eventId: EVENT_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  // 2026-11-18（水）12:00 JST に固定する
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-18T03:00:00Z'));
  mocks.requireEventOwner.mockResolvedValue({ uid: 'owner-1', event: EVENT });
  mocks.computeWeeklyRanking.mockImplementation(
    async (_db: unknown, _eventId: string, period: { start: string; end: string }) => ({
      weekKey: period.start,
      periodStart: period.start,
      periodEnd: period.end,
      entries: [],
      computedAt: '2026-11-18T03:00:00.000Z',
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/events/[eventId]/ranking/recompute', () => {
  it('未認証（ガードの 401）をそのまま返し、計算しない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callPost();
    expect(response.status).toBe(401);
    expect(mocks.computeWeeklyRanking).not.toHaveBeenCalled();
  });

  it('body 無しなら先週（2026-11-09〜15）を対象に、プロジェクトの最低件数で計算する', async () => {
    const response = await callPost();
    expect(response.status).toBe(200);
    expect(mocks.computeWeeklyRanking).toHaveBeenCalledWith(
      {},
      EVENT_ID,
      { start: '2026-11-09', end: '2026-11-15' },
      3,
    );
    const body = await response.json();
    expect(body.ranking.weekKey).toBe('2026-11-09');
  });

  it('weekStart を指定すると、その日を含む週が対象になる', async () => {
    const response = await callPost({ weekStart: '2026-11-04' });
    expect(response.status).toBe(200);
    expect(mocks.computeWeeklyRanking).toHaveBeenCalledWith(
      {},
      EVENT_ID,
      { start: '2026-11-02', end: '2026-11-08' },
      3,
    );
  });

  it('weekStart の形式が不正なら 400 で、計算しない', async () => {
    const response = await callPost({ weekStart: '2026/11/04' });
    expect(response.status).toBe(400);
    expect(mocks.computeWeeklyRanking).not.toHaveBeenCalled();
  });
});
