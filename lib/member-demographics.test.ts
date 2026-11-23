// lib/member-demographics.test.ts
import { describe, expect, it } from 'vitest';
import {
  AGE_BANDS,
  GENDERS,
  isAgeBand,
  isGender,
  normalizeAgeBand,
  normalizeGender,
} from './member-demographics';

describe('isAgeBand / normalizeAgeBand', () => {
  it('許可コードはすべてそのまま通す', () => {
    for (const band of AGE_BANDS) {
      expect(isAgeBand(band)).toBe(true);
      expect(normalizeAgeBand(band)).toBe(band);
    }
  });
  it('許可コード以外は null に倒す', () => {
    expect(normalizeAgeBand('20代')).toBeNull();
    expect(normalizeAgeBand('20')).toBeNull();
    expect(normalizeAgeBand('')).toBeNull();
    expect(normalizeAgeBand(undefined)).toBeNull();
    expect(normalizeAgeBand(null)).toBeNull();
    expect(normalizeAgeBand(20)).toBeNull();
    expect(normalizeAgeBand({})).toBeNull();
    expect(isAgeBand('20代')).toBe(false);
  });
});

describe('isGender / normalizeGender', () => {
  it('許可コードはすべてそのまま通す', () => {
    for (const gender of GENDERS) {
      expect(isGender(gender)).toBe(true);
      expect(normalizeGender(gender)).toBe(gender);
    }
  });
  it('許可コード以外は null に倒す', () => {
    expect(normalizeGender('男性')).toBeNull();
    expect(normalizeGender('')).toBeNull();
    expect(normalizeGender(undefined)).toBeNull();
    expect(normalizeGender(null)).toBeNull();
    expect(normalizeGender(1)).toBeNull();
    expect(isGender('男性')).toBe(false);
  });
});
