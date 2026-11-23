// lib/member-demographics.ts
// 来場者登録時に任意で取得する年代・性別（統計と行動レポートの
// 年代別・性別 breakdown 用）。値はコードで保存し、表示文は
// lib/ui-text.ts の辞書で引く。
// 未取得（既存会員・未選択）は members レコード上で null になり、
// 集計側では「未回答」として扱う。明示的に「回答しない」を選んだ
// 場合はコード 'no-answer' が保存され、null とは区別できる。

export const AGE_BANDS = [
  'under-10',
  '10s',
  '20s',
  '30s',
  '40s',
  '50s',
  '60s',
  '70-plus',
  'no-answer',
] as const;

export type AgeBand = (typeof AGE_BANDS)[number];

export const GENDERS = ['male', 'female', 'other', 'no-answer'] as const;

export type Gender = (typeof GENDERS)[number];

export function isAgeBand(value: unknown): value is AgeBand {
  return typeof value === 'string' && (AGE_BANDS as readonly string[]).includes(value);
}

export function isGender(value: unknown): value is Gender {
  return typeof value === 'string' && (GENDERS as readonly string[]).includes(value);
}

/**
 * 外部入力（登録 API の body）を許可コードに寄せる。
 * 許可コード以外（未送信・不正値）は null を返し、呼び出し側で
 * 「送られなかった」扱いに倒す（言語の normalizeLocale と同じ作法）。
 */
export function normalizeAgeBand(value: unknown): AgeBand | null {
  return isAgeBand(value) ? value : null;
}

export function normalizeGender(value: unknown): Gender | null {
  return isGender(value) ? value : null;
}
