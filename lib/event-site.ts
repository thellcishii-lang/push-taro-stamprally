// lib/event-site.ts
// 特設サイト（本家 push-taro.com 上の公開ページ）の表示内容のモデル。
// プロジェクトドキュメント（events/{eventId}）のトップレベル項目として持つ:
// - siteDescription: ヒーローに表示する紹介文（最大300字）
// - gourmetDefinition: ご当地グルメの定義（その土地のカレー等のルール・
//   素材・スタイル。最大1000字、改行可）
// - heroImageUrl: ヒーロー画像の公開URL（未設定は null）
// - siteIconUrl: ヘッダーに表示する正方形アイコンの公開URL（未設定は null）
// - themeColor: 特設サイトのテーマカラー（#RRGGBB。未設定は null で、
//   表示側の既定色になる）
// - siteNotes: 追加事項（タイトル＋本文の組、最大5件）
// ここは純粋な検証・正規化のみ。Firestore への読み書きは
// lib/event-store.ts と API ルート側で行う。
// 検証方針は主催者リンク（lib/event.ts の normalizeEventLinks）と揃える:
// 保存時は厳密に検証して例外を投げ、読み取り時は寛容に既定値へ倒す
// （導入前に作られたプロジェクトには項目自体が無いため）。

/** 追加事項1件。タイトルと本文は原文のまま表示する（自動翻訳しない）。 */
export interface SiteNote {
  title: string;
  body: string;
}

/** 特設サイトの表示内容一式（API の受け渡しとドキュメント保存の形）。 */
export interface SiteSettings {
  siteDescription: string;
  /**
   * ご当地グルメの定義（例: 飯能カレーと呼べる条件・素材・スタイル）。
   * 主催者が書き、特設サイトに表示する。未設定は空文字。改行を含む。
   */
  gourmetDefinition: string;
  heroImageUrl: string | null;
  /** ヘッダーに表示する正方形のプロジェクトアイコン。未設定は null */
  siteIconUrl: string | null;
  /**
   * 特設サイトのテーマカラー（#rrggbb 小文字に正規化）。
   * 未設定は null で、表示側（本家）はサイト既定の色を使う。
   */
  themeColor: string | null;
  siteNotes: SiteNote[];
}

export const MAX_SITE_DESCRIPTION_LENGTH = 300;
export const MAX_GOURMET_DEFINITION_LENGTH = 1000;
export const MAX_SITE_NOTES = 5;
export const MAX_SITE_NOTE_TITLE_LENGTH = 50;
export const MAX_SITE_NOTE_BODY_LENGTH = 500;

function isHttpsUrl(value: string): boolean {
  return value.startsWith('https://');
}

/** 保存時検証: 紹介文。未指定は空文字、空白のみも空文字に倒す。 */
export function normalizeSiteDescription(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') throw new Error('紹介文の形式が不正です');
  const text = input.trim();
  if (text.length > MAX_SITE_DESCRIPTION_LENGTH) {
    throw new Error(`紹介文は${MAX_SITE_DESCRIPTION_LENGTH}文字までです`);
  }
  return text;
}

/** 読み取り用: 紹介文。文字列でなければ空文字に倒す。 */
export function parseSiteDescription(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_SITE_DESCRIPTION_LENGTH);
}

/**
 * 保存時検証: ご当地グルメの定義。未指定は空文字、空白のみも空文字に
 * 倒す。改行は本文として保持し、前後の空白だけ落とす。
 */
export function normalizeGourmetDefinition(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new Error('ご当地グルメの定義の形式が不正です');
  }
  const text = input.trim();
  if (text.length > MAX_GOURMET_DEFINITION_LENGTH) {
    throw new Error(
      `ご当地グルメの定義は${MAX_GOURMET_DEFINITION_LENGTH}文字までです`,
    );
  }
  return text;
}

/** 読み取り用: ご当地グルメの定義。文字列でなければ空文字に倒す。 */
export function parseGourmetDefinition(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_GOURMET_DEFINITION_LENGTH);
}

/** 保存時検証: 画像URL（ヒーロー画像・アイコン共通）。未指定・空は null。 */
function normalizeImageUrl(input: unknown, label: string): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new Error(`${label}の形式が不正です`);
  }
  const url = input.trim();
  if (!url) return null;
  if (!isHttpsUrl(url)) {
    throw new Error(`${label}は https:// で始まる必要があります`);
  }
  return url;
}

/** 読み取り用: 画像URL。https の文字列でなければ null に倒す。 */
function parseImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  return url && isHttpsUrl(url) ? url : null;
}

/** 保存時検証: ヒーロー画像URL。未指定・空は null（未設定）。 */
export function normalizeHeroImageUrl(input: unknown): string | null {
  return normalizeImageUrl(input, 'ヒーロー画像URL');
}

/** 読み取り用: ヒーロー画像URL。https の文字列でなければ null に倒す。 */
export function parseHeroImageUrl(value: unknown): string | null {
  return parseImageUrl(value);
}

const THEME_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * 保存時検証: テーマカラー。未指定・空は null（サイト既定）。
 * #RRGGBB 形式のみを受け付け、小文字に正規化する。
 */
export function normalizeThemeColor(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') {
    throw new Error('テーマカラーの形式が不正です');
  }
  const value = input.trim();
  if (!value) return null;
  if (!THEME_COLOR_PATTERN.test(value)) {
    throw new Error('テーマカラーは #RRGGBB の形式で指定してください');
  }
  return value.toLowerCase();
}

/** 読み取り用: テーマカラー。#RRGGBB 形式でなければ null に倒す。 */
export function parseThemeColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return THEME_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/** 保存時検証: アイコン画像URL。未指定・空は null（未設定）。 */
export function normalizeSiteIconUrl(input: unknown): string | null {
  return normalizeImageUrl(input, 'アイコン画像URL');
}

/** 読み取り用: アイコン画像URL。https の文字列でなければ null に倒す。 */
export function parseSiteIconUrl(value: unknown): string | null {
  return parseImageUrl(value);
}

function readNoteFields(
  item: unknown,
): { title: string; body: string } | null {
  if (typeof item !== 'object' || item === null) return null;
  const record = item as Record<string, unknown>;
  const title = record.title === undefined ? '' : record.title;
  const body = record.body === undefined ? '' : record.body;
  if (typeof title !== 'string' || typeof body !== 'string') return null;
  return { title: title.trim(), body: body.trim() };
}

/**
 * 保存時検証: 追加事項。
 * - 両方空の行は黙って捨てる（編集画面の空行をそのまま送れるように）
 * - 片方だけ入力された行はエラー（中途半端な表示を防ぐ）
 * - 実質の件数は最大 MAX_SITE_NOTES 件
 */
export function normalizeSiteNotes(input: unknown): SiteNote[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('追加事項の形式が不正です');
  const notes: SiteNote[] = [];
  for (const item of input) {
    const fields = readNoteFields(item);
    if (!fields) throw new Error('追加事項の形式が不正です');
    if (!fields.title && !fields.body) continue;
    if (!fields.title || !fields.body) {
      throw new Error('追加事項のタイトルと本文は両方入力してください');
    }
    if (fields.title.length > MAX_SITE_NOTE_TITLE_LENGTH) {
      throw new Error(
        `追加事項のタイトルは${MAX_SITE_NOTE_TITLE_LENGTH}文字までです`,
      );
    }
    if (fields.body.length > MAX_SITE_NOTE_BODY_LENGTH) {
      throw new Error(
        `追加事項の本文は${MAX_SITE_NOTE_BODY_LENGTH}文字までです`,
      );
    }
    notes.push(fields);
  }
  if (notes.length > MAX_SITE_NOTES) {
    throw new Error(`追加事項は最大${MAX_SITE_NOTES}件までです`);
  }
  return notes;
}

/** 読み取り用: 追加事項。不正な行は捨て、上限で切り、長さも丸める。 */
export function parseSiteNotes(value: unknown): SiteNote[] {
  if (!Array.isArray(value)) return [];
  const notes: SiteNote[] = [];
  for (const item of value) {
    const fields = readNoteFields(item);
    if (fields && fields.title && fields.body) {
      notes.push({
        title: fields.title.slice(0, MAX_SITE_NOTE_TITLE_LENGTH),
        body: fields.body.slice(0, MAX_SITE_NOTE_BODY_LENGTH),
      });
      if (notes.length >= MAX_SITE_NOTES) break;
    }
  }
  return notes;
}

/** ドキュメント等から特設サイト表示内容を寛容に読み取る。 */
export function parseSiteSettings(
  source: Record<string, unknown> | null | undefined,
): SiteSettings {
  return {
    siteDescription: parseSiteDescription(source?.siteDescription),
    gourmetDefinition: parseGourmetDefinition(source?.gourmetDefinition),
    heroImageUrl: parseHeroImageUrl(source?.heroImageUrl),
    siteIconUrl: parseSiteIconUrl(source?.siteIconUrl),
    themeColor: parseThemeColor(source?.themeColor),
    siteNotes: parseSiteNotes(source?.siteNotes),
  };
}

/** ヒーロー画像の保存先パス（レビュー写真・店舗写真と同じ配置）。 */
export function siteImageStoragePath(eventId: string, fileName: string): string {
  return `events/${eventId}/site-images/${fileName}`;
}
