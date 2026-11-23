// lib/event-shop.ts
// Push-taro.スタンプラリー の店舗プロフィール基盤（events/{eventId} 配下）。
//
// - プロフィールは参加店ドキュメント（exhibitors/{exhibitorId}）の
//   `profile` フィールドに持つ。データは1つ: 店が店舗専用ページで
//   入れた情報が、特設サイトの店舗ページにもアプリの店舗表示にも
//   そのまま反映される（公開側は toPublicShop / listPublicShops を使う）。
// - 編集できるのは店本人だけ（API 側で参加店セッションを検証する）。
//   ここでは検証（純粋関数）と読み書きを担う。
// - 写真は API 経由で Admin SDK が Storage に保存する
//   （events/{eventId}/shop-photos/{exhibitorId}/...）。検証は
//   レビュー写真と同じ純粋関数（lib/event-review.ts）を使う。
import type { Firestore } from 'firebase-admin/firestore';
import {
  EVENT_EXHIBITORS_COLLECTION,
  parseExhibitorKind,
} from './event-coupon';
import { isHttpsUrl, parseTopPlacementPrice } from './event';
import { geocodeAddress, type GeoPoint, type GeocodeFn } from './geocode';

export const SHOP_PROFILE_PHOTO_MAX_COUNT = 3;

/** 店舗リンクの最大件数（Instagram・公式サイトなど）。 */
export const SHOP_PROFILE_LINK_MAX_COUNT = 3;

export const SHOP_PROFILE_LINK_LIMITS = {
  label: 30,
  url: 500,
} as const;

export const SHOP_PROFILE_LIMITS = {
  displayName: 60,
  address: 120,
  phone: 30,
  hoursText: 120,
  menuName: 60,
  menuDescription: 300,
  description: 1000,
} as const;

export const SHOP_FREE_DISH_LIMITS = {
  name: 50,
  description: 200,
} as const;

export const SHOP_LOGIN_REWARD_LIMITS = {
  name: 50,
  description: 200,
} as const;

/**
 * スタンプ達成で無料になる自店の一品（特典の種類が「1軒無料」の
 * プロジェクトで意味を持つ）。店が店舗専用ページで登録し、特設サイトの
 * 店舗ページ等に写真付きで出す。未登録は null。
 */
export interface ShopFreeDish {
  name: string;
  description: string;
  photoUrl: string | null;
}

/**
 * ログインボーナスクーポンで貰える自店の特典。形は無料の一品と同じ
 * （名前・説明・写真）。店が店舗専用ページで登録し、特設サイトの
 * 「毎日ログインでお得をゲット！」ページ等に写真付きで出す。未登録は null。
 */
export type ShopLoginReward = ShopFreeDish;

/** 店舗リンク1件（表示名＋URL）。特設サイトの店舗ページに並べて表示する。 */
export interface ShopLink {
  label: string;
  url: string;
}

/**
 * 店舗の座標。住所から保存時にサーバー側で求める（lib/geocode.ts）。
 * 特設サイトの店舗マップ（ピン表示）に使う。求められなかった場合は null。
 * 店側から送られた値は使わない（保存 API でも無視する）。
 */
export type ShopLocation = GeoPoint;

export interface ShopProfile {
  /** 表示名。未設定なら登録名（参加店名）で表示する */
  displayName: string;
  address: string;
  phone: string;
  /** 営業時間の自由文（例: 11:00〜21:00（水曜定休）） */
  hoursText: string;
  /** 対象メニュー名（例: 飯能カレー） */
  menuName: string;
  menuDescription: string;
  /** お店の紹介文 */
  description: string;
  /**
   * お店のトップ画像（1枚）。お店のページの先頭に出る「お店の顔」の
   * 写真で、料理の写真（photoUrls）とは別に持つ。未設定は null。
   */
  coverImageUrl: string | null;
  /** 料理の写真（最大3枚） */
  photoUrls: string[];
  instagramUrl: string;
  /**
   * 店舗リンク（最大3件）。未設定なら空配列。公開時は、リンクが空で
   * instagramUrl がある場合に Instagram を暗黙の1件目として扱う
   * （toPublicShop / effectiveShopLinks を参照）。
   */
  links: ShopLink[];
  /** 住所から求めた座標。未取得・取得失敗は null */
  location: ShopLocation | null;
  /** 達成で無料になる自店の一品。未登録は null */
  freeDish: ShopFreeDish | null;
  /** ログインボーナスクーポンで貰える自店の特典。未登録は null */
  loginReward: ShopLoginReward | null;
  /** 掲載するかどうか。既定は掲載する（true） */
  published: boolean;
}

/** 公開用の店舗情報。表示名は解決済み（未設定なら登録名）。 */
export interface PublicShop {
  exhibitorId: string;
  /** 登録名（管理上の名前） */
  name: string;
  profile: ShopProfile;
  /**
   * 特設サイトのトップ掲載（先頭5枠）の対象かどうか（算出済みの真偽値。
   * 本家はこの値だけを見ればよい）。
   * - 料金が有料（> 0）: 参加店ドキュメントのトップレベル項目
   *   `topFeatured` が正（課金側 lib/event-placement.ts が掲載中と
   *   判断している間だけ立つ）。
   * - 料金が無料（= 0）: 店の参加表明 `placementOptIn` が正。
   * 未設定の旧ドキュメントは false。
   */
  topFeatured: boolean;
}

/**
 * トップ掲載の対象かどうかを決める（純粋関数）。
 * 有料の間は課金側が管理する topFeatured フラグだけを見て、参加表明は
 * 無視する。無料（料金 0）の間は参加表明だけを見て、課金フラグは
 * 無視する（料金の切り替えで過去の状態が混ざらないように）。
 */
export function resolveTopFeatured(input: {
  /** プロジェクトのトップ掲載料金。null（未設定）は有料扱い（従来動作） */
  topPlacementPrice: number | null;
  /** 課金側が管理する掲載フラグ（参加店ドキュメントの topFeatured） */
  topFeatured: unknown;
  /** 無料時の参加表明（参加店ドキュメントの placementOptIn） */
  placementOptIn: unknown;
}): boolean {
  if (input.topPlacementPrice === 0) {
    return input.placementOptIn === true;
  }
  return input.topFeatured === true;
}

export function emptyShopProfile(): ShopProfile {
  return {
    displayName: '',
    address: '',
    phone: '',
    hoursText: '',
    menuName: '',
    menuDescription: '',
    description: '',
    coverImageUrl: null,
    photoUrls: [],
    instagramUrl: '',
    links: [],
    location: null,
    freeDish: null,
    loginReward: null,
    published: true,
  };
}

// ─── 純粋関数: 読み取り整形 ───

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

/** 読み取り用: トップ画像。https の文字列なら採用し、それ以外は null。 */
function readCoverImageUrl(value: unknown): string | null {
  return typeof value === 'string' && isHttpsUrl(value) ? value : null;
}

function readPhotoUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((url): url is string => typeof url === 'string' && isHttpsUrl(url))
    .slice(0, SHOP_PROFILE_PHOTO_MAX_COUNT);
}

function readInstagramUrl(value: unknown): string {
  return typeof value === 'string' && isHttpsUrl(value) ? value : '';
}

/**
 * 読み取り用: 店舗リンク。不正な行は捨て、上限件数で切り、表示名は
 * 上限文字数に丸める（保存時は validateShopProfileInput で厳密に検証）。
 */
function readShopLinks(value: unknown): ShopLink[] {
  if (!Array.isArray(value)) return [];
  const links: ShopLink[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.label !== 'string' || typeof record.url !== 'string') {
      continue;
    }
    const label = record.label.trim().slice(0, SHOP_PROFILE_LINK_LIMITS.label);
    const url = record.url.trim();
    if (!label || !isHttpsUrl(url)) continue;
    links.push({ label, url });
    if (links.length >= SHOP_PROFILE_LINK_MAX_COUNT) break;
  }
  return links;
}

/**
 * 読み取り用: 無料の一品／ログインボーナス特典（同じ形）。
 * 名前が無いものは「未登録」として null に倒す（名前なしでは表示
 * できないため）。写真は https のときだけ採用する。
 */
function readDish(
  value: unknown,
  limits: { name: number; description: number },
): ShopFreeDish | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const name =
    typeof record.name === 'string'
      ? record.name.trim().slice(0, limits.name)
      : '';
  if (!name) return null;
  const description =
    typeof record.description === 'string'
      ? record.description.trim().slice(0, limits.description)
      : '';
  const photoUrl =
    typeof record.photoUrl === 'string' && isHttpsUrl(record.photoUrl)
      ? record.photoUrl
      : null;
  return { name, description, photoUrl };
}

function readFreeDish(value: unknown): ShopFreeDish | null {
  return readDish(value, SHOP_FREE_DISH_LIMITS);
}

function readLoginReward(value: unknown): ShopLoginReward | null {
  return readDish(value, SHOP_LOGIN_REWARD_LIMITS);
}

/** 読み取り用: 座標。数値の組で範囲内なら採用し、それ以外は null に倒す。 */
function readShopLocation(value: unknown): ShopLocation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const lat = record.lat;
  const lng = record.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

/**
 * 保存済みプロフィールを防御的に読む（読み取り用。throw しない）。
 * 項目が無い旧ドキュメントは空プロフィール（掲載あり・表示名は登録名
 * フォールバック）として扱う。
 */
export function parseShopProfile(value: unknown): ShopProfile {
  if (typeof value !== 'object' || value === null) return emptyShopProfile();
  const source = value as Record<string, unknown>;
  return {
    displayName: readString(source.displayName, SHOP_PROFILE_LIMITS.displayName),
    address: readString(source.address, SHOP_PROFILE_LIMITS.address),
    phone: readString(source.phone, SHOP_PROFILE_LIMITS.phone),
    hoursText: readString(source.hoursText, SHOP_PROFILE_LIMITS.hoursText),
    menuName: readString(source.menuName, SHOP_PROFILE_LIMITS.menuName),
    menuDescription: readString(
      source.menuDescription,
      SHOP_PROFILE_LIMITS.menuDescription,
    ),
    description: readString(source.description, SHOP_PROFILE_LIMITS.description),
    coverImageUrl: readCoverImageUrl(source.coverImageUrl),
    photoUrls: readPhotoUrls(source.photoUrls),
    instagramUrl: readInstagramUrl(source.instagramUrl),
    links: readShopLinks(source.links),
    location: readShopLocation(source.location),
    freeDish: readFreeDish(source.freeDish),
    loginReward: readLoginReward(source.loginReward),
    published: source.published !== false,
  };
}

/**
 * 公開表示用の実効リンク。
 * 店舗リンクが設定されていればそれを使い、空で Instagram URL だけが
 * ある場合は Instagram を暗黙の1件目として扱う（リンク機能より前に
 * 登録された店の Instagram が、特設サイトから消えないようにするため）。
 */
export function effectiveShopLinks(profile: ShopProfile): ShopLink[] {
  if (profile.links.length > 0) return profile.links;
  if (profile.instagramUrl) {
    return [{ label: 'Instagram', url: profile.instagramUrl }];
  }
  return [];
}

/**
 * 公開用に整形する（表示名が未設定なら登録名に倒す）。
 * リンクは実効リンク（店舗リンク優先、無ければ Instagram を暗黙の
 * 1件目）に差し替える。座標は保存済みのものをそのまま出す。
 */
export function toPublicShop(
  exhibitor: { id: string; name: string },
  rawProfile: unknown,
  topFeatured?: unknown,
): PublicShop {
  const profile = parseShopProfile(rawProfile);
  if (!profile.displayName) profile.displayName = exhibitor.name;
  profile.links = effectiveShopLinks(profile);
  return {
    exhibitorId: exhibitor.id,
    name: exhibitor.name,
    profile,
    topFeatured: topFeatured === true,
  };
}

/**
 * お店のメイン画像（表示用フォールバック・純粋関数）。
 * トップ画像があればそれを使い、無ければ料理の写真の1枚目で代用する。
 * どちらも無ければ null。お店カードや先頭のビジュアルはこちらを使い、
 * 料理の写真ギャラリーは photoUrls をそのまま出す。
 */
export function shopMainVisualUrl(
  profile: Pick<ShopProfile, 'coverImageUrl' | 'photoUrls'>,
): string | null {
  return profile.coverImageUrl ?? profile.photoUrls[0] ?? null;
}

// ─── 純粋関数: 書き込み検証 ───

export type ValidateShopProfileResult =
  | { ok: true; value: ShopProfile }
  | { ok: false; error: string };

function validateTextField(
  source: Record<string, unknown>,
  field: keyof typeof SHOP_PROFILE_LIMITS,
  label: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const raw = source[field];
  if (raw === undefined || raw === null) return { ok: true, value: '' };
  if (typeof raw !== 'string') {
    return { ok: false, error: `${label}の形式が不正です` };
  }
  const value = raw.trim();
  if (value.length > SHOP_PROFILE_LIMITS[field]) {
    return {
      ok: false,
      error: `${label}は${SHOP_PROFILE_LIMITS[field]}文字以内で入力してください`,
    };
  }
  return { ok: true, value };
}

/**
 * 保存時検証: 店舗リンク。
 * - 両方空の行は黙って捨てる（編集画面の空行をそのまま送れるように。
 *   追加事項と同じ方針）
 * - 片方だけ入力された行はエラー
 * - 表示名は最大30文字、URL は https のみ・最大500文字
 * - 実質の件数は最大 SHOP_PROFILE_LINK_MAX_COUNT 件
 */
function validateShopLinks(
  raw: unknown,
): { ok: true; value: ShopLink[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'リンクの形式が不正です' };
  }
  const links: ShopLink[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: 'リンクの形式が不正です' };
    }
    const record = item as Record<string, unknown>;
    const labelRaw = record.label === undefined ? '' : record.label;
    const urlRaw = record.url === undefined ? '' : record.url;
    if (typeof labelRaw !== 'string' || typeof urlRaw !== 'string') {
      return { ok: false, error: 'リンクの形式が不正です' };
    }
    const label = labelRaw.trim();
    const url = urlRaw.trim();
    if (!label && !url) continue;
    if (!label || !url) {
      return {
        ok: false,
        error: 'リンクの表示名とURLは両方入力してください',
      };
    }
    if (label.length > SHOP_PROFILE_LINK_LIMITS.label) {
      return {
        ok: false,
        error: `リンクの表示名は${SHOP_PROFILE_LINK_LIMITS.label}文字以内で入力してください`,
      };
    }
    if (url.length > SHOP_PROFILE_LINK_LIMITS.url) {
      return {
        ok: false,
        error: `リンクのURLは${SHOP_PROFILE_LINK_LIMITS.url}文字以内で入力してください`,
      };
    }
    if (!isHttpsUrl(url)) {
      return {
        ok: false,
        error: 'リンクのURLは https:// で始まる必要があります',
      };
    }
    links.push({ label, url });
  }
  if (links.length > SHOP_PROFILE_LINK_MAX_COUNT) {
    return {
      ok: false,
      error: `リンクは${SHOP_PROFILE_LINK_MAX_COUNT}件までです`,
    };
  }
  return { ok: true, value: links };
}

/**
 * 保存時検証: 無料の一品／ログインボーナス特典（同じ形・同じ規則）。
 * - 未指定・null・全項目が空なら未登録（null）
 * - 説明や写真だけあって名前が無いものはエラー（名前なしでは表示できない）
 * - 名前は最大50文字、説明は最大200文字、写真は https のみ
 * label はエラーメッセージに使う品目名（無料メニュー／ログインボーナス特典）。
 */
function validateDish(
  raw: unknown,
  limits: { name: number; description: number },
  label: string,
): { ok: true; value: ShopFreeDish | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object') {
    return { ok: false, error: `${label}の形式が不正です` };
  }
  const record = raw as Record<string, unknown>;
  const nameRaw = record.name === undefined ? '' : record.name;
  const descriptionRaw = record.description === undefined ? '' : record.description;
  const photoRaw = record.photoUrl === undefined ? null : record.photoUrl;
  if (typeof nameRaw !== 'string' || typeof descriptionRaw !== 'string') {
    return { ok: false, error: `${label}の形式が不正です` };
  }
  if (photoRaw !== null && typeof photoRaw !== 'string') {
    return { ok: false, error: `${label}の形式が不正です` };
  }
  const name = nameRaw.trim();
  const description = descriptionRaw.trim();
  const photoUrl = typeof photoRaw === 'string' ? photoRaw.trim() : null;
  if (!name && !description && !photoUrl) return { ok: true, value: null };
  if (!name) {
    return { ok: false, error: `${label}の名前を入力してください` };
  }
  if (name.length > limits.name) {
    return {
      ok: false,
      error: `${label}の名前は${limits.name}文字以内で入力してください`,
    };
  }
  if (description.length > limits.description) {
    return {
      ok: false,
      error: `${label}の説明は${limits.description}文字以内で入力してください`,
    };
  }
  if (photoUrl && !isHttpsUrl(photoUrl)) {
    return {
      ok: false,
      error: `${label}の写真は https:// で始まる必要があります`,
    };
  }
  return { ok: true, value: { name, description, photoUrl: photoUrl || null } };
}

function validateFreeDish(
  raw: unknown,
): { ok: true; value: ShopFreeDish | null } | { ok: false; error: string } {
  return validateDish(raw, SHOP_FREE_DISH_LIMITS, '無料メニュー');
}

function validateLoginReward(
  raw: unknown,
): { ok: true; value: ShopLoginReward | null } | { ok: false; error: string } {
  return validateDish(raw, SHOP_LOGIN_REWARD_LIMITS, 'ログインボーナス特典');
}

/**
 * 店舗プロフィールの保存入力を検証して正規化する（書き込み用）。
 * 文字項目は任意（空でよい）で上限文字数まで。トップ画像は1枚・https
 * のみ（空は可）。料理の写真は最大3枚・https のみ。Instagram URL は
 * https のみ（空は可）。リンクは最大3件。
 * published は真偽値のみ（未指定は掲載）。
 * 座標（location）は店側の入力を一切使わないため、ここでは常に null
 * を返し、実際の値は保存時にサーバー側で決める（updateShopProfile）。
 */
export function validateShopProfileInput(
  raw: unknown,
): ValidateShopProfileResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: 'リクエスト形式が不正です' };
  }
  const source = raw as Record<string, unknown>;

  const fields: Array<[keyof typeof SHOP_PROFILE_LIMITS, string]> = [
    ['displayName', '表示名'],
    ['address', '住所'],
    ['phone', '電話番号'],
    ['hoursText', '営業時間'],
    ['menuName', '対象メニュー名'],
    ['menuDescription', 'メニューの説明'],
    ['description', 'お店の紹介'],
  ];
  const texts = {} as Record<keyof typeof SHOP_PROFILE_LIMITS, string>;
  for (const [field, label] of fields) {
    const result = validateTextField(source, field, label);
    if (!result.ok) return result;
    texts[field] = result.value;
  }

  // トップ画像: 未指定・null・空文字は未設定（null）。それ以外は
  // https の文字列でなければならない（料理の写真と同じ規則）。
  let coverImageUrl: string | null = null;
  if (source.coverImageUrl !== undefined && source.coverImageUrl !== null) {
    if (typeof source.coverImageUrl !== 'string') {
      return { ok: false, error: 'トップ画像の形式が不正です' };
    }
    const trimmed = source.coverImageUrl.trim();
    if (trimmed) {
      if (!isHttpsUrl(trimmed)) {
        return {
          ok: false,
          error: 'トップ画像は https:// で始まる必要があります',
        };
      }
      coverImageUrl = trimmed;
    }
  }

  let photoUrls: string[] = [];
  if (source.photoUrls !== undefined) {
    if (!Array.isArray(source.photoUrls)) {
      return { ok: false, error: '写真の形式が不正です' };
    }
    if (source.photoUrls.length > SHOP_PROFILE_PHOTO_MAX_COUNT) {
      return {
        ok: false,
        error: `写真は${SHOP_PROFILE_PHOTO_MAX_COUNT}枚までです`,
      };
    }
    for (const url of source.photoUrls) {
      if (typeof url !== 'string' || !isHttpsUrl(url)) {
        return { ok: false, error: '写真の形式が不正です' };
      }
    }
    photoUrls = source.photoUrls as string[];
  }

  const instagramUrl =
    typeof source.instagramUrl === 'string' ? source.instagramUrl.trim() : '';
  if (instagramUrl && !isHttpsUrl(instagramUrl)) {
    return {
      ok: false,
      error: 'InstagramのURLは https:// で始まる必要があります',
    };
  }

  const links = validateShopLinks(source.links);
  if (!links.ok) return links;

  const freeDish = validateFreeDish(source.freeDish);
  if (!freeDish.ok) return freeDish;

  const loginReward = validateLoginReward(source.loginReward);
  if (!loginReward.ok) return loginReward;

  if (source.published !== undefined && typeof source.published !== 'boolean') {
    return { ok: false, error: '掲載設定の形式が不正です' };
  }

  return {
    ok: true,
    value: {
      ...texts,
      coverImageUrl,
      photoUrls,
      instagramUrl,
      links: links.value,
      // 座標はサーバー側でのみ決める（クライアントの値は無視する）
      location: null,
      freeDish: freeDish.value,
      loginReward: loginReward.value,
      published: source.published !== false,
    },
  };
}

/** 店舗写真の保存先パス。 */
export function shopPhotoStoragePath(
  eventId: string,
  exhibitorId: string,
  fileName: string,
): string {
  return `events/${eventId}/shop-photos/${exhibitorId}/${fileName}`;
}

/**
 * 無料の一品の写真の保存先パス。店舗写真と同じ公開読み取りルールの
 * 範囲に収まるよう、同じディレクトリに `free-dish-` 接頭辞で置く。
 */
export function shopFreeDishPhotoStoragePath(
  eventId: string,
  exhibitorId: string,
  fileName: string,
): string {
  return `events/${eventId}/shop-photos/${exhibitorId}/free-dish-${fileName}`;
}

/**
 * ログインボーナス特典の写真の保存先パス。無料の一品と同じ考え方で、
 * 同じディレクトリに `login-reward-` 接頭辞で置く。
 */
export function shopLoginRewardPhotoStoragePath(
  eventId: string,
  exhibitorId: string,
  fileName: string,
): string {
  return `events/${eventId}/shop-photos/${exhibitorId}/login-reward-${fileName}`;
}

/**
 * お店のトップ画像の保存先パス。店舗写真と同じディレクトリに
 * `cover-` 接頭辞で置く（無料の一品などと同じ作法）。
 */
export function shopCoverPhotoStoragePath(
  eventId: string,
  exhibitorId: string,
  fileName: string,
): string {
  return `events/${eventId}/shop-photos/${exhibitorId}/cover-${fileName}`;
}

// ─── 課金による掲載停止（店舗課金オプション） ───
//
// 参加店ドキュメントのトップレベル項目 `billingSuspended` で管理する。
// プロフィール（profile）の中には入れない: 店が店舗専用ページで
// プロフィールを保存すると profile は丸ごと置き換わるため、その際に
// 課金側の停止状態が消えたり、店自身が解除できたりしないようにする。
// 店自身の掲載 ON/OFF（profile.published）とは独立したフラグで、
// 公開判定は「掲載する設定 かつ 課金停止でない」こと。

/**
 * 公開一覧に載せるかどうか（純粋関数）。
 * billingSuspended が未設定（undefined）の旧ドキュメントは停止でない扱い。
 */
export function isShopPubliclyListed(
  profile: ShopProfile,
  billingSuspended: unknown,
): boolean {
  return profile.published && billingSuspended !== true;
}

// ─── Firestore 読み書き ───

function exhibitorRef(db: Firestore, eventId: string, exhibitorId: string) {
  return db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .doc(exhibitorId);
}

/** 自店プロフィールの読み取り（未設定なら空プロフィール）。 */
export async function getShopProfile(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<ShopProfile> {
  const snap = await exhibitorRef(db, eventId, exhibitorId).get();
  return parseShopProfile(snap.data()?.profile);
}

export type UpdateShopProfileResult =
  | { ok: true; profile: ShopProfile }
  | { ok: false; status: number; error: string };

/**
 * 保存時の座標を決める（純粋な判断＋ジオコーディング呼び出し）。
 * - 住所が空なら座標なし
 * - 住所が前回と同じで座標が既にあれば、それを使い回す（無駄な変換をしない）
 * - 住所が変わった／座標がまだ無い場合は住所から変換する
 * 変換に失敗しても例外にせず null を返す（保存自体は止めない）。
 */
export async function resolveShopLocation(
  previous: ShopProfile,
  next: ShopProfile,
  geocode: GeocodeFn = geocodeAddress,
): Promise<ShopLocation | null> {
  const address = next.address.trim();
  if (!address) return null;
  if (previous.address.trim() === address && previous.location) {
    return previous.location;
  }
  try {
    return await geocode(address);
  } catch {
    return null;
  }
}

/**
 * 自店プロフィールの保存（プロフィール全体を置き換える）。
 * 座標は入力値を使わず、保存済みプロフィールとの住所の差分を見て
 * サーバー側で決める（resolveShopLocation）。ジオコーディングの
 * 失敗で保存が失敗することはない。
 */
export async function updateShopProfile(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  profile: ShopProfile,
  geocode: GeocodeFn = geocodeAddress,
): Promise<UpdateShopProfileResult> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'お店が見つかりません' };
  }
  const previous = parseShopProfile(snap.data()?.profile);
  const location = await resolveShopLocation(previous, profile, geocode);
  const saved: ShopProfile = { ...profile, location };
  await ref.update({ profile: saved });
  return { ok: true, profile: saved };
}

/**
 * 公開用の店舗一覧（掲載中の店だけ）。
 * 「掲載する設定（profile.published）」かつ「課金停止でない
 * （billingSuspended）」店だけを返す。表示名の解決（未設定なら
 * 登録名）は toPublicShop で行う。
 */
export async function listPublicShops(
  db: Firestore,
  eventId: string,
): Promise<PublicShop[]> {
  // トップ掲載の対象判定は料金で切り替わる（有料=課金フラグ／無料=参加
  // 表明）ため、プロジェクトの料金を先に読む。読めなければ従来動作
  // （有料扱い）に倒す。
  const eventSnap = await db.collection('events').doc(eventId).get();
  const topPlacementPrice = parseTopPlacementPrice(
    eventSnap.data()?.topPlacementPrice,
  );
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .get();
  return snap.docs
    // 協賛（広告専用）アカウントは参加店の一覧には出さない
    .filter((doc) => parseExhibitorKind(doc.data().kind) === 'shop')
    .map((doc) => ({
      shop: toPublicShop(
        { id: doc.id, name: String(doc.data().name ?? '') },
        doc.data().profile,
        resolveTopFeatured({
          topPlacementPrice,
          topFeatured: doc.data().topFeatured,
          placementOptIn: doc.data().placementOptIn,
        }),
      ),
      billingSuspended: doc.data().billingSuspended,
    }))
    .filter(({ shop, billingSuspended }) =>
      isShopPubliclyListed(shop.profile, billingSuspended),
    )
    .map(({ shop }) => shop)
    .sort((a, b) => a.profile.displayName.localeCompare(b.profile.displayName, 'ja'));
}

/**
 * 課金で掲載停止中の参加店 ID の集合。
 * 公開クーポン一覧など、店舗一覧以外の公開側でも「掲載停止の店を
 * 出さない」判定を揃えるために使う（店舗一覧は listPublicShops 側で
 * 同じフラグを見ている）。
 */
export async function listBillingSuspendedExhibitorIds(
  db: Firestore,
  eventId: string,
): Promise<Set<string>> {
  const snap = await db
    .collection('events')
    .doc(eventId)
    .collection(EVENT_EXHIBITORS_COLLECTION)
    .where('billingSuspended', '==', true)
    .get();
  return new Set(snap.docs.map((doc) => doc.id));
}

/**
 * 課金による掲載停止フラグの付け替え（店舗課金オプションの Webhook
 * 処理から使う）。プロフィールには触れない。店が無ければ false。
 */
export async function setShopBillingSuspended(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  suspended: boolean,
): Promise<boolean> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ billingSuspended: suspended });
  return true;
}

/**
 * 掲載停止の日時（delistedAt）の付け替え（店舗課金の Webhook 処理から使う）。
 * billingSuspended と同じくプロフィールの外に持つ。
 * - 停止時（at = ISO文字列）: 既に日時が付いていれば最初の停止日時を
 *   維持する（3ヶ月の起算点が後ろにずれないように）。
 * - 復旧時（at = null）: 日時を取り除く。
 * 店が無ければ false。
 */
export async function setShopDelistedAt(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  at: string | null,
): Promise<boolean> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if (at === null) {
    if (snap.data()?.delistedAt) {
      await ref.update({ delistedAt: null });
    }
    return true;
  }
  if (!snap.data()?.delistedAt) {
    await ref.update({ delistedAt: at });
  }
  return true;
}

// ─── トップ掲載フラグ（トップ掲載課金） ───
//
// billingSuspended と同じ考え方で、参加店ドキュメントのトップレベル項目
// `topFeatured` で管理する（プロフィール保存で消えたり店が勝手に
// 付け替えたりできないように）。付け替えは課金側
// （lib/event-placement.ts の Webhook 処理・解約処理）だけが行う。

/**
 * トップ掲載フラグの付け替え。プロフィールには触れない。
 * 店が無ければ false。
 */
export async function setShopTopFeatured(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  featured: boolean,
): Promise<boolean> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ topFeatured: featured });
  return true;
}

// ─── トップ掲載の参加表明（料金が無料のとき用） ───
//
// 料金 0 の間は課金が発生しないため、掲載の意思は店自身の参加表明
// （参加店ドキュメントのトップレベル項目 `placementOptIn`）で持つ。
// topFeatured と同じくプロフィールの外に置き、プロフィール保存で
// 消えないようにする。付け替えは店舗ページの参加表明 API だけが行う
// （有料の間は resolveTopFeatured がこの値を無視する）。

/**
 * トップ掲載への参加表明の付け替え。プロフィールには触れない。
 * 店が無ければ false。
 */
export async function setShopPlacementOptIn(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
  optedIn: boolean,
): Promise<boolean> {
  const ref = exhibitorRef(db, eventId, exhibitorId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ placementOptIn: optedIn });
  return true;
}

/** 参加表明の現在値（未設定の旧ドキュメントは false）。 */
export async function getShopPlacementOptIn(
  db: Firestore,
  eventId: string,
  exhibitorId: string,
): Promise<boolean> {
  const snap = await exhibitorRef(db, eventId, exhibitorId).get();
  return snap.data()?.placementOptIn === true;
}
