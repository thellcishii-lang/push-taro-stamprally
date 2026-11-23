// lib/stamp-qr.ts
// スタンプ・無料クーポン用 QR のペイロード（純粋関数のみ、クライアントからも使う）。
//
// お客さんの画面が QR を表示し、参加店の消込画面が読み取る。
// - スタンプ用: お客さん本人の識別（memberId）を持つ。店が読むとスタンプ付与。
// - 無料クーポン用: 達成で発行された無料クーポンの識別（freeCouponId）を持つ。
//   どの参加店でも使える。
// 従来のクーポン消込 QR は claimId の素の文字列で、JSON ではない。
// parseRedeemQrPayload は JSON でなければ従来の claimId として扱い、
// 消込画面が3種の QR を1つの入口で振り分けられるようにする。

export interface StampQrPayload {
  type: 'stamp';
  eventId: string;
  memberId: string;
}

export interface FreeCouponQrPayload {
  type: 'free';
  eventId: string;
  freeCouponId: string;
}

export type RedeemQrPayload =
  | StampQrPayload
  | FreeCouponQrPayload
  | { type: 'claim'; claimId: string };

// ─── 場所QR（チェックポイントに貼る QR）用のスタンプコード ───
//
// 参加店（チェックポイント）ごとに1つ持つ推測不能なコード。QR の飛び先は
// {アプリorigin}/e/{eventId}?stamp={stampCode} で、来場者が読むとその
// スポットのスタンプが付く。コードは参加店ドキュメントの stampCode
// フィールドが正で、再発行すると旧コードは即無効になる（照合は現在の
// 値との一致だけを見る）。

/** 読み間違えやすい文字（0/O、1/I/L）を除いた英数字（アクセスコードと同じ）。 */
export const STAMP_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const STAMP_CODE_LENGTH = 20;

function defaultRandomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * スタンプコードを生成する。アルファベット長で割り切れる範囲までの
 * バイトだけを使って偏りを無くす（リジェクションサンプリング、
 * アクセスコード生成と同じ作法）。乱数源はテスト用に差し替え可能。
 */
export function generateStampCode(
  randomBytes: (size: number) => Uint8Array = defaultRandomBytes,
): string {
  const alphabet = STAMP_CODE_ALPHABET;
  const limit = 256 - (256 % alphabet.length);
  let code = '';
  while (code.length < STAMP_CODE_LENGTH) {
    const bytes = randomBytes(STAMP_CODE_LENGTH - code.length + 8);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      code += alphabet[byte % alphabet.length];
      if (code.length >= STAMP_CODE_LENGTH) break;
    }
  }
  return code;
}

/** スタンプコードの形式検証（長さと使用文字）。照合前の入力チェック用。 */
export function isValidStampCode(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length !== STAMP_CODE_LENGTH) return false;
  for (const ch of value) {
    if (!STAMP_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** スタンプ用 QR の表示文字列（お客さんの来場者画面が出す）。 */
export function buildStampQrPayload(eventId: string, memberId: string): string {
  return JSON.stringify({ v: 1, type: 'stamp', eventId, memberId });
}

/** 無料クーポン用 QR の表示文字列（お客さんの来場者画面が出す）。 */
export function buildFreeCouponQrPayload(
  eventId: string,
  freeCouponId: string,
): string {
  return JSON.stringify({ v: 1, type: 'free', eventId, freeCouponId });
}

/**
 * 消込画面が読んだ文字列を振り分ける（純粋関数）。
 * - JSON で type が 'stamp' / 'free' のものはそれぞれのペイロード。
 * - それ以外の文字列（従来の claimId 等）は claim として扱う。
 * - 空文字列は null。
 */
export function parseRedeemQrPayload(text: string): RedeemQrPayload | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (
        parsed.type === 'stamp' &&
        typeof parsed.eventId === 'string' &&
        parsed.eventId &&
        typeof parsed.memberId === 'string' &&
        parsed.memberId
      ) {
        return {
          type: 'stamp',
          eventId: parsed.eventId,
          memberId: parsed.memberId,
        };
      }
      if (
        parsed.type === 'free' &&
        typeof parsed.eventId === 'string' &&
        parsed.eventId &&
        typeof parsed.freeCouponId === 'string' &&
        parsed.freeCouponId
      ) {
        return {
          type: 'free',
          eventId: parsed.eventId,
          freeCouponId: parsed.freeCouponId,
        };
      }
    } catch {
      // JSON として読めない文字列は従来どおり claimId として扱う
    }
  }
  return { type: 'claim', claimId: trimmed };
}
