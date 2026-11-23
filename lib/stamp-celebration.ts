// lib/stamp-celebration.ts
// スタンプ達成セレブレーション（来場者画面）の純粋ロジック。
//
// お店で最後のスタンプが押されて達成した瞬間を、お客さんとお店の人が
// 一緒に喜べるように、画面に花びらと「達成！」を出す。そのための
// 「どの無料クーポンでお祝いするか」の判定と、表示済みの管理をここに置く。
//
// 表示済みはサーバーに持たない: 端末の localStorage にクーポンIDごとの
// キーで残す（1クーポンにつき1回だけ出す）。localStorage が使えない
// 環境では、呼び出し側がセッション内の Set で代替する。

/** セレブレーションの判定に必要な無料クーポンの最小形。 */
export interface CelebrationCouponLike {
  id: string;
  /** 何周目／何サイクル目の達成で発行されたか */
  round: number;
  /** 発行元（'stamp' | 'login'。旧データでは未設定 = 'stamp'） */
  kind?: string;
  /** 発行時点の特典スナップショット（旧データでは未設定 = 'free-dish'） */
  rewardType?: string;
  benefitText?: string;
  status: 'active' | 'used';
}

export type CelebrationRewardKind = 'free-dish' | 'benefit';

/** クーポンの特典種別（スナップショット導入前は 'free-dish' に倒す）。 */
export function celebrationRewardKind(
  coupon: Pick<CelebrationCouponLike, 'rewardType'>,
): CelebrationRewardKind {
  return coupon.rewardType === 'benefit' ? 'benefit' : 'free-dish';
}

export type CelebrationCouponKind = 'stamp' | 'login';

/** クーポンの発行元（ログインボーナス導入前は 'stamp' に倒す）。 */
export function celebrationCouponKind(
  coupon: Pick<CelebrationCouponLike, 'kind'>,
): CelebrationCouponKind {
  return coupon.kind === 'login' ? 'login' : 'stamp';
}

/** 表示済みを localStorage に残すときのキー（クーポンごとに1キー）。 */
export function celebrationStorageKey(freeCouponId: string): string {
  return `stamprally-celebrated-${freeCouponId}`;
}

/**
 * お祝いを出すべきクーポンを選ぶ（純粋関数）。
 * 未使用（active）で未表示のもののうち一番新しい達成（周が最大、
 * 同じ周ではIDが大きい方）を返す。無ければ null。
 */
export function pickCelebrationCoupon<T extends CelebrationCouponLike>(
  freeCoupons: readonly T[],
  isCelebrated: (freeCouponId: string) => boolean,
): T | null {
  let best: T | null = null;
  for (const coupon of freeCoupons) {
    if (coupon.status !== 'active') continue;
    if (isCelebrated(coupon.id)) continue;
    if (
      !best ||
      coupon.round > best.round ||
      (coupon.round === best.round && coupon.id > best.id)
    ) {
      best = coupon;
    }
  }
  return best;
}

// ─── localStorage（使えない環境では黙って何もしない） ───

/** localStorage の最小インターフェース（テストで差し替え可能にする）。 */
export interface CelebrationStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** この端末で localStorage が使えるなら返す。使えなければ null。 */
export function safeLocalStorage(): CelebrationStorageLike | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function isCelebratedInStorage(
  storage: CelebrationStorageLike | null,
  freeCouponId: string,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(celebrationStorageKey(freeCouponId)) != null;
  } catch {
    return false;
  }
}

export function markCelebratedInStorage(
  storage: CelebrationStorageLike | null,
  freeCouponId: string,
): void {
  if (!storage) return;
  try {
    storage.setItem(celebrationStorageKey(freeCouponId), '1');
  } catch {
    // 書けなくても致命的ではない（セッション側の記録で抑える）
  }
}
