// lib/variant-identity.ts
// このバリアント（スタンプラリー）の同一性: Firebase プロジェクト ID と
// App Hosting バックエンド ID の唯一の定義場所。
//
// 背景: バリアントは互いのフォークで作るため、コピー元の公開 URL や
// プロジェクト ID がコードに残ると、来場者が別バリアントのアプリへ
// 飛んでしまう事故になる（初詣で実際に発生した）。公開 origin と
// 既定ストレージバケットはここから組み立て、lib/app-origin.ts と
// lib/storage-bucket.ts はここの値を参照するだけにする。
// 他バリアントの識別子が紛れ込んでいないかは
// lib/variant-identity.test.ts が常時検査する。

/** このバリアントの Firebase プロジェクト ID。 */
export const VARIANT_PROJECT_ID = 'push-taro-stamprally';

/**
 * App Hosting のバックエンド ID。プロジェクト ID とは別物で、
 * 公開 URL は `<backend>--<project>.asia-east1.hosted.app` の形になる。
 */
export const VARIANT_BACKEND_ID = 'push-taro-stamprally';

/** 本番の App Hosting origin（環境変数で上書きされる前の既定値）。 */
export const APP_HOSTING_ORIGIN = `https://${VARIANT_BACKEND_ID}--${VARIANT_PROJECT_ID}.asia-east1.hosted.app`;

/** このプロジェクトの既定 Cloud Storage バケット名。 */
export const DEFAULT_STORAGE_BUCKET_NAME = `${VARIANT_PROJECT_ID}.firebasestorage.app`;
