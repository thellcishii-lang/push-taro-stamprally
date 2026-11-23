// lib/geocode.ts
// 住所 → 座標（緯度・経度）の変換。特設サイトの店舗マップ（ピン表示）に
// 使う座標を、店舗プロフィール保存時にサーバー側で求めるためのモジュール。
//
// - 変換には OpenStreetMap の Nominatim 検索 API を使う（APIキー不要）。
//   利用ポリシーに従い、アプリを識別する User-Agent を必ず付ける。
// - 変換は「できれば付ける」付加情報であり、失敗しても呼び出し側の処理
//   （プロフィール保存）を絶対に止めない。そのためこのモジュールは
//   例外を投げず、失敗・該当なし・不正な応答はすべて null を返す。
// - HTTP 呼び出しは引数で差し替え可能（テストではモックを渡す）。

/** 座標（緯度・経度）。店舗プロフィールの profile.location の形。 */
export interface GeoPoint {
  lat: number;
  lng: number;
}

/** 住所から座標を引く関数の形（差し替え・モック用）。 */
export type GeocodeFn = (address: string) => Promise<GeoPoint | null>;

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
// Nominatim の利用ポリシーで必須とされる、アプリ識別用の User-Agent。
const NOMINATIM_USER_AGENT =
  'PushTaroStamprally/1.0 (shop map geocoding; contact: info@push-taro.com)';
const GEOCODE_TIMEOUT_MS = 5000;

function isValidPoint(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * 住所を座標に変換する。変換できない場合は null（例外は投げない）。
 * Nominatim は lat / lon を文字列で返すため数値化して検証する。
 */
export async function geocodeAddress(
  address: string,
  fetchFn: typeof fetch = fetch,
): Promise<GeoPoint | null> {
  const query = typeof address === 'string' ? address.trim() : '';
  if (!query) return null;
  const url =
    `${NOMINATIM_SEARCH_URL}?format=json&limit=1&q=` +
    encodeURIComponent(query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      headers: {
        'User-Agent': NOMINATIM_USER_AGENT,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as { lat?: unknown; lon?: unknown } | null;
    if (typeof first !== 'object' || first === null) return null;
    const lat = Number(first.lat);
    const lng = Number(first.lon);
    if (!isValidPoint(lat, lng)) return null;
    return { lat, lng };
  } catch {
    // タイムアウト・ネットワークエラー・JSON 不正はすべて「座標なし」
    return null;
  } finally {
    clearTimeout(timer);
  }
}
