// app/api/events/[eventId]/reviews/[reviewId]/visibility/route.test.ts
// レビューの表示切り替え API: プロジェクト所有者（主催者）だけが
// 実行できることを検証する。参加店・来場者はこの API を通れない
// （ガードは requireEventOwner）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventOwner: vi.fn(),
  setReviewVisibility: vi.fn(),
}));

vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: { __db: true } }));
vi.mock('@/lib/event-review', () => ({
  setReviewVisibility: mocks.setReviewVisibility,
}));

import { POST } from './route';

const EVENT_ID = 'event-1';
const REVIEW_ID = 'member-a_shop-a';

function callPost(body: unknown) {
  const request = new Request(
    `http://localhost/api/events/${EVENT_ID}/reviews/${REVIEW_ID}/visibility`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer token',
      },
      body: JSON.stringify(body),
    },
  );
  return POST(request, {
    params: Promise.resolve({ eventId: EVENT_ID, reviewId: REVIEW_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEventOwner.mockResolvedValue({
    uid: 'owner-1',
    event: { id: EVENT_ID },
  });
});

describe('POST /api/events/[eventId]/reviews/[reviewId]/visibility', () => {
  it('主催者は非表示にできる', async () => {
    mocks.setReviewVisibility.mockResolvedValue({
      ok: true,
      reviewId: REVIEW_ID,
      visible: false,
    });
    const response = await callPost({ visible: false });
    expect(response.status).toBe(200);
    expect(mocks.setReviewVisibility).toHaveBeenCalledWith(
      { __db: true },
      { eventId: EVENT_ID, reviewId: REVIEW_ID, visible: false },
    );
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, visible: false });
  });

  it('主催者以外（ガードの 403）は切り替えられない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '権限がありません' }, { status: 403 }),
    });
    const response = await callPost({ visible: false });
    expect(response.status).toBe(403);
    expect(mocks.setReviewVisibility).not.toHaveBeenCalled();
  });

  it('未認証（ガードの 401）は切り替えられない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callPost({ visible: false });
    expect(response.status).toBe(401);
    expect(mocks.setReviewVisibility).not.toHaveBeenCalled();
  });

  it('visible が真偽値でなければ 400', async () => {
    const response = await callPost({});
    expect(response.status).toBe(400);
    expect(mocks.setReviewVisibility).not.toHaveBeenCalled();
  });

  it('レビューが無ければ lib の 404 をそのまま返す', async () => {
    mocks.setReviewVisibility.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'レビューが見つかりません',
    });
    const response = await callPost({ visible: true });
    expect(response.status).toBe(404);
  });
});
