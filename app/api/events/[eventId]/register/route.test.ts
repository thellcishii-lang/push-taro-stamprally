// app/api/events/[eventId]/register/route.test.ts
// 来場者登録 API の認証方式の分岐を検証する:
// - SMSオンの契約: 従来どおり電話番号をキーに登録する。
// - SMSオフ（既定）の契約: 匿名認証の uid（端末の識別子）をキーに登録し、
//   電話番号は使わない。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  getEvent: vi.fn(),
  getEventSmsAuthEnabled: vi.fn(),
  registerEventVisitor: vi.fn(),
  registerEventDeviceVisitor: vi.fn(),
}));

vi.mock('@/lib/firebase-admin', () => ({
  authAdmin: { verifyIdToken: mocks.verifyIdToken },
}));
vi.mock('@/lib/rate-limit', () => ({
  enforceRateLimit: vi.fn(async () => null),
}));
vi.mock('@/lib/event-store', () => ({
  getEvent: mocks.getEvent,
}));
vi.mock('@/lib/event-member-auth', () => ({
  getEventSmsAuthEnabled: mocks.getEventSmsAuthEnabled,
}));
vi.mock('@/lib/event-register', () => ({
  registerEventVisitor: mocks.registerEventVisitor,
  registerEventDeviceVisitor: mocks.registerEventDeviceVisitor,
}));

import { POST } from './route';

const EVENT_ID = 'event-1';
const PHONE = '+819012345678';
const DEVICE_UID = 'anon-uid-xyz';

function postRequest(token?: string, extraBody: Record<string, unknown> = {}) {
  return new Request(`http://localhost/api/events/${EVENT_ID}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ fcmToken: 'fcm-token-1', lang: 'ja', ...extraBody }),
  });
}

function callPost(token?: string, extraBody: Record<string, unknown> = {}) {
  return POST(postRequest(token, extraBody), {
    params: Promise.resolve({ eventId: EVENT_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEvent.mockResolvedValue({ id: EVENT_ID, ownerUid: 'owner-1' });
  mocks.registerEventVisitor.mockResolvedValue({ ok: true, memberId: 'phone-member' });
  mocks.registerEventDeviceVisitor.mockResolvedValue({
    ok: true,
    memberId: 'device-member',
  });
});

describe('POST /api/events/[eventId]/register', () => {
  it('プロジェクトが無ければ 404 で、登録しない', async () => {
    mocks.getEvent.mockResolvedValue(null);
    const response = await callPost('token');
    expect(response.status).toBe(404);
    expect(mocks.registerEventVisitor).not.toHaveBeenCalled();
    expect(mocks.registerEventDeviceVisitor).not.toHaveBeenCalled();
  });

  it('SMSオン: 電話番号をキーに従来どおり登録する', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(true);
    mocks.verifyIdToken.mockResolvedValue({ uid: 'u1', phone_number: PHONE });
    const response = await callPost('token');
    expect(response.status).toBe(201);
    expect(mocks.registerEventVisitor).toHaveBeenCalledWith(EVENT_ID, {
      phoneE164: PHONE,
      fcmToken: 'fcm-token-1',
      lang: 'ja',
    });
    expect(mocks.registerEventDeviceVisitor).not.toHaveBeenCalled();
    expect((await response.json()).memberId).toBe('phone-member');
  });

  it('SMSオン: 電話番号の無いトークンは 401（従来文言）', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(true);
    mocks.verifyIdToken.mockResolvedValue({ uid: DEVICE_UID });
    const response = await callPost('token');
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('電話番号認証が必要です');
    expect(mocks.registerEventVisitor).not.toHaveBeenCalled();
  });

  it('SMSオフ（既定）: 匿名認証の uid をキーに端末登録する', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(false);
    mocks.verifyIdToken.mockResolvedValue({ uid: DEVICE_UID });
    const response = await callPost('token');
    expect(response.status).toBe(201);
    expect(mocks.registerEventDeviceVisitor).toHaveBeenCalledWith(EVENT_ID, {
      deviceUid: DEVICE_UID,
      fcmToken: 'fcm-token-1',
      lang: 'ja',
    });
    expect(mocks.registerEventVisitor).not.toHaveBeenCalled();
    expect((await response.json()).memberId).toBe('device-member');
  });

  it('SMSオフ: 有効な年代・性別はそのまま登録処理へ渡す', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(false);
    mocks.verifyIdToken.mockResolvedValue({ uid: DEVICE_UID });
    const response = await callPost('token', { ageBand: '30s', gender: 'female' });
    expect(response.status).toBe(201);
    expect(mocks.registerEventDeviceVisitor).toHaveBeenCalledWith(EVENT_ID, {
      deviceUid: DEVICE_UID,
      fcmToken: 'fcm-token-1',
      lang: 'ja',
      ageBand: '30s',
      gender: 'female',
    });
  });

  it('SMSオン: 有効な年代・性別はそのまま登録処理へ渡す', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(true);
    mocks.verifyIdToken.mockResolvedValue({ uid: 'u1', phone_number: PHONE });
    const response = await callPost('token', { ageBand: '70-plus', gender: 'no-answer' });
    expect(response.status).toBe(201);
    expect(mocks.registerEventVisitor).toHaveBeenCalledWith(EVENT_ID, {
      phoneE164: PHONE,
      fcmToken: 'fcm-token-1',
      lang: 'ja',
      ageBand: '70-plus',
      gender: 'no-answer',
    });
  });

  it('不正な年代・性別は渡さない（未送信扱いに倒す）', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(false);
    mocks.verifyIdToken.mockResolvedValue({ uid: DEVICE_UID });
    const response = await callPost('token', { ageBand: '20代', gender: 42 });
    expect(response.status).toBe(201);
    expect(mocks.registerEventDeviceVisitor).toHaveBeenCalledWith(EVENT_ID, {
      deviceUid: DEVICE_UID,
      fcmToken: 'fcm-token-1',
      lang: 'ja',
    });
  });

  it('SMSオフ: トークンが無ければ 401（端末向け文言）', async () => {
    mocks.getEventSmsAuthEnabled.mockResolvedValue(false);
    const response = await callPost();
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('認証が必要です');
    expect(mocks.registerEventDeviceVisitor).not.toHaveBeenCalled();
  });
});
