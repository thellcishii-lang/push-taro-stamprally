// lib/special-site.ts
/**
 * 本家（push-taro.com）上の特設サイトの URL。
 *
 * HONKE_BASE_URL は元々 lib/honke-handoff.ts に定義していたが、あちらは
 * node:crypto を import するサーバー専用モジュールのため、管理画面や
 * 来場者ページなどのクライアントコンポーネントからは import できない。
 * 定数はこのファイルに置き、honke-handoff.ts はここから import して
 * 再 export する（定義は1か所だけに保つ）。
 */

export const HONKE_BASE_URL = 'https://push-taro.com';

/** プロジェクトの特設サイト（トップ）の URL。 */
export function specialSiteUrl(eventId: string): string {
  return `${HONKE_BASE_URL}/stamprally/site/${encodeURIComponent(eventId)}`;
}

/** 特設サイト内の参加店ページの URL。 */
export function specialSiteShopUrl(eventId: string, exhibitorId: string): string {
  return `${specialSiteUrl(eventId)}/shop/${encodeURIComponent(exhibitorId)}`;
}
