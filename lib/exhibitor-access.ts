// lib/exhibitor-access.ts
// 参加店ログインの「プロジェクト専用アクセスコード」基盤。
//
// 決定（2026-11-10 Ishii、仕様メモ「参加店ログインの作り直し」）:
// 参加店は Firebase Auth に入れない。Auth のアカウントは契約者（主催者）
// だけ。参加店の頭の中は「プロジェクトごと・主催者ごと」なので、ログイン資格も
// プロジェクトごとに独立させる:
// - 参加店は events/{eventId}/exhibitors/{id} ドキュメントにメールアドレスと
// アクセスコード（ハッシュ化して accessCode フィールドに保存）を持つ。
// 画面上の表記は「パスワード」。
// - 登録時にプロジェクト専用コードを発行し、メールで参加店へ渡す。同じ人が別
// プロジェクトに出店すれば別ドキュメント・別コードで、互いに影響しない。
// - ログインはメール＋コードをサーバーで照合し、通ればそのプロジェクト専用の
// カスタムトークン（合成 uid + クレーム）でセッション化する。
// - 再発行はフィールドの書き換えだけ。旧コードはその場で失効する。
// - プロジェクト終了時はコレクションごとリセット（Auth 側の削除作業なし）。
//
// 旧方式（PR #36: Auth アカウント自動作成＋パスワード設定リンク招待、
// lib/exhibitor-account.ts）はこの方式に置き換えて廃止した。
import {
randomBytes,
scrypt,
timingSafeEqual,
} from 'node:crypto';
import { FieldValue} from 'firebase-admin/firestore';
import { db} from './firebase-admin';
import {
EVENT_EXHIBITORS_COLLECTION,
createExhibitor,
parseExhibitorKind,
type EventExhibitor,
type ExhibitorKind,
} from './event-coupon';
import { resolveLocale, type Locale} from './i18n';
import { sendEmail} from './mailer';
import { APP_ORIGIN, resolveAppOrigin } from './app-origin';

function scryptAsync(
  secret: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

// ─── コードの生成 ───

// 読み間違えやすい文字（0/O、1/I/L）を除いた英数字。
export const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ACCESS_CODE_LENGTH = 10;

/**
* アクセスコードを生成する。アルファベット長で割り切れる範囲までの
* バイトだけを使って偏りを無くす（リジェクションサンプリング）。
*/
export function generateAccessCode(
random: (size: number) => Buffer = randomBytes,
): string {
const alphabet = ACCESS_CODE_ALPHABET;
const limit = 256 - (256 % alphabet.length);
let code = '';
while (code.length < ACCESS_CODE_LENGTH) {
const bytes = random(ACCESS_CODE_LENGTH - code.length + 8);
for (const byte of bytes) {
if (byte >= limit) continue;
code += alphabet[byte % alphabet.length];
if (code.length >= ACCESS_CODE_LENGTH) break;
}
}
return code;
}

/** 入力されたコードの正規化（前後空白を取り除き大文字に揃える）。 */
export function normalizeAccessCode(raw: string): string {
return raw.trim().toUpperCase();
}

// ─── ハッシュ化と照合 ───

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

// 保存形式: scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
// パラメータも一緒に持たせ、将来の強度変更に耐える形にする。
export async function hashAccessCode(code: string): Promise<string> {
const salt = randomBytes(SALT_BYTES);
const derived = (await scryptAsync(code, salt, SCRYPT_KEYLEN, {
N: SCRYPT_N,
r: SCRYPT_R,
p: SCRYPT_P,
})) as Buffer;
return [
'scrypt',
String(SCRYPT_N),
String(SCRYPT_R),
String(SCRYPT_P),
salt.toString('base64url'),
derived.toString('base64url'),
].join('$');
}

/**
* 照合（タイミング安全な比較）。保存値が無い・壊れている場合は false。
* 保存値側のパラメータが想定外に大きい場合は DoS 回避のため照合しない。
*/
export async function verifyAccessCode(
code: string,
stored: string | null | undefined,
): Promise<boolean> {
if (!stored) return false;
const parts = stored.split('$');
if (parts.length!== 6 || parts[0]!== 'scrypt') return false;
const N = Number(parts[1]);
const r = Number(parts[2]);
const p = Number(parts[3]);
if (!Number.isInteger(N) || N <= 1 || N > 2 ** 20 || (N & (N - 1))!== 0) {
return false;
}
if (!Number.isInteger(r) || r < 1 || r > 16) return false;
if (!Number.isInteger(p) || p < 1 || p > 16) return false;
const salt = Buffer.from(parts[4], 'base64url');
const expected = Buffer.from(parts[5], 'base64url');
if (salt.length === 0 || salt.length > 64) return false;
if (expected.length === 0 || expected.length > 64) return false;
try {
const derived = (await scryptAsync(code, salt, expected.length, {
N,
r,
p,
})) as Buffer;
return timingSafeEqual(derived, expected);
} catch {
return false;
}
}

/**
* 参加店が存在しない場合のタイミング均一化用ダミー。照合時間の差で
* 「そのメールが登録されているか」を推測されないようにするためのもので、
* 実際のコードとは一致しない（生成時の入力は破棄済み）。
*/
const DUMMY_ACCESS_CODE_HASH =
'scrypt$16384$8$1$mmV4w7GCRl8JUvzfPkJDYw$jAhcM__gqKRn5yNkGFL4mVlGChUCkzzhadXAPOIzvpE';

// ─── メールアドレス ───

export function normalizeExhibitorEmail(raw: string): string {
return raw.trim().toLowerCase();
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidExhibitorEmail(email: string): boolean {
return email.length > 0 && email.length <= 254 && EMAIL_PATTERN.test(email);
}

// ─── 登録時の住所（店舗課金オプション） ───

/** 登録住所の上限文字数（公開プロフィールの住所と同じ上限）。 */
export const REGISTRATION_ADDRESS_MAX_LENGTH = 120;

export type ParseRegistrationAddressResult =
| { ok: true; value: string }
| { ok: false; error: string };

/**
* 登録住所の入力検証（純粋関数）。
* 店舗課金オプションが有効な契約では必須（required=true）。無効な契約では
* 任意で、未入力なら空文字を返す。値は trim して返す。
* ここで検証した住所は参加店ドキュメントのトップレベル `address` に
* 管理用として保存し、公開プロフィール（profile.address）とは混ぜない。
*/
export function parseRegistrationAddress(
raw: unknown,
required: boolean,
): ParseRegistrationAddressResult {
if (raw === undefined || raw === null) {
return required
? { ok: false, error: '住所が必要です' }
: { ok: true, value: '' };
}
if (typeof raw !== 'string') {
return { ok: false, error: '住所の形式が不正です' };
}
const value = raw.trim();
if (!value) {
return required
? { ok: false, error: '住所が必要です' }
: { ok: true, value: '' };
}
if (value.length > REGISTRATION_ADDRESS_MAX_LENGTH) {
return {
ok: false,
error: `住所は${REGISTRATION_ADDRESS_MAX_LENGTH}文字以内で入力してください`,
};
}
return { ok: true, value };
}

// ─── セッション ───

/**
* 参加店セッション（カスタムトークン）の合成 uid。
* そのプロジェクト配下だけを指す一時的な ID で、Auth のアカウントではない。
*/
export function exhibitorSessionUid(eventId: string, exhibitorId: string): string {
return `exhibitor:${eventId}:${exhibitorId}`;
}

// ─── エラー ───

/** ルート側でそのまま返せる日本語メッセージと HTTP ステータスを持つエラー。 */
export class ExhibitorAccessError extends Error {
readonly status: number;

constructor(message: string, status = 400) {
super(message);
this.name = 'ExhibitorAccessError';
this.status = status;
}
}

// ─── 保存層 ───

export interface StoredExhibitorAccess {
id: string;
name: string;
email: string | null;
/** エンコード済みハッシュ。未発行なら null。 */
accessCodeHash: string | null;
/** アカウントの種類（参加店／協賛）。旧ドキュメントは 'shop' */
kind: ExhibitorKind;
/**
 * 閉店扱い（掲載停止から3ヶ月経過後の新規登録で付けられる印）かどうか。
 * 閉店レコードは重複判定・ログイン照合の対象から外れる。
 */
closed: boolean;
}

/** このモジュールが使う保存層の最小インターフェース（テストで差し替え可能にする）。 */
export interface ExhibitorAccessStore {
findByEmail(
eventId: string,
email: string,
): Promise<StoredExhibitorAccess | null>;
getById(
eventId: string,
exhibitorId: string,
): Promise<StoredExhibitorAccess | null>;
createExhibitor(
eventId: string,
input: {
name: string;
email: string;
lang: Locale;
/** 登録住所（管理用）。検証済みの文字列。未収集なら未指定 */
address?: string;
kind: ExhibitorKind;
/** 登録の入口。未指定は主催者発行（'admin'） */
source?: 'admin' | 'self';
/** ドキュメントIDを先に決める場合（自己申込の事前採番） */
id?: string;
},
): Promise<{ id: string}>;
setAccessCodeHash(
eventId: string,
exhibitorId: string,
encodedHash: string,
): Promise<void>;
setEmail(eventId: string, exhibitorId: string, email: string): Promise<void>;
}

function exhibitorsRef(eventId: string) {
return db
.collection('events')
.doc(eventId)
.collection(EVENT_EXHIBITORS_COLLECTION);
}

function mapStored(
id: string,
data: Record<string, unknown>,
): StoredExhibitorAccess {
return {
id,
name: String(data.name?? ''),
email:
typeof data.email === 'string' && data.email
? normalizeExhibitorEmail(data.email)
: null,
accessCodeHash:
typeof data.accessCode === 'string' && data.accessCode
? data.accessCode
: null,
kind: parseExhibitorKind(data.kind),
closed: typeof data.closedAt === 'string' && data.closedAt.length > 0,
};
}

export const firestoreExhibitorAccessStore: ExhibitorAccessStore = {
async findByEmail(eventId, email) {
// 同じメールは原則1件だけだが、閉店→新規登録の移行後は旧レコード
// （閉店印つき）が残るため、閉店でないものを優先して返す。
// 閉店レコードしか無ければ「登録なし」として扱う（重複判定で
// 弾かず、ログインも通さない）。
const snap = await exhibitorsRef(eventId)
.where('email', '==', email)
.get();
for (const doc of snap.docs) {
const stored = mapStored(doc.id, doc.data());
if (!stored.closed) return stored;
}
return null;
},
async getById(eventId, exhibitorId) {
const doc = await exhibitorsRef(eventId).doc(exhibitorId).get();
if (!doc.exists) return null;
return mapStored(doc.id, doc.data()!);
},
async createExhibitor(eventId, input) {
const exhibitor: EventExhibitor = await createExhibitor(eventId, {
name: input.name,
email: input.email,
lang: input.lang,
address: input.address || null,
kind: input.kind,
source: input.source,
id: input.id,
});
return { id: exhibitor.id};
},
async setAccessCodeHash(eventId, exhibitorId, encodedHash) {
await exhibitorsRef(eventId)
.doc(exhibitorId)
.update({ accessCode: encodedHash, accessCodeUpdatedAt: FieldValue.serverTimestamp()});
},
async setEmail(eventId, exhibitorId, email) {
await exhibitorsRef(eventId).doc(exhibitorId).update({ email});
},
};

// ─── アプリの origin と消込ページ URL ───

// origin の実体は共有 lib（lib/app-origin）に切り出した。主催者コンソール
// （クライアント側）でも来場者ページ URL を組み立てるため、サーバー専用
// コードを含まない場所に置く。既存の import 互換のため、ここからも公開する。
export { APP_ORIGIN, resolveAppOrigin };

/** 参加店の消込（ログイン）ページ URL。メール本文に載せて参加店に渡す。 */
export function exhibitorRedeemUrl(eventId: string): string {
return `${resolveAppOrigin()}/e/${encodeURIComponent(eventId)}/redeem`;
}

// ─── メール送信 ───

export type ExhibitorMailSender = (args: {
to: string;
subject: string;
html: string;
}) => Promise<{ success: boolean; error?: string}>;

export interface ExhibitorAccessDeps {
store: ExhibitorAccessStore;
sendMail: ExhibitorMailSender;
}

const defaultDeps: ExhibitorAccessDeps = {
store: firestoreExhibitorAccessStore,
sendMail: (args) => sendEmail(args),
};

function escapeHtml(value: string): string {
return value
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;');
}

function buildPasswordEmailHtml(input: {
exhibitorName: string;
eventName?: string | null;
code: string;
loginUrl: string;
reissued: boolean;
/** 自己申込（申込ページから自分で登録）かどうか。未指定は主催者発行 */
selfServed?: boolean;
}): string {
const eventPart = input.eventName
? `プロジェクト「${escapeHtml(input.eventName)}」`
: 'Push-taro.スタンプラリー のプロジェクト';
const lead = input.reissued
? `<p>${eventPart}の消込ログイン用パスワードを再発行しました。今までのパスワードは使えなくなります。</p>`
: input.selfServed
? `<p>${eventPart}へのお申し込み（ご登録）が完了しました。</p>`
: `<p>Push-taro.スタンプラリー の主催者により、${eventPart}の参加店として登録されました。</p>`;
return `
<p>${escapeHtml(input.exhibitorName)} 様</p>
${lead}
<p>クーポンの消し込みに使う、参加店ログインのパスワード（このプロジェクト専用）をお知らせします。</p>
<p>ログインIDは ご登録のメールアドレスです</p>
<p>パスワード: <strong>${escapeHtml(input.code)}</strong></p>
<p>ログインURL: ${escapeHtml(input.loginUrl)}</p>
<p>消込ページで、このメールアドレスと上記のパスワードを入力してログインしてください。パスワードはプロジェクトごとに異なります。</p>
<p>※パスワードは他の人に教えないでください。</p>
<p>※このメールに心当たりがない場合は、破棄していただいて構いません。</p>
`;
}

/** ログイン先 URL。協賛（広告専用）は広告コンソール（店舗ページ）に着地させる。 */
export function exhibitorLoginUrl(
eventId: string,
kind: ExhibitorKind = 'shop',
): string {
return kind === 'advertiser'
? `${resolveAppOrigin()}/e/${encodeURIComponent(eventId)}/shop`
: exhibitorRedeemUrl(eventId);
}

/** 登録時のパスワード通知メール。文面は日本語固定、表記は「パスワード」。 */
export function buildExhibitorPasswordEmail(input: {
exhibitorName: string;
eventName?: string | null;
eventId: string;
code: string;
kind?: ExhibitorKind;
/** 登録の入口。自己申込（'self'）では冒頭の文面が申込完了の案内になる */
source?: 'admin' | 'self';
}): { subject: string; html: string} {
return {
subject: '参加店ログイン用パスワードのお知らせ',
html: buildPasswordEmailHtml({
exhibitorName: input.exhibitorName,
eventName: input.eventName,
code: input.code,
loginUrl: exhibitorLoginUrl(input.eventId, input.kind ?? 'shop'),
reissued: false,
selfServed: input.source === 'self',
}),
};
}

/** 再発行時のパスワード通知メール。 */
export function buildExhibitorPasswordReissueEmail(input: {
exhibitorName: string;
eventName?: string | null;
eventId: string;
code: string;
kind?: ExhibitorKind;
}): { subject: string; html: string} {
return {
subject: '参加店ログイン用パスワード再発行のお知らせ',
html: buildPasswordEmailHtml({
exhibitorName: input.exhibitorName,
eventName: input.eventName,
code: input.code,
loginUrl: exhibitorLoginUrl(input.eventId, input.kind ?? 'shop'),
reissued: true,
}),
};
}

// ─── 登録 ───

export interface RegisterExhibitorResult {
exhibitorId: string;
email: string;
/** パスワード通知メールの送信に成功したか（失敗しても登録は成立する） */
mailSent: boolean;
}

/**
* 参加店を登録し、プロジェクト専用パスワードを発行してメールで送る。
* - メール形式が不正なら 400。同一プロジェクト内で同じメールが既にあれば 400。
* - コード自体は戻り値に含めない（メールでのみ参加店に渡る）。
* - メール送信の失敗は登録の失敗にしない（主催者は再発行で送り直せる）。
*/
export async function registerExhibitor(
input: {
eventId: string;
name: string;
email: string;
lang?: Locale;
eventName?: string | null;
/** 登録住所（管理用）。呼び出し側で必須判定済みの検証済み文字列 */
address?: string;
/** アカウントの種類。未指定は参加店（'shop'）。協賛は 'advertiser' */
kind?: ExhibitorKind;
/** 登録の入口。未指定は主催者発行（'admin'）。自己申込は 'self' */
source?: 'admin' | 'self';
/**
 * ドキュメントIDを先に決める場合に指定する。自己申込では支払い確認前に
 * 課金レコードを同じ ID で作るため、申込時点で採番した ID を渡す。
 */
exhibitorId?: string;
},
deps: ExhibitorAccessDeps = defaultDeps,
): Promise<RegisterExhibitorResult> {
const name = input.name.trim();
if (!name) throw new ExhibitorAccessError('参加店名が必要です', 400);
const addressResult = parseRegistrationAddress(input.address, false);
if (!addressResult.ok) {
throw new ExhibitorAccessError(addressResult.error, 400);
}
const address = addressResult.value;
const rawEmail = input.email.trim();
if (!rawEmail) throw new ExhibitorAccessError('メールアドレスが必要です', 400);
const email = normalizeExhibitorEmail(rawEmail);
if (!isValidExhibitorEmail(email)) {
throw new ExhibitorAccessError('メールアドレスの形式が正しくありません', 400);
}

const existing = await deps.store.findByEmail(input.eventId, email);
if (existing) {
throw new ExhibitorAccessError(
'そのメールアドレスはこのプロジェクトで既に登録されています',
400,
);
}

const created = await deps.store.createExhibitor(input.eventId, {
name,
email,
lang: resolveLocale(input.lang),
...(address ? { address } : {}),
kind: input.kind ?? 'shop',
source: input.source,
id: input.exhibitorId,
});
const code = generateAccessCode();
await deps.store.setAccessCodeHash(
input.eventId,
created.id,
await hashAccessCode(code),
);

const mail = buildExhibitorPasswordEmail({
exhibitorName: name,
eventName: input.eventName,
eventId: input.eventId,
code,
kind: input.kind ?? 'shop',
source: input.source,
});
let mailSent = false;
try {
const result = await deps.sendMail({
to: email,
subject: mail.subject,
html: mail.html,
});
mailSent = result.success;
if (!result.success) {
console.error('[exhibitor-access] password email failed:', result.error);
}
} catch (error) {
console.error('[exhibitor-access] password email error:', error);
}
return { exhibitorId: created.id, email, mailSent};
}

// ─── ログイン照合 ───

export interface AuthenticatedExhibitor {
exhibitorId: string;
name: string;
email: string;
}

/**
* メール＋コードの照合。成功時のみ参加店を返す。
* 存在しないメールでもダミーハッシュで照合して時間を均し、
* 「登録されているか」を応答時間から推測されないようにする。
*/
export async function authenticateExhibitor(
input: { eventId: string; email: string; code: string},
deps: ExhibitorAccessDeps = defaultDeps,
): Promise<AuthenticatedExhibitor | null> {
const email = normalizeExhibitorEmail(input.email);
const exhibitor = await deps.store.findByEmail(input.eventId, email);
const stored = exhibitor?.accessCodeHash?? DUMMY_ACCESS_CODE_HASH;
const ok = await verifyAccessCode(normalizeAccessCode(input.code), stored);
if (!exhibitor ||!exhibitor.accessCodeHash ||!ok) return null;
return { exhibitorId: exhibitor.id, name: exhibitor.name, email};
}

// ─── 再発行 ───

export interface ReissueExhibitorPasswordResult {
email: string;
mailSent: boolean;
}

/**
* パスワード再発行（主催者操作）。新コードに差し替え、登録メールへ送る。
* 旧コードはハッシュを上書きした時点で失効する。
* メール未登録の旧参加店（Auth 時代のドキュメント）は、email を渡せば
* その場で設定して発行できる。
*/
export async function reissueExhibitorPassword(
input: {
eventId: string;
exhibitorId: string;
email?: string | null;
eventName?: string | null;
},
deps: ExhibitorAccessDeps = defaultDeps,
): Promise<ReissueExhibitorPasswordResult> {
const exhibitor = await deps.store.getById(input.eventId, input.exhibitorId);
if (!exhibitor) throw new ExhibitorAccessError('参加店が見つかりません', 404);

let email = exhibitor.email;
const requested = input.email?.trim();
if (requested) {
const normalized = normalizeExhibitorEmail(requested);
if (!isValidExhibitorEmail(normalized)) {
throw new ExhibitorAccessError(
'メールアドレスの形式が正しくありません',
400,
);
}
if (normalized!== email) {
const duplicate = await deps.store.findByEmail(input.eventId, normalized);
if (duplicate && duplicate.id!== exhibitor.id) {
throw new ExhibitorAccessError(
'そのメールアドレスはこのプロジェクトで既に登録されています',
400,
);
}
await deps.store.setEmail(input.eventId, exhibitor.id, normalized);
email = normalized;
}
}
if (!email) {
throw new ExhibitorAccessError(
'メールアドレスが登録されていないため、パスワードを再発行できません',
400,
);
}

const code = generateAccessCode();
await deps.store.setAccessCodeHash(
input.eventId,
exhibitor.id,
await hashAccessCode(code),
);
const mail = buildExhibitorPasswordReissueEmail({
exhibitorName: exhibitor.name,
eventName: input.eventName,
eventId: input.eventId,
code,
kind: exhibitor.kind,
});
let mailSent = false;
try {
const result = await deps.sendMail({
to: email,
subject: mail.subject,
html: mail.html,
});
mailSent = result.success;
if (!result.success) {
console.error('[exhibitor-access] reissue email failed:', result.error);
}
} catch (error) {
console.error('[exhibitor-access] reissue email error:', error);
}
return { email, mailSent};
}

/**
* パスワード再発行（参加店の自己申請）。登録メールへ新コードを送る。
* メールが登録されているかどうかを外部に漏らさないため、存在しない場合も
* 例外なく正常に終わる（呼び出し側は常に汎用の完了文を返す）。
*/
export async function requestExhibitorPasswordReset(
input: { eventId: string; email: string; eventName?: string | null},
deps: ExhibitorAccessDeps = defaultDeps,
): Promise<void> {
const email = normalizeExhibitorEmail(input.email);
if (!isValidExhibitorEmail(email)) return;
const exhibitor = await deps.store.findByEmail(input.eventId, email);
if (!exhibitor) return;
await reissueExhibitorPassword(
{ eventId: input.eventId, exhibitorId: exhibitor.id, eventName: input.eventName},
deps,
);
}
