// 本家決済完了 → EVENT への契約者自動登録（プロビジョニング）の本体。
//
// 冪等性: 契約ID（contractId）をキーにする create-or-update。
// - 契約が無ければ「新規作成」: Auth ユーザーを作り、契約者レコードを作る。
//   初期パスワードのまま使わせないため mustChangePassword を立てる
//   （初回ログインで変更するまで管理画面/APIは使えない）。
// - 契約があり ownerUid 設定済みなら「更新」: 本家のプラン変更（枠の変更）に追随し、
//   送られた項目（契約枠・会社情報）だけを反映する。パスワード等の認証情報には
//   一切触れない（送られてきても無視する）。
// - Auth ユーザー作成後に落ちても、再送時にメールアドレスで既存ユーザーを
//   引き直して続きを完了させる。
// - パスワードは Auth に渡すだけで、ログ・レコードのどこにも残さない。
import { authAdmin } from './firebase-admin';
import {
  propagateCapsToOwnerEvents,
  propagatePortalEnabledToOwnerEvents,
} from './event-store';
import { applyProvisionedSmsBalance, sanitizeSmsBalance } from './sms-mirror';
import {
  applyProvisioningUpdate,
  completeOrganizerRecord,
  createOrganizerRecord,
  getOrganizer,
  logProvisioning,
  type Organizer,
  type ProvisioningProfilePatch,
} from './organizers';

export interface ProvisionOrganizerInput {
  contractId: string;
  email: string;
  /** 新規作成時のみ必須。更新時は送られても無視する */
  password?: string;
  companyName: string;
  address?: string;
  phone?: string;
  /** 使用開始日（決済完了日, 'YYYY-MM-DD'）。新規作成時のみ使う */
  startDate: string;
  subscriberCap?: number;
  couponCap?: number;
  /**
   * 一時的な枠上げの期限（ISO日付文字列）。任意項目:
   * 送られなければ既存値を変えない。null は明示的なクリア。
   * 警告バナー（復帰時の枠超過）用の材料として保持するだけ。
   */
  tempSubscriberCapUntil?: string | null;
  /** 一時上げの期限後に戻る購読者枠。任意項目（意味は上と同じ）。 */
  restoredSubscriberCap?: number | null;
  agencyCode?: string | null;
  /**
   * 店舗課金オプションの ON/OFF。任意項目:
   * boolean が送られた場合だけ反映し、送られなければ既存値を変えない。
   * boolean 以外は無視する。
   */
  billingOptionEnabled?: boolean;
  /**
   * 広告オプションの ON/OFF。任意項目:
   * boolean が送られた場合だけ反映し、送られなければ既存値を変えない。
   * boolean 以外は無視する。
   */
  adsOptionEnabled?: boolean;
  /**
   * ポータル（特設サイト本契約）の ON/OFF。任意項目:
   * boolean が送られた場合だけ反映し、送られなければ既存値を変えない。
   * 契約レコードへ保存し、イベント側の portalEnabled へも伝播する
   * （クーポン・特典の管理場所の切り替えに使う）。
   * boolean 以外は無視する。
   */
  portalEnabled?: boolean;
  /**
   * 世界観の名前（申込時の希望名、例: 飯能カレー）。任意項目:
   * 送られなければ既存値を変えない。空文字・上限超は無視する
   * （無害化は sanitizeWorldName）。
   */
  worldName?: string;
  /**
   * SMS認証の ON/OFF（本家 lib/sms-card.ts のミラー契約）。任意項目:
   * boolean が送られた場合だけ反映し、送られなければ既存値を変えない。
   * アプリ側の既定は false（端末認証）で、本家が明示的に true を
   * 送った契約だけが SMS 電話登録になる。
   */
  smsAuthEnabled?: boolean;
  /**
   * SMSカード残高（本家台帳の絶対値）。任意項目: 数値が送られた場合だけ
   * ミラーへ取り込む。本家の絶対値はアプリ側の未報告消費を知らないため、
   * 取り込み時に未報告分を差し引く（lib/sms-mirror.ts）。不正値は無視する。
   */
  smsBalance?: number;
}

export type ProvisionOrganizerResult =
  | { ok: true; status: 'created' | 'updated'; ownerUid: string }
  | { ok: false; error: string; status?: number };

/**
 * 冪等判定（純粋関数）:
 * レコードがあり ownerUid 設定済みなら登録は完了しているので 'update'。
 * それ以外（未登録・途中状態）は 'create' として続きから処理する。
 */
export function decideProvisioning(
  existing: Pick<Organizer, 'ownerUid'> | null,
): 'create' | 'update' {
  return existing?.ownerUid ? 'update' : 'create';
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

/**
 * 一時上げ期限の無害化（純粋関数）。任意項目なので、変な値で
 * リクエスト全体を落とさず「無かったこと」に倒す:
 * - undefined（未送信）→ undefined（既存値を変えない）
 * - null → null（明示的なクリア）
 * - ISO日付として読める文字列 → そのまま
 * - それ以外 → undefined（無視）
 */
function sanitizeTempSubscriberCapUntil(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string') return undefined;
  if (!ISO_DATE_PREFIX.test(value) || Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

/**
 * 復帰枠の無害化（純粋関数）。考え方は sanitizeTempSubscriberCapUntil と同じ:
 * 有限の0以上の数か null だけを通し、それ以外は無視する。
 */
function sanitizeRestoredSubscriberCap(
  value: number | null | undefined,
): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** 世界観の名前の文字数上限。 */
export const MAX_WORLD_NAME_LENGTH = 100;

/**
 * 世界観の名前の無害化（純粋関数）。任意項目なので、変な値で
 * リクエスト全体を落とさず「無かったこと」に倒す:
 * - undefined（未送信）・文字列以外 → undefined（既存値を変えない）
 * - 前後の空白を除いて空 → undefined（空文字では上書きしない）
 * - 上限（MAX_WORLD_NAME_LENGTH）を超える → undefined（無視）
 * - それ以外 → 空白を除いた文字列
 */
function sanitizeWorldName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_WORLD_NAME_LENGTH) return undefined;
  return trimmed;
}

/**
 * 更新で反映する項目の抽出（純粋関数）。
 * 送られた項目だけを patch に含める。email / startDate / agencyCode と
 * 認証情報（パスワード）は更新対象に含めない。
 * 一時上げまわりの任意項目は無害化してから含める（不正値は無視）。
 */
export function buildProvisioningUpdate(
  input: Pick<
    ProvisionOrganizerInput,
    | 'companyName'
    | 'address'
    | 'phone'
    | 'subscriberCap'
    | 'couponCap'
    | 'tempSubscriberCapUntil'
    | 'restoredSubscriberCap'
    | 'billingOptionEnabled'
    | 'adsOptionEnabled'
    | 'portalEnabled'
    | 'worldName'
    | 'smsAuthEnabled'
  >,
): ProvisioningProfilePatch {
  const patch: ProvisioningProfilePatch = {};
  if (typeof input.companyName === 'string' && input.companyName.trim()) {
    patch.companyName = input.companyName;
  }
  if (typeof input.address === 'string') patch.address = input.address;
  if (typeof input.phone === 'string') patch.phone = input.phone;
  if (typeof input.subscriberCap === 'number' && Number.isFinite(input.subscriberCap)) {
    patch.subscriberCap = input.subscriberCap;
  }
  if (typeof input.couponCap === 'number' && Number.isFinite(input.couponCap)) {
    patch.couponCap = input.couponCap;
  }
  const tempUntil = sanitizeTempSubscriberCapUntil(input.tempSubscriberCapUntil);
  if (tempUntil !== undefined) patch.tempSubscriberCapUntil = tempUntil;
  const restoredCap = sanitizeRestoredSubscriberCap(input.restoredSubscriberCap);
  if (restoredCap !== undefined) patch.restoredSubscriberCap = restoredCap;
  // 店舗課金オプションは boolean が送られた場合だけ反映する。
  if (typeof input.billingOptionEnabled === 'boolean') {
    patch.billingOptionEnabled = input.billingOptionEnabled;
  }
  // 広告オプションも boolean が送られた場合だけ反映する。
  if (typeof input.adsOptionEnabled === 'boolean') {
    patch.adsOptionEnabled = input.adsOptionEnabled;
  }
  // ポータルも boolean が送られた場合だけ反映する。
  if (typeof input.portalEnabled === 'boolean') {
    patch.portalEnabled = input.portalEnabled;
  }
  const worldName = sanitizeWorldName(input.worldName);
  if (worldName !== undefined) patch.worldName = worldName;
  // SMS認証の切替は boolean が送られた場合だけ反映する。
  if (typeof input.smsAuthEnabled === 'boolean') {
    patch.smsAuthEnabled = input.smsAuthEnabled;
  }
  return patch;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 新規作成時の入力チェック。問題があればエラーメッセージを返す。 */
export function validateCreateInput(input: ProvisionOrganizerInput): string | null {
  if (!input.email || !input.email.includes('@')) return '有効な email が必要です';
  if (!input.password || input.password.length < 6) {
    return 'password は6文字以上が必要です';
  }
  if (!input.companyName) return 'companyName が必要です';
  if (!DATE_PATTERN.test(input.startDate)) {
    return 'startDate は YYYY-MM-DD 形式で指定してください';
  }
  return null;
}

function authErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** Auth ユーザーを作る。既に同じメールがあればそのユーザーを返す（再送時の復旧）。 */
async function createOrReuseAuthUser(
  email: string,
  password: string,
): Promise<string> {
  try {
    const user = await authAdmin.createUser({ email, password });
    return user.uid;
  } catch (error) {
    if (authErrorCode(error) === 'auth/email-already-exists') {
      const existing = await authAdmin.getUserByEmail(email);
      return existing.uid;
    }
    throw error;
  }
}

export async function provisionOrganizer(
  input: ProvisionOrganizerInput,
): Promise<ProvisionOrganizerResult> {
  const existing = await getOrganizer(input.contractId);

  if (decideProvisioning(existing) === 'update') {
    // 更新: 送られた項目だけを反映する。認証情報には触れない。
    const patch = buildProvisioningUpdate(input);
    if (Object.keys(patch).length > 0) {
      await applyProvisioningUpdate(input.contractId, patch);
    }
    // SMSカード残高（本家の絶対値）が送られてきたらミラーへ取り込む。
    // 本家の絶対値はアプリ側の未報告消費を知らないため、その分を差し引く
    // （二重に数えないための調整。lib/sms-mirror.ts）。
    const smsBalance = sanitizeSmsBalance(input.smsBalance);
    if (smsBalance !== undefined) {
      await applyProvisioningUpdate(input.contractId, {
        smsBalance: applyProvisionedSmsBalance(
          smsBalance,
          existing!.smsPendingCount ?? 0,
        ),
      });
    }
    // 枠が変わったら、終わっていないイベント（下書き・開催中）にも
    // 同じ枠を伝播させる。終了済みイベントの枠は履歴として触らない。
    // 伝播の失敗で更新自体を失敗にはしない（失敗はログに残す）。
    if (patch.subscriberCap !== undefined || patch.couponCap !== undefined) {
      try {
        const propagation = await propagateCapsToOwnerEvents(existing!.ownerUid!, {
          subscriberCap: patch.subscriberCap,
          couponCap: patch.couponCap,
        });
        if (propagation.failed.length > 0) {
          await logProvisioning({
            contractId: input.contractId,
            email: existing!.email,
            result: 'updated',
            error: `caps-propagation-failed: ${propagation.failed
              .map((f) => f.eventId)
              .join(',')}`,
          });
        }
      } catch (error) {
        console.error('[provisioning] 枠の伝播に失敗:', error);
        await logProvisioning({
          contractId: input.contractId,
          email: existing!.email,
          result: 'updated',
          error: 'caps-propagation-error',
        }).catch(() => undefined);
      }
    }
    // ポータルの ON/OFF が変わったら、終わっていないイベントへも伝播
    // させる（クーポン・特典の管理場所が切り替わる）。枠の伝播と同じく、
    // 失敗しても更新自体は失敗にしない。
    if (patch.portalEnabled !== undefined) {
      try {
        const propagation = await propagatePortalEnabledToOwnerEvents(
          existing!.ownerUid!,
          patch.portalEnabled,
        );
        if (propagation.failed.length > 0) {
          await logProvisioning({
            contractId: input.contractId,
            email: existing!.email,
            result: 'updated',
            error: `portal-propagation-failed: ${propagation.failed
              .map((f) => f.eventId)
              .join(',')}`,
          });
        }
      } catch (error) {
        console.error('[provisioning] ポータルの伝播に失敗:', error);
        await logProvisioning({
          contractId: input.contractId,
          email: existing!.email,
          result: 'updated',
          error: 'portal-propagation-error',
        }).catch(() => undefined);
      }
    }
    await logProvisioning({
      contractId: input.contractId,
      email: existing!.email,
      result: 'updated',
    });
    return { ok: true, status: 'updated', ownerUid: existing!.ownerUid! };
  }

  const validationError = validateCreateInput(input);
  if (validationError) {
    return { ok: false, error: validationError, status: 400 };
  }

  let ownerUid: string;
  try {
    ownerUid = await createOrReuseAuthUser(input.email, input.password!);
  } catch {
    await logProvisioning({
      contractId: input.contractId,
      email: input.email,
      result: 'failed',
      error: 'auth-user-creation-failed',
    });
    return { ok: false, error: 'ログインユーザーの作成に失敗しました' };
  }

  const record = {
    email: input.email,
    companyName: input.companyName,
    address: input.address ?? '',
    phone: input.phone ?? '',
    startDate: input.startDate,
    subscriberCap: input.subscriberCap,
    couponCap: input.couponCap,
    // 一時上げまわりの任意項目は、無害化した値だけを保持する。
    tempSubscriberCapUntil:
      sanitizeTempSubscriberCapUntil(input.tempSubscriberCapUntil) ?? null,
    restoredSubscriberCap:
      sanitizeRestoredSubscriberCap(input.restoredSubscriberCap) ?? null,
    agencyCode: input.agencyCode ?? null,
    // 店舗課金オプションは boolean のときだけ有効として保存（それ以外は無効）。
    billingOptionEnabled: input.billingOptionEnabled === true,
    // 広告オプションも boolean のときだけ有効として保存（それ以外は無効）。
    adsOptionEnabled: input.adsOptionEnabled === true,
    // ポータルは boolean のときだけ有効として保存（それ以外はアプリ単独）。
    portalEnabled: input.portalEnabled === true,
    // 世界観の名前は無害化した値だけを保持する。
    worldName: sanitizeWorldName(input.worldName) ?? '',
    // SMS認証は boolean のときだけ有効として保存（それ以外は端末認証）。
    smsAuthEnabled: input.smsAuthEnabled === true,
    // SMSカード残高ミラーは無害化した絶対値だけを保持する。
    smsBalance: sanitizeSmsBalance(input.smsBalance) ?? 0,
    // 初期パスワードは初回ログインで必ず変更させる。
    mustChangePassword: true,
  };

  if (existing) {
    await completeOrganizerRecord(input.contractId, { ...record, ownerUid });
  } else {
    await createOrganizerRecord(input.contractId, { ...record, ownerUid });
  }

  await logProvisioning({
    contractId: input.contractId,
    email: input.email,
    result: 'created',
  });
  return { ok: true, status: 'created', ownerUid };
}
