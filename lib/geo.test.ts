// lib/geo.test.ts
// 座標・距離の純粋関数の検証。
import { describe, expect, it } from 'vitest';
import {
  GPS_AREA_RADIUS_METERS,
  haversineMeters,
  isWithinGpsArea,
} from './geo';

describe('haversineMeters', () => {
  it('同じ地点は 0m', () => {
    expect(haversineMeters({ lat: 35, lng: 138 }, { lat: 35, lng: 138 })).toBe(0);
  });

  it('緯度1度の距離は約111.2km', () => {
    const distance = haversineMeters(
      { lat: 35, lng: 138 },
      { lat: 36, lng: 138 },
    );
    expect(distance).toBeGreaterThan(111_000);
    expect(distance).toBeLessThan(111_400);
  });

  it('近い2地点の距離（約50m）', () => {
    // 緯度 0.00045 度 ≒ 50m
    const distance = haversineMeters(
      { lat: 35, lng: 138 },
      { lat: 35.00045, lng: 138 },
    );
    expect(distance).toBeGreaterThan(45);
    expect(distance).toBeLessThan(55);
  });
});

describe('isWithinGpsArea', () => {
  it('半径は50mで、境界を含む', () => {
    expect(GPS_AREA_RADIUS_METERS).toBe(50);
    expect(isWithinGpsArea(0)).toBe(true);
    expect(isWithinGpsArea(50)).toBe(true);
    expect(isWithinGpsArea(50.1)).toBe(false);
    expect(isWithinGpsArea(500)).toBe(false);
  });
});
