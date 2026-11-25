// lib/geo.ts
// 座標と距離の純粋関数（クライアント・サーバー共用）。
//
// スタンプラリーの写真対策で使う:
// - GPSエリアチェック: お客さんの端末がスポットから 50m 以内かを
//   端末内で判定する（座標そのものはサーバーに送らない）。
// - 移動速度チェック: サーバー側で2つのチェックポイント間の距離から
//   あり得ない速さを検出する。

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** GPSエリアチェックの半径（メートル）。主催者が選べる追加チェック用。 */
export const GPS_AREA_RADIUS_METERS = 50;

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 2地点間の距離（メートル）。haversine 式。 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 距離がGPSエリアチェックの範囲内かどうか。 */
export function isWithinGpsArea(distanceMeters: number): boolean {
  return distanceMeters <= GPS_AREA_RADIUS_METERS;
}
