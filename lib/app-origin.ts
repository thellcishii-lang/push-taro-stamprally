// lib/app-origin.ts
// アプリの公開 origin と、イベント配下の公開 URL の組み立て。
//
// もとは lib/exhibitor-access.ts（サーバー専用）にあったが、主催者コンソール
// （クライアント側）でも来場者ページ URL が必要になったため、サーバー専用
// コードを含まない共有 lib に切り出した。lib/exhibitor-access.ts は互換の
// ため APP_ORIGIN / resolveAppOrigin を re-export している。

import { APP_HOSTING_ORIGIN } from './variant-identity';

/**
 * 本番の App Hosting origin。値は lib/variant-identity.ts で
 * バックエンド ID とプロジェクト ID から組み立てる（ここに直書きしない）。
 * 将来の独自ドメイン化に備え、環境変数 NEXT_PUBLIC_APP_ORIGIN があれば
 * そちらを優先する（末尾のスラッシュは取り除く）。
 */
export const APP_ORIGIN = APP_HOSTING_ORIGIN;

export function resolveAppOrigin(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_ORIGIN?.trim();
  return (fromEnv || APP_ORIGIN).replace(/\/+$/, '');
}

/** 来場者ページ（登録・クーポン画面）の URL。主催者向け登録用 QR の飛び先。 */
export function eventVisitorUrl(eventId: string): string {
  return `${resolveAppOrigin()}/e/${encodeURIComponent(eventId)}`;
}

/**
 * 場所QR（チェックポイントに貼る QR）の飛び先 URL。来場者ページが
 * stamp パラメータを検出すると、そのスポットのスタンプ付与に進む。
 */
export function eventStampQrUrl(eventId: string, stampCode: string): string {
  return `${eventVisitorUrl(eventId)}?stamp=${encodeURIComponent(stampCode)}`;
}

/**
 * 回転QR（固定ディスプレイ）の飛び先 URL。来場者ページが rstamp
 * パラメータを検出すると、そのチェックポイントのスタンプ付与に進む。
 */
export function eventRotatingStampUrl(eventId: string, code: string): string {
  return `${eventVisitorUrl(eventId)}?rstamp=${encodeURIComponent(code)}`;
}

/**
 * 回転QRの表示専用ページの URL（表示リンク）。チェックポイントに固定
 * するタブレット等で開く。表示用トークンを含むため、リンク自体が鍵。
 */
export function checkpointDisplayUrl(
  eventId: string,
  exhibitorId: string,
  displayToken: string,
): string {
  return (
    `${resolveAppOrigin()}/e/${encodeURIComponent(eventId)}` +
    `/display/${encodeURIComponent(exhibitorId)}?dt=${encodeURIComponent(displayToken)}`
  );
}

/**
 * 参加店の自己登録ページの URL。どこからもリンクされていないため、
 * 主催者がこの URL を店へ直接渡して案内する（管理画面に表示する）。
 */
export function eventShopApplyUrl(eventId: string): string {
  return `${resolveAppOrigin()}/e/${encodeURIComponent(eventId)}/apply`;
}
