// lib/theme-color.ts
// プロジェクトのテーマカラー（特設サイト設定の themeColor）から、
// お客さん向け画面（来場者ページ・消込画面・店舗ページ）のアクセント
// 色一式を導出する。考え方は特設サイト（本家）と同じで、基準色1色から
// 濃淡を作る。画面側は CSS カスタムプロパティ（--theme-*）経由で使う。
//
// themeColor が未設定・不正な場合は、現在のベージュ／茶系パレット
// （スタンプラリーの既定）をそのまま返すため、見た目は一切変わらない。
// 主催者コンソールは対象外（固定の茶系のまま）。
import { parseThemeColor } from './event-site';

export interface ThemePalette {
  /** 基準色（ボタン・ブランド・リンク） */
  accent: string;
  /** 基準色を暗くした色 */
  accentDark: string;
  /** 基準色を明るくした色（グラデーション・ハイライト） */
  accentBright: string;
  /** ページ背景の淡色 */
  pageBg: string;
  /** 淡い境界線 */
  border: string;
  /** ヒーロー帯グラデーションの始点（淡） */
  heroFrom: string;
  /** ヒーロー帯グラデーションの終点 */
  heroTo: string;
  /** カードグラデーションの始点（最淡） */
  cardFrom: string;
  /** カードグラデーションの終点 */
  cardTo: string;
}

/** テーマ未設定時の既定パレット（現在のベージュ／茶系そのもの）。 */
export const DEFAULT_THEME_PALETTE: ThemePalette = {
  accent: '#8B5E34',
  accentDark: '#75502C',
  accentBright: '#B07B45',
  pageBg: '#F7F1E5',
  border: '#E8DCC4',
  heroFrom: '#F1E4CB',
  heroTo: '#E7D3AC',
  cardFrom: '#FBF6EA',
  cardTo: '#F3E8D2',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** 2色を ratio（0〜1、target 側の重み）で混ぜる。 */
export function mixHex(hex: string, target: string, ratio: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(target);
  return rgbToHex(
    a.r + (b.r - a.r) * ratio,
    a.g + (b.g - a.g) * ratio,
    a.b + (b.b - a.b) * ratio,
  );
}

/**
 * テーマカラーから画面用パレットを導出する。
 * 未設定・不正な値なら既定パレットをそのまま返す。
 */
export function themePalette(
  themeColor: string | null | undefined,
): ThemePalette {
  const base = parseThemeColor(themeColor ?? null);
  if (!base) return DEFAULT_THEME_PALETTE;
  return {
    accent: base,
    accentDark: mixHex(base, '#000000', 0.18),
    accentBright: mixHex(base, '#ffffff', 0.28),
    pageBg: mixHex(base, '#ffffff', 0.93),
    border: mixHex(base, '#ffffff', 0.8),
    heroFrom: mixHex(base, '#ffffff', 0.84),
    heroTo: mixHex(base, '#ffffff', 0.7),
    cardFrom: mixHex(base, '#ffffff', 0.95),
    cardTo: mixHex(base, '#ffffff', 0.88),
  };
}

/**
 * 画面のルート要素に渡す CSS カスタムプロパティ一式。
 * React の style オブジェクトにそのまま広げて使う。
 */
export function themeCssVars(
  themeColor: string | null | undefined,
): Record<string, string> {
  const palette = themePalette(themeColor);
  return {
    '--theme-accent': palette.accent,
    '--theme-accent-dark': palette.accentDark,
    '--theme-accent-bright': palette.accentBright,
    '--theme-page-bg': palette.pageBg,
    '--theme-border': palette.border,
    '--theme-hero-from': palette.heroFrom,
    '--theme-hero-to': palette.heroTo,
    '--theme-card-from': palette.cardFrom,
    '--theme-card-to': palette.cardTo,
  };
}
