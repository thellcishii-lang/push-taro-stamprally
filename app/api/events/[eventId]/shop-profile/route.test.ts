// app/api/events/[eventId]/shop-profile/route.test.ts
// 店舗プロフィール API: 参加店ガードを通したうえで、自店分だけを
// 読み書きすることを検証する（検証の実体は lib/event-shop の純粋関数、
// 認可の実体は requireEventExhibitor）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventExhibitor: vi.fn(),
  getShopProfile: vi.fn(),
  updateShopProfile: vi.fn(),
}));

vi.mock('@/lib/event-auth', () => ({
  requireEventExhibitor: mocks.requireEventExhibitor,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: {} }));
vi.mock('@/lib/event-shop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/event-shop')>();
  return {
    ...actual,
    getShopProfile: mocks.getShopProfile,
    updateShopProfile: mocks.updateShopProfile,
  };
});

import { GET, PUT } from './route';

const EVENT_ID = 'event-1';
const EXHIBITOR = { id: 'shop-a', name: '店A' };

function putRequest(body: unknown) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/shop-profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function callGet() {
  return GET(new Request(`http://localhost/api/events/${EVENT_ID}/shop-profile`), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

function callPut(body: unknown) {
  return PUT(putRequest(body), {
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

describe('GET /api/events/[eventId]/shop-profile', () => {
  it('未認証（ガードの 401）をそのまま返し、読まない', async () => {
    mocks.requireEventExhibitor.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callGet();
    expect(response.status).toBe(401);
    expect(mocks.getShopProfile).not.toHaveBeenCalled();
  });

  it('自店プロフィールと店情報を返す', async () => {
    mocks.getShopProfile.mockResolvedValue({
      displayName: 'カレー堂',
      published: true,
    });
    const response = await callGet();
    expect(response.status).toBe(200);
    expect(mocks.getShopProfile).toHaveBeenCalledWith({}, EVENT_ID, 'shop-a');
    const body = await response.json();
    expect(body.profile.displayName).toBe('カレー堂');
    expect(body.exhibitor).toEqual({ id: 'shop-a', name: '店A' });
  });
});

describe('PUT /api/events/[eventId]/shop-profile', () => {
  it('正常な入力を検証して自店に保存する', async () => {
    mocks.updateShopProfile.mockImplementation(
      async (_db: unknown, _eventId: string, _exhibitorId: string, profile: unknown) => ({
        ok: true,
        profile,
      }),
    );
    const response = await callPut({
      displayName: ' カレー堂 ',
      address: '埼玉県飯能市…',
      photoUrls: ['https://example.com/a.jpg'],
      published: false,
    });
    expect(response.status).toBe(200);
    expect(mocks.updateShopProfile).toHaveBeenCalledWith(
      {},
      EVENT_ID,
      'shop-a',
      expect.objectContaining({
        displayName: 'カレー堂',
        published: false,
      }),
    );
    const body = await response.json();
    expect(body.profile.displayName).toBe('カレー堂');
  });

  it('リンクは検証・正規化して保存し、クライアントの座標は渡らない', async () => {
    mocks.updateShopProfile.mockImplementation(
      async (_db: unknown, _eventId: string, _exhibitorId: string, profile: unknown) => ({
        ok: true,
        profile,
      }),
    );
    const response = await callPut({
      displayName: 'カレー堂',
      links: [
        { label: ' 公式サイト ', url: ' https://example.com/ ' },
        { label: 'Instagram', url: 'https://instagram.com/shop' },
      ],
      // 座標はクライアントの値を一切使わない（サーバー側でのみ決める）
      location: { lat: 35.85, lng: 139.32 },
    });
    expect(response.status).toBe(200);
    expect(mocks.updateShopProfile).toHaveBeenCalledWith(
      {},
      EVENT_ID,
      'shop-a',
      expect.objectContaining({
        links: [
          { label: '公式サイト', url: 'https://example.com/' },
          { label: 'Instagram', url: 'https://instagram.com/shop' },
        ],
        location: null,
      }),
    );
    const body = await response.json();
    expect(body.profile.links).toHaveLength(2);
  });

  it('検証エラー（リンク4件）は 400 で、保存しない', async () => {
    const response = await callPut({
      links: [1, 2, 3, 4].map((i) => ({
        label: `リンク${i}`,
        url: `https://example.com/${i}`,
      })),
    });
    expect(response.status).toBe(400);
    expect(mocks.updateShopProfile).not.toHaveBeenCalled();
  });

  it('トップ画像は検証・正規化して保存する', async () => {
    mocks.updateShopProfile.mockImplementation(
      async (_db: unknown, _eventId: string, _exhibitorId: string, profile: unknown) => ({
        ok: true,
        profile,
      }),
    );
    const response = await callPut({
      displayName: 'カレー堂',
      coverImageUrl: ' https://example.com/cover.jpg ',
    });
    expect(response.status).toBe(200);
    expect(mocks.updateShopProfile).toHaveBeenCalledWith(
      {},
      EVENT_ID,
      'shop-a',
      expect.objectContaining({
        coverImageUrl: 'https://example.com/cover.jpg',
      }),
    );
    const body = await response.json();
    expect(body.profile.coverImageUrl).toBe('https://example.com/cover.jpg');
  });

  it('検証エラー（トップ画像が https でない）は 400 で、保存しない', async () => {
    const response = await callPut({
      coverImageUrl: 'http://example.com/cover.jpg',
    });
    expect(response.status).toBe(400);
    expect(mocks.updateShopProfile).not.toHaveBeenCalled();
  });

  it('検証エラー（写真4枚）は 400 で、保存しない', async () => {
    const response = await callPut({
      photoUrls: [
        'https://example.com/1.jpg',
        'https://example.com/2.jpg',
        'https://example.com/3.jpg',
        'https://example.com/4.jpg',
      ],
    });
    expect(response.status).toBe(400);
    expect(mocks.updateShopProfile).not.toHaveBeenCalled();
  });

  it('店が見つからない場合は lib の 404 をそのまま返す', async () => {
    mocks.updateShopProfile.mockResolvedValue({
      ok: false,
      status: 404,
      error: 'お店が見つかりません',
    });
    const response = await callPut({ displayName: 'x' });
    expect(response.status).toBe(404);
  });

  it('主催者（ガードの 403）は保存できない', async () => {
    mocks.requireEventExhibitor.mockResolvedValue({
      error: NextResponse.json(
        { error: 'この操作は参加店だけが行えます' },
        { status: 403 },
      ),
    });
    const response = await callPut({ displayName: 'x' });
    expect(response.status).toBe(403);
    expect(mocks.updateShopProfile).not.toHaveBeenCalled();
  });
});
