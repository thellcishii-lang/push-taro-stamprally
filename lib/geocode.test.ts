// lib/geocode.test.ts
// 住所→座標変換（Nominatim）の検証。HTTP はモックを注入し、
// 成功・該当なし・HTTPエラー・例外・不正な応答のすべてで
// 「座標が取れるか null か」だけが決まることを確認する。
import { describe, expect, it, vi } from 'vitest';
import { geocodeAddress } from './geocode';

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
