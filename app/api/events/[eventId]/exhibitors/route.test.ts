// app/api/events/[eventId]/exhibitors/route.test.ts
// 登録 POST が lib の mailSent（パスワードメールの送信成否）を捨てずに
// レスポンスへ返すことを検証する。画面側は mailSent=false のとき成功文と
// 別に警告を出すため、この受け渡しが要る。
// あわせて、店舗課金オプション ON の契約では登録住所が必須になる
// （サーバー側の強制）こと、OFF では従来どおり不要なことを検証する。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireEventOwner: vi.fn(),
  listExhibitors: vi.fn(),
  ensureExhibitorStampCode: vi.fn(),
  createExhibitor: vi.fn(),
  registerExhibitor: vi.fn(),
  findOrganizerByOwnerUid: vi.fn(),
  validateShopProfileInput: vi.fn(),
  updateShopProfile: vi.fn(),
}));

vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
vi.mock('@/lib/organizers', () => ({
  findOrganizerByOwnerUid: mocks.findOrganizerByOwnerUid,
}));
vi.mock('@/lib/firebase-admin', () => ({ db: {} }));
vi.mock('@/lib/event-coupon', () => ({
  listExhibitors: mocks.listExhibitors,
  ensureExhibitorStampCode: mocks.ensureExhibitorStampCode,
  createExhibitor: mocks.createExhibitor,
  // 実装と同じ規則（'advertiser' のみ協賛、'spot' のみスポット、
  // それ以外は参加店）
  parseExhibitorKind: (value: unknown) =>
    value === 'advertiser' ? 'advertiser' : value === 'spot' ? 'spot' : 'shop',
}));
vi.mock('@/lib/event-shop', () => ({
  validateShopProfileInput: mocks.validateShopProfileInput,
  updateShopProfile: mocks.updateShopProfile,
}));
vi.mock('@/lib/exhibitor-access', () => ({
  ExhibitorAccessError: class ExhibitorAccessError extends Error {
    status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  },
  registerExhibitor: mocks.registerExhibitor,
  // 実物と同じ意味の最小実装（検証の本体は lib 側の単体テストで担保）。
  parseRegistrationAddress: (raw: unknown, required: boolean) => {
    if (typeof raw !== 'string' || !raw.trim()) {
      return required
        ? { ok: false as const, error: '住所が必要です' }
        : { ok: true as const, value: '' };
    }
    const value = raw.trim();
    if (value.length > 120) {
      return { ok: false as const, error: '住所は120文字以内で入力してください' };
    }
    return { ok: true as const, value };
  },
}));

import { GET, POST } from './route';

const EVENT_ID = 'event-1';
const EMAIL = 'exhibitor@example.com';
const ADDRESS = '埼玉県飯能市1-2-3';

function postRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/exhibitors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest() {
  return new Request(`http://localhost/api/events/${EVENT_ID}/exhibitors`);
}

function billingOn() {
  mocks.findOrganizerByOwnerUid.mockResolvedValue({
    contractId: 'contract-1',
    billingOptionEnabled: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEventOwner.mockResolvedValue({
    uid: 'owner-1',
    event: { name: 'テストイベント', defaultLocale: 'ja' },
  });
  // 既定はオプション OFF（契約者レコード無し）。
  mocks.findOrganizerByOwnerUid.mockResolvedValue(null);
  mocks.listExhibitors.mockResolvedValue([
    { id: 'exh-1', name: 'テスト出店者', email: EMAIL, address: null, hasAccessCode: true, lang: 'ja' },
  ]);
  // 既定では遅延発行しても新しいコードは返らない（従来表示のまま）
  mocks.ensureExhibitorStampCode.mockResolvedValue(null);
  mocks.registerExhibitor.mockResolvedValue({
    exhibitorId: 'exh-1',
    email: EMAIL,
    mailSent: true,
  });
  mocks.createExhibitor.mockResolvedValue({
    id: 'spot-1',
    name: '展望台',
    email: null,
    address: null,
    hasAccessCode: false,
    lang: 'ja',
    kind: 'spot',
    source: 'admin',
    delistedAt: null,
    closedAt: null,
    stampCode: 'ABCDEFGHJKMNPQRSTUVW',
    checkpointNumber: null,
    stampMethods: ['placed'],
    gpsCheck: false,
    velocityCheck: false,
  });
  // プロフィール検証は、住所と説明だけを拾う最小の形で再現する。
  mocks.validateShopProfileInput.mockImplementation(
    (raw: Record<string, unknown>) => ({
      ok: true,
      value: {
        address: typeof raw.address === 'string' ? raw.address : '',
        description: typeof raw.description === 'string' ? raw.description : '',
      },
    }),
  );
  mocks.updateShopProfile.mockResolvedValue({ ok: true, profile: {} });
});

describe('POST /api/events/[eventId]/exhibitors', () => {
  it('メール送信成功時は mailSent=true を返す', async () => {
    mocks.registerExhibitor.mockResolvedValue({
      exhibitorId: 'exh-1',
      email: EMAIL,
      mailSent: true,
    });
    const response = await POST(postRequest({ name: 'テスト出店者', email: EMAIL }), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.mailSent).toBe(true);
    expect(body.exhibitor.id).toBe('exh-1');
    // コード自体はレスポンスに含めない。
    expect(body).not.toHaveProperty('accessCode');
    expect(body.exhibitor).not.toHaveProperty('accessCode');
  });

  it('メール送信失敗でも登録は 201 で成立し、mailSent=false を返す', async () => {
    mocks.registerExhibitor.mockResolvedValue({
      exhibitorId: 'exh-1',
      email: EMAIL,
      mailSent: false,
    });
    const response = await POST(postRequest({ name: 'テスト出店者', email: EMAIL }), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.mailSent).toBe(false);
    expect(body.exhibitor.id).toBe('exh-1');
  });

  it('オプション OFF では住所が無くても登録できる（住所は渡さない）', async () => {
    const response = await POST(postRequest({ name: 'テスト出店者', email: EMAIL }), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(201);
    const arg = mocks.registerExhibitor.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty('address');
  });

  it('オプション ON では住所が無いと 400 で、登録しない', async () => {
    billingOn();
    const response = await POST(postRequest({ name: 'テスト出店者', email: EMAIL }), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('住所');
    expect(mocks.registerExhibitor).not.toHaveBeenCalled();
  });

  it('オプション ON では空文字の住所も 400', async () => {
    billingOn();
    const response = await POST(
      postRequest({ name: 'テスト出店者', email: EMAIL, address: '  ' }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.registerExhibitor).not.toHaveBeenCalled();
  });

  it('オプション ON で住所があれば登録し、住所を lib へ渡す', async () => {
    billingOn();
    const response = await POST(
      postRequest({ name: 'テスト出店者', email: EMAIL, address: ADDRESS }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    expect(response.status).toBe(201);
    expect(mocks.registerExhibitor).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS }),
    );
  });

  it('スポットはメールなしで登録でき、アクセスコード発行を通らない', async () => {
    const response = await POST(
      postRequest({
        name: '展望台',
        kind: 'spot',
        address: ADDRESS,
        description: '街が見渡せる展望台',
      }),
      { params: Promise.resolve({ eventId: EVENT_ID }) },
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.exhibitor.kind).toBe('spot');
    expect(body.exhibitor.email).toBeNull();
    // アクセスコード＋メール送信の経路は通らない
    expect(mocks.registerExhibitor).not.toHaveBeenCalled();
    expect(mocks.createExhibitor).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ name: '展望台', kind: 'spot' }),
    );
    // 説明・住所は公開プロフィールとして保存される
    expect(mocks.updateShopProfile).toHaveBeenCalledWith(
      expect.anything(),
      EVENT_ID,
      'spot-1',
      expect.objectContaining({
        address: ADDRESS,
        description: '街が見渡せる展望台',
      }),
    );
  });
});

describe('GET /api/events/[eventId]/exhibitors', () => {
  it('オプション OFF では billingAddressRequired=false', async () => {
    const response = await GET(getRequest(), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.billingAddressRequired).toBe(false);
    expect(body.exhibitors).toHaveLength(1);
  });

  it('オプション ON では billingAddressRequired=true', async () => {
    billingOn();
    const response = await GET(getRequest(), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.billingAddressRequired).toBe(true);
  });

  it('スタンプコードが無い参加店には表示時に遅延発行して返す', async () => {
    mocks.ensureExhibitorStampCode.mockResolvedValue('ABCDEFGHJKMNPQRSTUVW');
    const response = await GET(getRequest(), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.ensureExhibitorStampCode).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ id: 'exh-1' }),
    );
    expect(body.exhibitors[0].stampCode).toBe('ABCDEFGHJKMNPQRSTUVW');
  });

  it('スタンプコードがある参加店には遅延発行しない', async () => {
    mocks.listExhibitors.mockResolvedValue([
      {
        id: 'exh-1',
        name: 'テスト出店者',
        email: EMAIL,
        address: null,
        hasAccessCode: true,
        lang: 'ja',
        stampCode: 'ABCDEFGHJKMNPQRSTUVW',
      },
    ]);
    const response = await GET(getRequest(), {
      params: Promise.resolve({ eventId: EVENT_ID }),
    });
    expect(response.status).toBe(200);
    expect(mocks.ensureExhibitorStampCode).not.toHaveBeenCalled();
  });
});
