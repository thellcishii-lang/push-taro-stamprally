// app/api/events/[eventId]/exhibitors/[exhibitorId]/route.test.ts
// チェックポイント設定 PATCH: 主催者ガードを通したうえで、入力を
// lib の updateExhibitorCheckpointSettings へ渡し、結果（成否・
// ステータス）をそのまま返すことを検証する。検証と保存の実体は
// lib 側（番号の重複チェック等）で担保される。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireEventOwner: vi.fn(),
  updateExhibitorCheckpointSettings: vi.fn(),
}));

vi.mock('@/lib/event-auth', () => ({
  requireEventOwner: mocks.requireEventOwner,
}));
vi.mock('@/lib/event-coupon', () => ({
  updateExhibitorCheckpointSettings: mocks.updateExhibitorCheckpointSettings,
}));

import { PATCH } from './route';

const EVENT_ID = 'event-1';
const EXHIBITOR_ID = 'cp-1';

function patchRequest(body: unknown) {
  return new Request(
    `http://localhost/api/events/${EVENT_ID}/exhibitors/${EXHIBITOR_ID}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function callPatch(body: unknown) {
  return PATCH(patchRequest(body), {
    params: Promise.resolve({ eventId: EVENT_ID, exhibitorId: EXHIBITOR_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireEventOwner.mockResolvedValue({
    uid: 'owner-1',
    event: { id: EVENT_ID },
  });
  mocks.updateExhibitorCheckpointSettings.mockResolvedValue({
    ok: true,
    exhibitor: { id: EXHIBITOR_ID, checkpointNumber: 3 },
  });
});

describe('PATCH /api/events/[eventId]/exhibitors/[exhibitorId]', () => {
  it('未認証（ガードの 401）をそのまま返し、更新しない', async () => {
    mocks.requireEventOwner.mockResolvedValue({
      error: NextResponse.json({ error: '認証が必要です' }, { status: 401 }),
    });
    const response = await callPatch({ checkpointNumber: 3 });
    expect(response.status).toBe(401);
    expect(mocks.updateExhibitorCheckpointSettings).not.toHaveBeenCalled();
  });

  it('設定項目を lib へ渡し、更新後のチェックポイントを返す', async () => {
    const response = await callPatch({
      checkpointNumber: 3,
      stampMethods: ['placed', 'rotating'],
      gpsCheck: true,
      velocityCheck: false,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.exhibitor.checkpointNumber).toBe(3);
    expect(mocks.updateExhibitorCheckpointSettings).toHaveBeenCalledWith(
      EVENT_ID,
      EXHIBITOR_ID,
      {
        checkpointNumber: 3,
        stampMethods: ['placed', 'rotating'],
        gpsCheck: true,
        velocityCheck: false,
      },
    );
  });

  it('番号のクリア（null）もそのまま渡す', async () => {
    const response = await callPatch({ checkpointNumber: null });
    expect(response.status).toBe(200);
    expect(mocks.updateExhibitorCheckpointSettings).toHaveBeenCalledWith(
      EVENT_ID,
      EXHIBITOR_ID,
      expect.objectContaining({ checkpointNumber: null }),
    );
  });

  it('lib のエラー（番号の重複 409）をそのまま返す', async () => {
    mocks.updateExhibitorCheckpointSettings.mockResolvedValue({
      ok: false,
      status: 409,
      error: '番号3は「別の店」で既に使われています',
    });
    const response = await callPatch({ checkpointNumber: 3 });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('既に使われています');
  });
});
