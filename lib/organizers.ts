// 契約者（主催者）レコードの読み書き層（Admin SDK）。
//
// データ配置:
// - organizers/{contractId}: 契約者情報。ドキュメントID = 本家の契約ID（冪等キー）
// - 連携APIキーは lib/api-keys.ts、連携ログは provisioningLogs（本ファイル末尾）
import { FieldValue } from 'firebase-admin/firestore';
import { db } from './firebase-admin';
import { DEFAULT_SUBSCRIBER_CAP, MAX_COUPONS_PER_EVENT } from './event';

const ORGANIZERS_COLLECTION = 'organizers';
const PROVISIONING_LOGS_COLLECTION = 'provisioningLogs';

export type OrganizerStatus = 'active' | 'suspended';

export interface Organizer {
  /** 本家の契約ID（ドキュメントID） */
  contractId: string;
  /** ログインID（メールアドレス） */
  email: string;
  companyName: string;
  address: string;
  phone: string;
  /** 紐づく Firebase Auth ユーザーの uid。未作成なら null */
  ownerUid: string | null;
  /**
   * 初回ログイン時のパスワード変更が必須かどうか。
   * プロビジョニングでの新規作成時のみ true になる。
   * 旧レコード（フィールド自体が無い）は false 扱い。
   */
  mustChangePassword: boolean;
  status: OrganizerStatus;
  /** 使用開始日（決済完了日, 'YYYY-MM-DD'） */
  startDate: string;
  /** 契約枠（運営が決める。イベント作成時の既定値になる） */
  subscriberCap: number;
  couponCap: number;
  /**
   * 一時的な枠上げの期限（'YYYY-MM-DD'）。本家が「この月だけ上げる」を
   * 送ってきたときだけ入る。警告バナー（復帰時の枠超過）の材料。未設定は null。
   */
  tempSubscriberCapUntil: string | null;
  /**
   * 一時上げの期限後に戻る購読者枠。警告バナーの判定材料。未設定は null。
   */
  restoredSubscriberCap: number | null;
  /** 代理店コード（保持のみ。集計は本家側） */
  agencyCode: string | null;
  /**
   * 店舗課金オプション（別料金）が有効かどうか。既定は無効（false）。
   * 有効な契約でのみ、店舗課金の画面・API・掲載停止ロジックが動く。
   * 設定はプロビジョニング（本家接続）または運営側の変更で行う。
   * 旧レコード（フィールド自体が無い）は false 扱い。
   */
  billingOptionEnabled: boolean;
  /**
   * 広告オプション（別料金）が有効かどうか。既定は無効（false）。
   * 有効な契約でのみ、特設サイト広告（設定・申請・承認・掲載）が動く。
   * 設定はプロビジョニング（本家接続）または運営側の変更で行う。
   * 旧レコード（フィールド自体が無い）は false 扱い。
   */
  adsOptionEnabled: boolean;
  /**
   * ポータル（特設サイト本契約）が有効かどうか。既定は無効（false）。
   * 有効な契約ではクーポン・特典の管理がポータル側に寄り、アプリ側は
   * グレーアウトする（管理場所は常に1か所）。イベント側の
   * portalEnabled へ作成時継承・更新時伝播する。
   * 旧レコード（フィールド自体が無い）は false 扱い。
   */
  portalEnabled: boolean;
  /**
   * 世界観の名前（例: 飯能カレー）。申込時に本家から送られてくる希望名で、
   * プロジェクト作成フォームのプロジェクト名の初期値に使う。
   * 旧レコード（フィールド自体が無い）は '' 扱い。
   */
  worldName: string;
  /**
   * お客さんの登録に SMS 電話認証を使うかどうか（データのみの切替スイッチ。
   * 画面のトグルは無い）。既定は false = 端末認証（匿名認証の uid を
   * 本人キーにする）。true の契約だけが従来の SMS 電話登録になり、
   * SMSカード残高（smsBalance）のゲートと消費報告もその契約だけに効く。
   * 設定はプロビジョニング（本家接続）または運営側のデータ変更で行う。
   * 旧レコード（フィールド自体が無い）は false 扱い。
   */
  smsAuthEnabled: boolean;
  /**
   * SMSカード残高のアプリ側ミラー（保有件数）。台帳の実体は本家
   * （shops.smsBalance）で、プロビジョニングで絶対値が送られてきたら
   * 上書きする（未報告の消費分は差し引いて取り込む。lib/sms-mirror.ts）。
   * SMS 送信のたびにローカルで1件ずつ減らし、新規登録のゲートに使う。
   * 旧レコード（フィールド自体が無い）は 0 扱い。
   */
  smsBalance: number;
  /**
   * 本家へまだ報告していない SMS 消費件数（ローカル消費の累計）。
   * tick のバッチ報告（lib/sms-mirror.ts）が本家へ送って冪等に差し引かれ、
   * 確認できた分だけここから減る。旧レコードは 0 扱い。
   */
  smsPendingCount: number;
  createdAt: string;
  updatedAt: string;
}

function toOrganizer(id: string, data: FirebaseFirestore.DocumentData): Organizer {
  return {
    contractId: id,
    email: String(data.email ?? ''),
    companyName: String(data.companyName ?? ''),
    address: String(data.address ?? ''),
    phone: String(data.phone ?? ''),
    ownerUid: (data.ownerUid as string | null) ?? null,
    mustChangePassword: data.mustChangePassword === true,
    status: data.status === 'suspended' ? 'suspended' : 'active',
    startDate: String(data.startDate ?? ''),
    subscriberCap:
      typeof data.subscriberCap === 'number' ? data.subscriberCap : DEFAULT_SUBSCRIBER_CAP,
    couponCap: typeof data.couponCap === 'number' ? data.couponCap : MAX_COUPONS_PER_EVENT,
    tempSubscriberCapUntil:
      typeof data.tempSubscriberCapUntil === 'string' ? data.tempSubscriberCapUntil : null,
    restoredSubscriberCap:
      typeof data.restoredSubscriberCap === 'number' ? data.restoredSubscriberCap : null,
    agencyCode: (data.agencyCode as string | null) ?? null,
    billingOptionEnabled: data.billingOptionEnabled === true,
    adsOptionEnabled: data.adsOptionEnabled === true,
    portalEnabled: data.portalEnabled === true,
    worldName: typeof data.worldName === 'string' ? data.worldName : '',
    smsAuthEnabled: data.smsAuthEnabled === true,
    smsBalance:
      typeof data.smsBalance === 'number' && Number.isFinite(data.smsBalance) && data.smsBalance > 0
        ? Math.floor(data.smsBalance)
        : 0,
    smsPendingCount:
      typeof data.smsPendingCount === 'number' &&
      Number.isFinite(data.smsPendingCount) &&
      data.smsPendingCount > 0
        ? Math.floor(data.smsPendingCount)
        : 0,
    createdAt: data.createdAt?.toDate?.().toISOString() ?? '',
    updatedAt: data.updatedAt?.toDate?.().toISOString() ?? '',
  };
}

/** イベントに実際に効く枠（契約枠が無ければ既定値）。 */
export interface EffectiveCaps {
  subscriberCap: number;
  couponCap: number;
}

/**
 * イベント作成時に使う枠の解決（純粋関数）。
 * 契約者レコードがあればその契約枠、無ければ既定値
 * （購読者 DEFAULT_SUBSCRIBER_CAP / クーポン MAX_COUPONS_PER_EVENT）。
 */
export function resolveEffectiveCaps(
  organizer: Pick<Organizer, 'subscriberCap' | 'couponCap'> | null,
): EffectiveCaps {
  return {
    subscriberCap: organizer?.subscriberCap ?? DEFAULT_SUBSCRIBER_CAP,
    couponCap: organizer?.couponCap ?? MAX_COUPONS_PER_EVENT,
  };
}

export async function getOrganizer(contractId: string): Promise<Organizer | null> {
  const snap = await db.collection(ORGANIZERS_COLLECTION).doc(contractId).get();
  if (!snap.exists) return null;
  return toOrganizer(snap.id, snap.data()!);
}

/** ログイン中ユーザーの契約者レコードを ownerUid から引く。無ければ null。 */
export async function findOrganizerByOwnerUid(ownerUid: string): Promise<Organizer | null> {
  const snap = await db
    .collection(ORGANIZERS_COLLECTION)
    .where('ownerUid', '==', ownerUid)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return toOrganizer(doc.id, doc.data());
}

/**
 * パスワード変更ゲートの判定（純粋関数）。
 * 契約者レコードがあり mustChangePassword が立っている場合のみブロックする。
 * レコードが無いユーザー（運営アカウント等）はブロックしない。
 */
export function shouldBlockForPasswordChange(
  organizer: Pick<Organizer, 'mustChangePassword'> | null,
): boolean {
  return organizer?.mustChangePassword === true;
}

export async function listOrganizers(): Promise<Organizer[]> {
  const snap = await db
    .collection(ORGANIZERS_COLLECTION)
    .orderBy('createdAt', 'desc')
    .get();
  return snap.docs.map((doc) => toOrganizer(doc.id, doc.data()));
}

/** 契約枠と状態の運営側変更。存在しなければ false。 */
export async function updateOrganizer(
  contractId: string,
  patch: {
    subscriberCap?: number;
    couponCap?: number;
    status?: OrganizerStatus;
    billingOptionEnabled?: boolean;
    adsOptionEnabled?: boolean;
    portalEnabled?: boolean;
  },
): Promise<boolean> {
  const ref = db.collection(ORGANIZERS_COLLECTION).doc(contractId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  return true;
}

export interface CreateOrganizerData {
  email: string;
  companyName: string;
  address: string;
  phone: string;
  ownerUid: string;
  startDate: string;
  subscriberCap?: number;
  couponCap?: number;
  tempSubscriberCapUntil?: string | null;
  restoredSubscriberCap?: number | null;
  agencyCode?: string | null;
  billingOptionEnabled?: boolean;
  adsOptionEnabled?: boolean;
  /** ポータル（特設サイト本契約）が有効か。未指定は false */
  portalEnabled?: boolean;
  worldName?: string;
  /** SMS認証を使うか。未指定は false（端末認証） */
  smsAuthEnabled?: boolean;
  /** SMSカード残高ミラーの初期値（本家からの絶対値）。未指定は 0 */
  smsBalance?: number;
  mustChangePassword?: boolean;
}

export async function createOrganizerRecord(
  contractId: string,
  data: CreateOrganizerData,
): Promise<void> {
  await db
    .collection(ORGANIZERS_COLLECTION)
    .doc(contractId)
    .set({
      email: data.email,
      companyName: data.companyName,
      address: data.address,
      phone: data.phone,
      ownerUid: data.ownerUid,
      mustChangePassword: data.mustChangePassword ?? false,
      status: 'active' as OrganizerStatus,
      startDate: data.startDate,
      subscriberCap: data.subscriberCap ?? DEFAULT_SUBSCRIBER_CAP,
      couponCap: data.couponCap ?? MAX_COUPONS_PER_EVENT,
      tempSubscriberCapUntil: data.tempSubscriberCapUntil ?? null,
      restoredSubscriberCap: data.restoredSubscriberCap ?? null,
      agencyCode: data.agencyCode ?? null,
      billingOptionEnabled: data.billingOptionEnabled ?? false,
      adsOptionEnabled: data.adsOptionEnabled ?? false,
      portalEnabled: data.portalEnabled ?? false,
      worldName: data.worldName ?? '',
      smsAuthEnabled: data.smsAuthEnabled ?? false,
      smsBalance:
        typeof data.smsBalance === 'number' && Number.isFinite(data.smsBalance) && data.smsBalance > 0
          ? Math.floor(data.smsBalance)
          : 0,
      smsPendingCount: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
}

/** 途中まで進んだ登録（レコードはあるが ownerUid 未設定）を完了させる。 */
export async function completeOrganizerRecord(
  contractId: string,
  patch: Partial<CreateOrganizerData> & { ownerUid: string },
): Promise<void> {
  await db
    .collection(ORGANIZERS_COLLECTION)
    .doc(contractId)
    .update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
}

/** プロビジョニングの「更新」で書き換えてよい項目（認証情報は含めない）。 */
export interface ProvisioningProfilePatch {
  companyName?: string;
  address?: string;
  phone?: string;
  subscriberCap?: number;
  couponCap?: number;
  /** 一時上げの期限。null は「一時上げなし」への明示的なクリア */
  tempSubscriberCapUntil?: string | null;
  /** 一時上げ後に戻る購読者枠。null は明示的なクリア */
  restoredSubscriberCap?: number | null;
  /** 店舗課金オプションの ON/OFF。送られた場合だけ反映する */
  billingOptionEnabled?: boolean;
  /** 広告オプションの ON/OFF。送られた場合だけ反映する */
  adsOptionEnabled?: boolean;
  /** ポータル（特設サイト本契約）の ON/OFF。送られた場合だけ反映する */
  portalEnabled?: boolean;
  /** 世界観の名前。送られた場合だけ反映する */
  worldName?: string;
  /** SMS認証の ON/OFF。送られた場合だけ反映する */
  smsAuthEnabled?: boolean;
  /**
   * SMSカード残高（本家の絶対値）。プロビジョニング側で未報告の消費分を
   * 差し引いてから書き込む（lib/provisioning.ts が調整する）。
   */
  smsBalance?: number;
}

/**
 * 本家のプラン変更などに伴う契約者情報の更新。
 * email / パスワード / ownerUid などの認証情報には一切触れない。
 */
export async function applyProvisioningUpdate(
  contractId: string,
  patch: ProvisioningProfilePatch,
): Promise<void> {
  await db
    .collection(ORGANIZERS_COLLECTION)
    .doc(contractId)
    .update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
}

/** 初回パスワード変更の完了を記録する（フラグを下ろす）。 */
export async function clearMustChangePassword(contractId: string): Promise<void> {
  await db
    .collection(ORGANIZERS_COLLECTION)
    .doc(contractId)
    .update({ mustChangePassword: false, updatedAt: FieldValue.serverTimestamp() });
}

// ─── 連携ログ ───

export type ProvisioningResult = 'created' | 'replayed' | 'updated' | 'failed';

/**
 * 連携処理の結果を記録する。パスワードは絶対に記録しない
 * （引数にも含めない設計にして、混入自体を防ぐ）。
 */
export async function logProvisioning(entry: {
  contractId: string;
  email: string;
  result: ProvisioningResult;
  error?: string;
}): Promise<void> {
  await db.collection(PROVISIONING_LOGS_COLLECTION).add({
    contractId: entry.contractId,
    email: entry.email,
    result: entry.result,
    ...(entry.error ? { error: entry.error } : {}),
    at: FieldValue.serverTimestamp(),
  });
}
