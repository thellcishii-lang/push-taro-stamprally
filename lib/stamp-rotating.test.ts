// lib/stamp-rotating.test.ts
// 回転QRのコード（署名・ウィンドウ）と表示トークンの検証。
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import {
  ROTATING_WINDOW_SECONDS,
  buildRotatingCode,
  ensureExhibitorRotatingSecret,
  generateDisplayToken,
  hasExhibitorDisplayToken,
  hashDisplayToken,
  issueExhibitorDisplayToken,
  parseRotatingCode,
  readExhibitorRotatingSecret,
  rotatingWindowIndex,
  rotatingWindowRemainingSeconds,
  verifyExhibitorDisplayToken,
  verifyRotatingCode,
} from './stamp-rotating';

const SECRET = 'test-secret-key';
const EVENT_ID = 'event-1';
const EXHIBITOR_ID = 'cp-1';
// 2026-11-25T10:00:00Z
const NOW_MS = Date.UTC(2026, 10, 25, 10, 0, 0);
const WINDOW_MS = ROTATING_WINDOW_SECONDS * 1000;

describe('rotatingWindowIndex', () => {
  it('ウィンドウ秒で区切った番号を返す', () => {
    const w = rotatingWindowIndex(NOW_MS);
    expect(rotatingWindowIndex(NOW_MS + WINDOW_MS - 1)).toBe(w);
    expect(rotatingWindowIndex(NOW_MS + WINDOW_MS)).toBe(w + 1);
  });

  it('残り秒数は 1〜ウィンドウ秒 の範囲', () => {
    const remaining = rotatingWindowRemainingSeconds(NOW_MS);
    expect(remaining).toBeGreaterThanOrEqual(1);
    expect(remaining).toBeLessThanOrEqual(ROTATING_WINDOW_SECONDS);
  });
});

describe('回転コードの署名検証', () => {
  const window = rotatingWindowIndex(NOW_MS);
  const code = buildRotatingCode(SECRET, EVENT_ID, EXHIBITOR_ID, window);

  it('現在のウィンドウのコードは通る', () => {
    expect(verifyRotatingCode(SECRET, EVENT_ID, code, NOW_MS)).toEqual({
      exhibitorId: EXHIBITOR_ID,
    });
  });

  it('1つ前のウィンドウのコードも通る（読み取りの遅れを許容）', () => {
    expect(
      verifyRotatingCode(SECRET, EVENT_ID, code, NOW_MS + WINDOW_MS),
    ).toEqual({ exhibitorId: EXHIBITOR_ID });
  });

  it('2つ前のウィンドウになったコードは通らない', () => {
    expect(
      verifyRotatingCode(SECRET, EVENT_ID, code, NOW_MS + WINDOW_MS * 2),
    ).toBeNull();
  });

  it('署名を改ざんしたコードは通らない', () => {
    const tampered = code.slice(0, -2) + (code.endsWith('AA') ? 'BB' : 'AA');
    expect(verifyRotatingCode(SECRET, EVENT_ID, tampered, NOW_MS)).toBeNull();
  });

  it('別の秘密・別のイベントでは通らない', () => {
    expect(verifyRotatingCode('other-secret', EVENT_ID, code, NOW_MS)).toBeNull();
    expect(verifyRotatingCode(SECRET, 'event-2', code, NOW_MS)).toBeNull();
  });

  it('チェックポイントIDを書き換えたコードは通らない', () => {
    const forged = code.replace(EXHIBITOR_ID, 'cp-2');
    expect(verifyRotatingCode(SECRET, EVENT_ID, forged, NOW_MS)).toBeNull();
  });

  it('形式が違うものは通らない', () => {
    expect(verifyRotatingCode(SECRET, EVENT_ID, 'garbage', NOW_MS)).toBeNull();
    expect(verifyRotatingCode(SECRET, EVENT_ID, '', NOW_MS)).toBeNull();
    expect(verifyRotatingCode(SECRET, EVENT_ID, undefined, NOW_MS)).toBeNull();
    expect(verifyRotatingCode(SECRET, EVENT_ID, 123, NOW_MS)).toBeNull();
  });
});

describe('parseRotatingCode', () => {
  it('正常なコードを分解する', () => {
    const parsed = parseRotatingCode('cp-1.12345.signature');
    expect(parsed).toEqual({
      exhibitorId: 'cp-1',
      windowIndex: 12345,
      signature: 'signature',
    });
  });

  it('不正な形式は null', () => {
    expect(parseRotatingCode('cp-1.abc.signature')).toBeNull();
    expect(parseRotatingCode('cp-1.123')).toBeNull();
    expect(parseRotatingCode('.123.signature')).toBeNull();
    expect(parseRotatingCode(null)).toBeNull();
  });
});

// ─── フェイク Firestore（秘密・表示トークン用） ───

type DocData = Record<string, unknown>;

function createRotatingFakeDb() {
  const store = new Map<string, DocData>();

  function docRef(path: string): Record<string, unknown> {
    const id = path.split('/').pop()!;
    return {
      id,
      get: async () => {
        const data = store.get(path);
        return {
          exists: data !== undefined,
          id,
          data: () => (data ? { ...data } : undefined),
        };
      },
      update: async (data: DocData) => {
        const current = store.get(path);
        if (!current) throw new Error(`更新対象がありません: ${path}`);
        store.set(path, { ...current, ...data });
      },
      collection: (name: string) => collectionRef(`${path}/${name}`),
    };
  }

  function collectionRef(path: string): Record<string, unknown> {
    return {
      doc: (id: string) => docRef(`${path}/${id}`),
    };
  }

  const db = {
    collection: (name: string) => collectionRef(name),
  };
  return { db: db as unknown as Firestore, store };
}

const EXHIBITOR_PATH = `events/${EVENT_ID}/exhibitors/${EXHIBITOR_ID}`;

describe('回転QR用秘密', () => {
  it('無ければ生成して保存し、次回は同じ値を返す', async () => {
    const { db, store } = createRotatingFakeDb();
    store.set(EXHIBITOR_PATH, { name: 'スポット' });
    const first = await ensureExhibitorRotatingSecret(db, EVENT_ID, EXHIBITOR_ID);
    expect(first).toBeTruthy();
    expect(store.get(EXHIBITOR_PATH)?.rotatingSecret).toBe(first);
    const second = await ensureExhibitorRotatingSecret(db, EVENT_ID, EXHIBITOR_ID);
    expect(second).toBe(first);
    expect(await readExhibitorRotatingSecret(db, EVENT_ID, EXHIBITOR_ID)).toBe(first);
  });

  it('存在しないチェックポイントは null', async () => {
    const { db } = createRotatingFakeDb();
    expect(
      await ensureExhibitorRotatingSecret(db, EVENT_ID, 'missing'),
    ).toBeNull();
    expect(
      await readExhibitorRotatingSecret(db, EVENT_ID, 'missing'),
    ).toBeNull();
  });
});

describe('表示トークン', () => {
  it('トークンは32文字で、ハッシュは平文と異なる', () => {
    const token = generateDisplayToken();
    expect(token).toHaveLength(32);
    expect(hashDisplayToken(token)).not.toBe(token);
    expect(hashDisplayToken(token)).toBe(hashDisplayToken(token));
  });

  it('発行したトークンだけが通り、再発行で旧トークンは無効になる', async () => {
    const { db, store } = createRotatingFakeDb();
    store.set(EXHIBITOR_PATH, { name: 'スポット' });

    expect(await hasExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID)).toBe(false);
    const first = await issueExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID);
    expect(first).toBeTruthy();
    expect(await hasExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID)).toBe(true);
    expect(
      await verifyExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID, first),
    ).toBe(true);
    expect(
      await verifyExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID, 'wrong-token'),
    ).toBe(false);
    // 保存されているのはハッシュだけ（平文は残らない）
    expect(store.get(EXHIBITOR_PATH)?.displayTokenHash).toBe(
      hashDisplayToken(first!),
    );

    const second = await issueExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID);
    expect(second).not.toBe(first);
    expect(
      await verifyExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID, first),
    ).toBe(false);
    expect(
      await verifyExhibitorDisplayToken(db, EVENT_ID, EXHIBITOR_ID, second),
    ).toBe(true);
  });

  it('存在しないチェックポイントには発行できない', async () => {
    const { db } = createRotatingFakeDb();
    expect(await issueExhibitorDisplayToken(db, EVENT_ID, 'missing')).toBeNull();
    expect(
      await verifyExhibitorDisplayToken(db, EVENT_ID, 'missing', 'x'),
    ).toBe(false);
  });
});
