// lib/stamp-qr.test.ts
// QR ペイロードの生成と、消込画面側の振り分け（パース）。
import { describe, expect, it } from 'vitest';
import {
  STAMP_CODE_ALPHABET,
  STAMP_CODE_LENGTH,
  buildFreeCouponQrPayload,
  buildStampQrPayload,
  generateStampCode,
  isValidStampCode,
  parseRedeemQrPayload,
} from './stamp-qr';

describe('build / parse の往復', () => {
  it('スタンプ用ペイロードを往復できる', () => {
    const text = buildStampQrPayload('event-1', 'member-a');
    expect(parseRedeemQrPayload(text)).toEqual({
      type: 'stamp',
      eventId: 'event-1',
      memberId: 'member-a',
    });
  });
  it('無料クーポン用ペイロードを往復できる', () => {
    const text = buildFreeCouponQrPayload('event-1', 'free-1');
    expect(parseRedeemQrPayload(text)).toEqual({
      type: 'free',
      eventId: 'event-1',
      freeCouponId: 'free-1',
    });
  });
});

describe('parseRedeemQrPayload', () => {
  it('JSON でない文字列は従来の claimId として扱う', () => {
    expect(parseRedeemQrPayload('member-a_coupon-1')).toEqual({
      type: 'claim',
      claimId: 'member-a_coupon-1',
    });
  });
  it('壊れた JSON は claimId として扱う', () => {
    expect(parseRedeemQrPayload('{not json')).toEqual({
      type: 'claim',
      claimId: '{not json',
    });
  });
  it('必須項目が欠けた JSON は claimId として扱う', () => {
    expect(parseRedeemQrPayload('{"v":1,"type":"stamp"}')).toEqual({
      type: 'claim',
      claimId: '{"v":1,"type":"stamp"}',
    });
  });
  it('空文字列は null', () => {
    expect(parseRedeemQrPayload('')).toBeNull();
    expect(parseRedeemQrPayload('   ')).toBeNull();
  });
});

describe('generateStampCode / isValidStampCode（場所QR用コード）', () => {
  it('決まった長さで、使用文字だけのコードを生成する', () => {
    const code = generateStampCode();
    expect(code).toHaveLength(STAMP_CODE_LENGTH);
    expect(STAMP_CODE_LENGTH).toBeGreaterThanOrEqual(16);
    for (const ch of code) {
      expect(STAMP_CODE_ALPHABET).toContain(ch);
    }
    expect(isValidStampCode(code)).toBe(true);
  });

  it('生成のたびに異なるコードになる', () => {
    const codes = new Set(
      Array.from({ length: 50 }, () => generateStampCode()),
    );
    expect(codes.size).toBe(50);
  });

  it('乱数源を差し替えると決定的に生成できる（リジェクションサンプリング）', () => {
    // 255 は limit 以上なので捨てられ、次のバイトから作られる
    let first = true;
    const code = generateStampCode((size) => {
      if (first) {
        first = false;
        return new Uint8Array([255, ...new Array(size - 1).fill(0)]);
      }
      return new Uint8Array(size).fill(0);
    });
    expect(code).toBe(STAMP_CODE_ALPHABET[0].repeat(STAMP_CODE_LENGTH));
  });

  it('形式が違うものは無効', () => {
    expect(isValidStampCode('ABC')).toBe(false); // 短い
    expect(isValidStampCode('A'.repeat(STAMP_CODE_LENGTH + 1))).toBe(false); // 長い
    expect(isValidStampCode('0'.repeat(STAMP_CODE_LENGTH))).toBe(false); // 使用外の文字（0）
    expect(isValidStampCode('O'.repeat(STAMP_CODE_LENGTH))).toBe(false); // 使用外の文字（O）
    expect(isValidStampCode(null)).toBe(false);
    expect(isValidStampCode(undefined)).toBe(false);
    expect(isValidStampCode(123)).toBe(false);
  });
});
