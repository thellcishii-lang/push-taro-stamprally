// app/api/events/[eventId]/social-posts/route.test.ts
// 投稿キューの主催者 API: 所有者ガードと入力検証（実物の純粋関数）を
// 通して lib の作成／一覧につながることを検証する。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  createSocialPost: vi.fn(),
  listSocialPosts: vi.fn(),
  requireEventOwner: vi.fn(),
}));

vi.mock('@/lib/firebase-admin', () => ({
  db: { __db: true },
}));
vi.mock('@/lib/event-social', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/event-social')>()),
  createSocialPost: mocks.createSocialPost,
  listSocialPosts: mocks.listSocialPosts,
}));
vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));

import { GET, POST } from './route';

const EVENT_ID = 'event-1';

function postRequest(body: unknown) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/social-posts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer token',
    },
    body: JSON.stringify(body),
  });
}

function callPost(body: unknown) {
  return POST(postRequest(body), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

function getRequest() {
  return new Request(`http://localhost/api/events/${EVENT_ID}/social-posts`, {
    headers: { Authorization: 'Bearer token' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEventOwner.mockResolvedValue({
    uid: 'owner-1',
    event: { id: EVENT_ID },
  });
});

describe('POST /api/events/[eventId]/social-posts', () => {
  it('正常作成で post を返す', async () => {
    const created = {
      id: 'post-1',
      text: '今日のカレー',
      photoUrls: [],
      status: 'queued',
      createdAt: null,
      postedAt: null,
      postedUrl: null,
    };
    mocks.createSocialPost.mockResolvedValue(created);
    const response = await callPost({ text: '今日のカレー', photoUrls: [] });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, post: created });
    expect(mocks.createSocialPost).toHaveBeenCalledWith(
      { __db: true },
      EVENT_ID,
      { text: '今日のカレー', photoUrls: [] },
    );
  });

  it('本文が空なら 400 で、作成しない', async () => {
    const response = await callPost({ text: '  ' });
    expect(response.status).toBe(400);
    expect(mocks.createSocialPost).not.toHaveBeenCalled();
  });

  it('写真が5枚なら 400 で、作成しない', async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.com/${i}.jpg`);
    const response = await callPost({ text: 'x', photoUrls: urls });
    expect(response.status).toBe(400);
    expect(mocks.createSocialPost).not.toHaveBeenCalled();
  });

  it('所有者でなければガードの 403 をそのまま返し、作成しない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '権限がありません' }, { status: 403 }),
    });
    const response = await callPost({ text: 'x' });
    expect(response.status).toBe(403);
    expect(mocks.createSocialPost).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/[eventId]/social-posts', () => {
  it('所有者には投稿一覧を返す', async () => {
    mocks.listSocialPosts.mockResolvedValue([
      { id: 'post-1', status: 'queued' },
      { id: 'post-2', status: 'posted' },
    ]);
    const response = await GET(getRequest(), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.posts).toHaveLength(2);
  });

  it('所有者でなければ 403 で、一覧を出さない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '権限がありません' }, { status: 403 }),
    });
    const response = await GET(getRequest(), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(403);
    expect(mocks.listSocialPosts).not.toHaveBeenCalled();
  });
});
