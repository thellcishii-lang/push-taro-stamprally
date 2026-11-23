// app/api/events/[eventId]/reviews/route.test.ts
// レビュー投稿 API: 電話認証で本人を特定し、入力検証と lib の結果を
// ステータスに写すことを検証する（資格判定の実体は upsertReview 側、
// 入力検証の実体は parseReviewInput の単体テストで担保する）。
// GET は管理画面用一覧で、所有者ガードの結果をそのまま返す。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';
import { memberIdForPhone } from '@/lib/event-coupon';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  parseReviewInput: vi.fn(),
  upsertReview: vi.fn(),
  listReviewsForAdmin: vi.fn(),
  requireEventOwner: vi.fn(),
  getEvent: vi.fn(),
  findOrganizerByOwnerUid: vi.fn(),
}));

vi.mock('@/lib/firebase-admin', () => ({
  authAdmin: { verifyIdToken: mocks.verifyIdToken },
  db: { __db: true },
}));
vi.mock('@/lib/event-review', () => ({
  parseReviewInput: mocks.parseReviewInput,
  upsertReview: mocks.upsertReview,
  listReviewsForAdmin: mocks.listReviewsForAdmin,
}));
vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
// 本人特定は契約の認証方式で切り替わる（lib/event-member-auth.ts）。
// このテストは従来の電話認証パスを検証するため、SMSオンの契約に倒す。
vi.mock('@/lib/event-store', () => ({
  getEvent: mocks.getEvent,
}));
vi.mock('@/lib/organizers', () => ({
  findOrganizerByOwnerUid: mocks.findOrganizerByOwnerUid,
}));

import { GET, POST } from './route';

const EVENT_ID = 'event-1';
const PHONE = '+819012345678';
const MEMBER_ID = memberIdForPhone(PHONE);

const PARSED_VALUE = {
  exhibitorId: 'shop-a',
  stars: 5,
  categoryScores: [
    { label: '味', stars: 5 },
    { label: '接客', stars: 4 },
    { label: '雰囲気', stars: 4 },
    { label: '盛り付け', stars: 3 },
  ],
  text: 'おいしかった',
  nickname: '',
  photoUrls: [],
};

function postRequest(body: unknown, token?: string) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/reviews`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function callPost(body: unknown, token?: string) {
  return POST(postRequest(body, token), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyIdToken.mockResolvedValue({ phone_number: PHONE });
  mocks.parseReviewInput.mockReturnValue({ ok: true, value: PARSED_VALUE });
  mocks.getEvent.mockResolvedValue({ ownerUid: 'owner-1' });
  mocks.findOrganizerByOwnerUid.mockResolvedValue({ smsAuthEnabled: true });
});

describe('POST /api/events/[eventId]/reviews', () => {
  it('トークンが無ければ 401 で、投稿しない', async () => {
    const response = await callPost({ exhibitorId: 'shop-a' });
    expect(response.status).toBe(401);
    expect(mocks.upsertReview).not.toHaveBeenCalled();
  });

  it('電話番号のないトークンは 401', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'someone' });
    const response = await callPost({ exhibitorId: 'shop-a' }, 'token');
    expect(response.status).toBe(401);
    expect(mocks.upsertReview).not.toHaveBeenCalled();
  });

  it('スタンプ資格が無い客は 403（lib の結果をそのまま返す）', async () => {
    mocks.upsertReview.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'レビューは、そのお店のスタンプをもらった方だけが書けます',
    });
    const response = await callPost({ exhibitorId: 'shop-a' }, 'token');
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('スタンプをもらった方だけ');
    expect(mocks.upsertReview).toHaveBeenCalledWith(
      { __db: true },
      { eventId: EVENT_ID, memberId: MEMBER_ID, value: PARSED_VALUE },
    );
  });

  it('正常作成で reviewId と created=true を返す', async () => {
    mocks.upsertReview.mockResolvedValue({
      ok: true,
      reviewId: `${MEMBER_ID}_shop-a`,
      created: true,
    });
    const response = await callPost({ exhibitorId: 'shop-a' }, 'token');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      reviewId: `${MEMBER_ID}_shop-a`,
      created: true,
    });
  });

  it('再投稿は更新になり created=false を返す', async () => {
    mocks.upsertReview.mockResolvedValue({
      ok: true,
      reviewId: `${MEMBER_ID}_shop-a`,
      created: false,
    });
    const response = await callPost({ exhibitorId: 'shop-a' }, 'token');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created).toBe(false);
  });

  it('入力検証で落ちたら 400 で、投稿しない', async () => {
    mocks.parseReviewInput.mockReturnValue({
      ok: false,
      error: '総合評価は1〜5で入力してください',
    });
    const response = await callPost({ exhibitorId: 'shop-a', stars: 9 }, 'token');
    expect(response.status).toBe(400);
    expect(mocks.upsertReview).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/[eventId]/reviews（主催者用一覧）', () => {
  it('所有者には非表示を含む全件を返す', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      uid: 'owner-1',
      event: { id: EVENT_ID },
    });
    mocks.listReviewsForAdmin.mockResolvedValue([
      { id: 'r1', visible: true },
      { id: 'r2', visible: false },
    ]);
    const request = new Request(
      `http://localhost/api/events/${EVENT_ID}/reviews`,
      { headers: { Authorization: 'Bearer token' } },
    );
    const response = await GET(request, {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.reviews).toHaveLength(2);
  });

  it('所有者でなければガードの 403 をそのまま返し、一覧を出さない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '権限がありません' }, { status: 403 }),
    });
    const request = new Request(
      `http://localhost/api/events/${EVENT_ID}/reviews`,
      { headers: { Authorization: 'Bearer token' } },
    );
    const response = await GET(request, {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(403);
    expect(mocks.listReviewsForAdmin).not.toHaveBeenCalled();
  });
});
