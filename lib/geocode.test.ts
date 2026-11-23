// lib/geocode.test.ts
// 住所→座標変換（Nominatim）の検証。HTTP はモックを注入し、
// 成功・該当なし・HTTPエラー・例外・不正な応答のすべてで
// 「座標が取れるか null か」だけが決まることを確認する。
import { describe, expect, it, vi } from 'vitest';
import { geocodeAddress, haversineMeters, parseGeoPoint } from './geocode';

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return vi.fn(async () => ({
    ok,
    json: async () => body,
  })) as unknown as typeof fetch;
}

describe('geocodeAddress', () => {
  it('最初の候補の lat/lon を数値化して返す', async () => {
    const fetchFn = fetchReturning([
      { lat: '35.8544', lon: '139.3211', display_name: '埼玉県飯能市' },
    ]);
    await expect(geocodeAddress('埼玉県飯能市', fetchFn)).resolves.toEqual({
      lat: 35.8544,
      lng: 139.3211,
    });
  });

  it('Nominatim の検索URLと識別用 User-Agent で呼ぶ', async () => {
    const fetchFn = fetchReturning([]);
    await geocodeAddress('埼玉県飯能市 本町1-1', fetchFn);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toContain('https://nominatim.openstreetmap.org/search');
    expect(url).toContain('format=json');
    expect(url).toContain(encodeURIComponent('埼玉県飯能市 本町1-1'));
    expect(init.headers['User-Agent']).toContain('PushTaroStamprally');
  });

  it('該当なし（空配列）は null', async () => {
    await expect(
      geocodeAddress('存在しない住所', fetchReturning([])),
    ).resolves.toBeNull();
  });

  it('HTTP エラーは null', async () => {
    await expect(
      geocodeAddress('埼玉県飯能市', fetchReturning({}, false)),
    ).resolves.toBeNull();
  });

  it('fetch が例外を投げても null（呼び出し側を止めない）', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(geocodeAddress('埼玉県飯能市', fetchFn)).resolves.toBeNull();
  });

  it('座標として不正な応答は null', async () => {
    await expect(
      geocodeAddress('x', fetchReturning([{ lat: 'abc', lon: '139.0' }])),
    ).resolves.toBeNull();
    await expect(
      geocodeAddress('x', fetchReturning([{ lat: '123.0', lon: '139.0' }])),
    ).resolves.toBeNull();
    await expect(
      geocodeAddress('x', fetchReturning({ results: [] })),
    ).resolves.toBeNull();
  });

  it('空の住所は fetch を呼ばずに null', async () => {
    const fetchFn = fetchReturning([{ lat: '35.0', lon: '139.0' }]);
    await expect(geocodeAddress('   ', fetchFn)).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('haversineMeters', () => {
  it('同じ点同士は 0m', () => {
    const p = { lat: 35.6812, lng: 139.7671 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it('緯度1度は約111km', () => {
    const d = haversineMeters({ lat: 35, lng: 139 }, { lat: 36, lng: 139 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });

  it('東京駅〜新宿駅は約6〜7km', () => {
    const d = haversineMeters(
      { lat: 35.6812, lng: 139.7671 },
      { lat: 35.6896, lng: 139.7006 },
    );
    expect(d).toBeGreaterThan(6_000);
    expect(d).toBeLessThan(7_000);
  });

  it('近い2点（約100m）も妥当に測れる', () => {
    // 緯度 0.0009 度 ≒ 100m
    const d = haversineMeters(
      { lat: 35.8544, lng: 139.3211 },
      { lat: 35.8553, lng: 139.3211 },
    );
    expect(d).toBeGreaterThan(90);
    expect(d).toBeLessThan(110);
  });
});

describe('parseGeoPoint', () => {
  it('数値の組なら座標として読む', () => {
    expect(parseGeoPoint({ lat: 35.85, lng: 139.32 })).toEqual({
      lat: 35.85,
      lng: 139.32,
    });
  });
  it('範囲外・文字列・欠けは null', () => {
    expect(parseGeoPoint({ lat: 91, lng: 139 })).toBeNull();
    expect(parseGeoPoint({ lat: 35, lng: 181 })).toBeNull();
    expect(parseGeoPoint({ lat: '35.85', lng: 139.32 })).toBeNull();
    expect(parseGeoPoint({ lat: 35.85 })).toBeNull();
    expect(parseGeoPoint(null)).toBeNull();
    expect(parseGeoPoint(undefined)).toBeNull();
    expect(parseGeoPoint('35.85,139.32')).toBeNull();
  });
});
