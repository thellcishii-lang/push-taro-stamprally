'use client';

// app/e/[eventId]/shop/page.tsx
// Push-taro.スタンプラリー の参加店用 店舗専用ページ。
// 消込画面（redeem）と同じログイン作法（メール+プロジェクト専用
// アクセスコード → カスタムトークンのセッション）で入り、自店の
// プロフィールを編集する。入れた情報はデータ1つ（exhibitor の
// profile）から、特設サイトの店舗ページとアプリの店舗表示に反映される。
// 編集できるのは自店分だけ（サーバー側で参加店セッションを検証する）。
// 画面の固定文は4言語辞書（lib/ui-text.ts の REDEEM_TEXT）。
// 出店者の言語は出店者レコードに保存され、次回ログイン時も引き継がれる。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  User,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import { auth } from '@/lib/firebase-client';
import {
  SUPPORTED_LOCALES,
  normalizeLocale,
  type Locale,
} from '@/lib/i18n';
import { redeemText, uiText } from '@/lib/ui-text';
import { specialSiteShopUrl, specialSiteUrl } from '@/lib/special-site';
import { themeCssVars } from '@/lib/theme-color';
import PasswordInput from '@/components/PasswordInput';
import PoweredByFooter from '@/components/PoweredByFooter';

interface Exhibitor {
  id: string;
  name: string;
  lang: string;
  /** アカウントの種類（'shop' = 参加店 / 'advertiser' = 協賛）。旧データは未設定 */
  kind?: string;
}

interface ShopLink {
  label: string;
  url: string;
}

interface ShopFreeDish {
  name: string;
  description: string;
  photoUrl: string | null;
}

interface ShopProfile {
  displayName: string;
  address: string;
  phone: string;
  hoursText: string;
  menuName: string;
  menuDescription: string;
  description: string;
  /** お店のトップ画像（1枚）。未設定は null */
  coverImageUrl: string | null;
  photoUrls: string[];
  instagramUrl: string;
  links: ShopLink[];
  /** 住所からサーバー側で求めた座標（クライアントでは表示・編集しない） */
  location: { lat: number; lng: number } | null;
  /** 達成で無料になる自店の一品。未登録は null */
  freeDish: ShopFreeDish | null;
  /** ログインボーナスクーポンで貰える自店の特典。未登録は null */
  loginReward: ShopFreeDish | null;
  published: boolean;
}

const EMPTY_FREE_DISH: ShopFreeDish = { name: '', description: '', photoUrl: null };

interface TopPlacementState {
  enabled: boolean;
  price: number | null;
  freeMode: boolean;
  optedIn: boolean;
  available: boolean;
  status: string | null;
  featured: boolean;
  monthlyAmount: number | null;
}

interface ShopAdContent {
  imageUrl: string | null;
  title: string;
  text: string;
  linkUrl: string | null;
}

interface ShopAdState {
  enabled: boolean;
  /** 広告オプション（主催者の契約）が有効かどうか。無効な間は申請・掲載が止まる */
  optionEnabled: boolean;
  price: number | null;
  slots: number;
  freeMode: boolean;
  available: boolean;
  status: string | null;
  subscribed: boolean;
  monthlyAmount: number | null;
  eligible: boolean;
  ad: {
    live: ShopAdContent | null;
    pending: ShopAdContent | null;
    pendingSubmittedAt: string | null;
    approvedAt: string | null;
    lastRejectedAt: string | null;
  };
}

const EMPTY_AD_CONTENT: ShopAdContent = {
  imageUrl: null,
  title: '',
  text: '',
  linkUrl: null,
};

interface ShopCouponItem {
  id: string;
  title: string;
  description: string;
  active: boolean;
  paymentPending: boolean;
  feeAmount: number | null;
  approvalStatus?: 'approved' | 'pending' | 'rejected';
  createdAt: string;
}

interface ShopCouponsState {
  fee: number;
  coupons: ShopCouponItem[];
}

interface ShopPushRequestItem {
  id: string;
  title: string;
  body: string;
  status: 'unpaid' | 'pending' | 'sent' | 'rejected' | 'failed';
  feeAmount: number;
  createdAt: string;
}

interface ShopPushRequestsState {
  fee: number;
  requests: ShopPushRequestItem[];
}

const EMPTY_PROFILE: ShopProfile = {
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

const PHOTO_MAX = 3;
const LINK_MAX = 3;

// アクセント色はプロジェクトのテーマカラー（CSS カスタムプロパティ）
// 経由で使う。変数はルート要素に themeCssVars で渡し、未設定の場合は
// var() のフォールバック（現在のベージュ／茶系）になる。
const VIOLET = 'var(--theme-accent, #8B5E34)';

// モックの言語セグメントは短い表記（EN など）。保存・送信は従来どおり locale で行う。
const PILL_LABELS: Record<Locale, string> = {
  ja: '日本語',
  en: 'EN',
  zh: '中文',
  ko: '한국어',
};

const containerStyle: React.CSSProperties = {
  padding: '16px 16px 32px',
  maxWidth: 480,
  margin: '0 auto',
  fontFamily: 'sans-serif',
  backgroundColor: '#f8fafc',
  minHeight: '100vh',
  boxSizing: 'border-box',
  color: '#0f172a',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 18,
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '12px 12px',
  marginTop: 6,
  border: '1px solid #cbd5e1',
  borderRadius: 10,
  fontSize: 16,
  backgroundColor: '#ffffff',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  marginTop: 14,
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '14px 20px',
  fontWeight: 700,
  fontSize: 16,
  backgroundColor: VIOLET,
  color: '#ffffff',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
};

const logoutButtonStyle: React.CSSProperties = {
  padding: '7px 13px',
  fontSize: 13.5,
  fontWeight: 700,
  borderRadius: 999,
  border: '1px solid #cbd5e1',
  backgroundColor: '#ffffff',
  color: '#475569',
  cursor: 'pointer',
  flexShrink: 0,
};

export default function ExhibitorShopPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useState<Locale>('ja');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [exhibitor, setExhibitor] = useState<Exhibitor | null>(null);
  const [exhibitorError, setExhibitorError] = useState('');
  const [profile, setProfile] = useState<ShopProfile>(EMPTY_PROFILE);
  const [placement, setPlacement] = useState<TopPlacementState | null>(null);
  const [placementBusy, setPlacementBusy] = useState(false);
  const [placementMessage, setPlacementMessage] = useState('');
  const [loginRewardPhotoUploading, setLoginRewardPhotoUploading] = useState(false);
  const [shopAd, setShopAd] = useState<ShopAdState | null>(null);
  const [adForm, setAdForm] = useState<ShopAdContent>(EMPTY_AD_CONTENT);
  const [adBusy, setAdBusy] = useState(false);
  const [adMessage, setAdMessage] = useState('');
  const [adPhotoUploading, setAdPhotoUploading] = useState(false);
  const [shopCoupons, setShopCoupons] = useState<ShopCouponsState | null>(null);
  const [couponForm, setCouponForm] = useState({
    title: '',
    description: '',
    keywords: '',
  });
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponMessage, setCouponMessage] = useState('');
  const [shopPushRequests, setShopPushRequests] =
    useState<ShopPushRequestsState | null>(null);
  const [pushForm, setPushForm] = useState({ title: '', body: '' });
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState('');
  const [chargeMessage, setChargeMessage] = useState('');
  // Stripe Checkout から戻ってきたときの支払い確認は、ログイン状態が
  // 揃ってから1回だけ行う（session_id をここに退避する）。
  const chargeReturnRef = useRef<string | null>(null);
  const chargeVerifiedRef = useRef(false);
  const [message, setMessage] = useState('');
  const [messageOk, setMessageOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [coverPhotoUploading, setCoverPhotoUploading] = useState(false);
  const [freeDishPhotoUploading, setFreeDishPhotoUploading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [eventName, setEventName] = useState('');
  const [themeColor, setThemeColor] = useState<string | null>(null);
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMessage, setForgotMessage] = useState('');
  // 初回読み込みはユーザー×プロジェクトで1回だけ（言語切替で callApi の
  // 参照が変わっても、未保存のフォーム内容を読み直して消さないため）。
  const loadedForRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(`event-locale:${eventId}`);
      if (stored) setLocale(normalizeLocale(stored));
    } catch {
      // 保存が読めなくても日本語で続行する
    }
  }, [eventId]);

  // ヘッダーに出すプロジェクト名は公開情報から取る（ログイン前の画面でも出すため）
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/public`);
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (typeof data.event?.name === 'string') setEventName(data.event.name);
        if (typeof data.event?.themeColor === 'string') {
          setThemeColor(data.event.themeColor);
        }
      } catch {
        // 取れなければヘッダーは空のまま（画面の動作には影響しない）
      }
    })();
  }, [eventId]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  const callApi = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!user) throw new Error(redeemText(locale, 'loginRequired'));
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
          ...(init?.headers ?? {}),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(data.error ?? redeemText(locale, 'apiError', { status: String(res.status) }));
      return data;
    },
    [user, locale],
  );

  useEffect(() => {
    if (!user) return;
    const loadKey = `${user.uid}:${eventId}`;
    if (loadedForRef.current === loadKey) return;
    loadedForRef.current = loadKey;
    (async () => {
      try {
        const me = await callApi(`/api/events/${eventId}/exhibitor-me`);
        setExhibitor(me.exhibitor);
        if (me.exhibitor?.lang) setLocale(normalizeLocale(me.exhibitor.lang));
        setExhibitorError('');
        // 協賛（広告専用）アカウントはプロフィールもトップ掲載も持たない
        // ため読み込まない（広告の状態だけを読む）。
        const isAdvertiserAccount = me.exhibitor?.kind === 'advertiser';
        if (!isAdvertiserAccount) {
          const data = await callApi(`/api/events/${eventId}/shop-profile`);
          if (data.profile) setProfile({ ...EMPTY_PROFILE, ...data.profile });
          // トップ掲載の状態は取れなくても画面は出す（カードを出さないだけ）
          try {
            const placementData = await callApi(
              `/api/events/${eventId}/top-placement`,
            );
            setPlacement(placementData as TopPlacementState);
          } catch {
            setPlacement(null);
          }
          // 自店クーポンとプッシュ申請の状態も同様（取れなければ
          // カードを出さないだけ）。
          try {
            const couponsData = (await callApi(
              `/api/events/${eventId}/shop-coupons`,
            )) as ShopCouponsState;
            setShopCoupons(couponsData);
          } catch {
            setShopCoupons(null);
          }
          try {
            const pushData = (await callApi(
              `/api/events/${eventId}/shop-push-requests`,
            )) as ShopPushRequestsState;
            setShopPushRequests(pushData);
          } catch {
            setShopPushRequests(null);
          }
        }
        // 広告の状態も同様（取れなければ広告カードを出さないだけ）。
        // フォームの初期値は掲載版→申請版の順で引き継ぐ。
        try {
          const adData = (await callApi(
            `/api/events/${eventId}/shop-ad`,
          )) as ShopAdState;
          setShopAd(adData);
          setAdForm(
            adData.ad.pending ??
              adData.ad.live ?? { ...EMPTY_AD_CONTENT },
          );
        } catch {
          setShopAd(null);
        }
      } catch (e) {
        setExhibitor(null);
        setExhibitorError(
          e instanceof Error ? e.message : redeemText(locale, 'exhibitorLoadFailed'),
        );
      }
    })();
    // locale は初期言語の確定にだけ使う
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, eventId, callApi]);

  // Stripe Checkout から戻ってきたときの結果表示（成功／キャンセル）。
  // 掲載の確定は Webhook 経由のため、成功時は「受付済み」の案内にする。
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const result = params.get('placement');
      if (result === 'success') {
        setPlacementMessage(redeemText(locale, 'topPlacementSubscribeMessage'));
      } else if (result === 'canceled') {
        setPlacementMessage(redeemText(locale, 'topPlacementCheckoutCanceled'));
      }
      const adResult = params.get('ad');
      if (adResult === 'success') {
        setAdMessage(redeemText(locale, 'adSubscribeMessage'));
      } else if (adResult === 'canceled') {
        setAdMessage(redeemText(locale, 'adCheckoutCanceled'));
      }
      // クーポン発行／プッシュ申請の1回払いから戻ってきた場合。
      // 成功時は session_id を退避し、ログイン後にサーバーで確認する。
      const chargeResult = params.get('charge');
      if (chargeResult === 'success') {
        const sessionId = params.get('session_id');
        if (sessionId) chargeReturnRef.current = sessionId;
      } else if (chargeResult === 'canceled') {
        setChargeMessage(redeemText(locale, 'chargeCanceledMessage'));
      }
    } catch {
      // 読めなければ案内なしで続行する
    }
    // 初回マウント時だけ（言語は初期値でよい）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadShopCoupons = useCallback(async () => {
    const data = (await callApi(
      `/api/events/${eventId}/shop-coupons`,
    )) as ShopCouponsState;
    setShopCoupons(data);
    return data;
  }, [callApi, eventId]);

  const reloadShopPushRequests = useCallback(async () => {
    const data = (await callApi(
      `/api/events/${eventId}/shop-push-requests`,
    )) as ShopPushRequestsState;
    setShopPushRequests(data);
    return data;
  }, [callApi, eventId]);

  // Checkout の成功リターン: サーバー側で支払いを確認し、対象
  // （クーポンの有効化／プッシュ申請の承認待ち化）を反映する。
  // Webhook でも同じ処理が走るため、二重に走っても問題ない。
  useEffect(() => {
    if (!user || !exhibitor || exhibitor.kind === 'advertiser') return;
    const sessionId = chargeReturnRef.current;
    if (!sessionId || chargeVerifiedRef.current) return;
    chargeVerifiedRef.current = true;
    (async () => {
      try {
        const data = await callApi(`/api/events/${eventId}/shop-charges/verify`, {
          method: 'POST',
          body: JSON.stringify({ sessionId }),
        });
        setChargeMessage(
          redeemText(
            locale,
            data.kind === 'push-send'
              ? 'chargeSuccessPushMessage'
              : 'chargeSuccessCouponMessage',
          ),
        );
      } catch {
        setChargeMessage(redeemText(locale, 'chargeVerifyFailedMessage'));
      }
      try {
        await reloadShopCoupons();
      } catch {
        // 一覧の再読込失敗は案内を妨げない
      }
      try {
        await reloadShopPushRequests();
      } catch {
        // 同上
      }
    })();
  }, [user, exhibitor, eventId, callApi, locale, reloadShopCoupons, reloadShopPushRequests]);

  const handleCouponCreate = async () => {
    setCouponBusy(true);
    setCouponMessage('');
    try {
      const keywords = couponForm.keywords
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k.length > 0);
      const data = await callApi(`/api/events/${eventId}/shop-coupons`, {
        method: 'POST',
        body: JSON.stringify({
          title: couponForm.title,
          description: couponForm.description,
          keywords,
        }),
      });
      if (typeof data.checkoutUrl === 'string') {
        window.location.href = data.checkoutUrl;
        return;
      }
      setCouponForm({ title: '', description: '', keywords: '' });
      await reloadShopCoupons();
      setCouponMessage(
        data.coupon?.paymentPending
          ? redeemText(locale, 'chargePayFailed')
          : data.coupon?.approvalStatus === 'pending'
            ? redeemText(locale, 'couponIssuedPendingApproval')
            : redeemText(locale, 'couponIssuedMessage'),
      );
    } catch (e) {
      setCouponMessage(
        e instanceof Error ? e.message : redeemText(locale, 'couponIssueFailed'),
      );
    } finally {
      setCouponBusy(false);
    }
  };

  const handleCouponPay = async (couponId: string) => {
    setCouponBusy(true);
    setCouponMessage('');
    try {
      const data = await callApi(
        `/api/events/${eventId}/shop-coupons/${couponId}/checkout`,
        { method: 'POST' },
      );
      if (typeof data.checkoutUrl !== 'string') throw new Error('no checkout url');
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setCouponMessage(
        e instanceof Error ? e.message : redeemText(locale, 'chargePayFailed'),
      );
      setCouponBusy(false);
    }
  };

  const handlePushRequestCreate = async () => {
    setPushBusy(true);
    setPushMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/shop-push-requests`, {
        method: 'POST',
        body: JSON.stringify({ title: pushForm.title, body: pushForm.body }),
      });
      if (typeof data.checkoutUrl === 'string') {
        window.location.href = data.checkoutUrl;
        return;
      }
      setPushForm({ title: '', body: '' });
      await reloadShopPushRequests();
      setPushMessage(
        data.request?.status === 'unpaid'
          ? redeemText(locale, 'chargePayFailed')
          : redeemText(locale, 'pushRequestedMessage'),
      );
    } catch (e) {
      setPushMessage(
        e instanceof Error ? e.message : redeemText(locale, 'pushRequestFailed'),
      );
    } finally {
      setPushBusy(false);
    }
  };

  const handlePushRequestPay = async (requestId: string) => {
    setPushBusy(true);
    setPushMessage('');
    try {
      const data = await callApi(
        `/api/events/${eventId}/shop-push-requests/${requestId}/checkout`,
        { method: 'POST' },
      );
      if (typeof data.checkoutUrl !== 'string') throw new Error('no checkout url');
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setPushMessage(
        e instanceof Error ? e.message : redeemText(locale, 'chargePayFailed'),
      );
      setPushBusy(false);
    }
  };

  const handlePlacementSubscribe = async () => {
    setPlacementBusy(true);
    setPlacementMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/top-placement/checkout`, {
        method: 'POST',
      });
      if (typeof data.checkoutUrl !== 'string') throw new Error('no checkout url');
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setPlacementMessage(
        e instanceof Error
          ? e.message
          : redeemText(locale, 'topPlacementSubscribeFailed'),
      );
      setPlacementBusy(false);
    }
  };

  const handlePlacementCancel = async () => {
    setPlacementBusy(true);
    setPlacementMessage('');
    try {
      await callApi(`/api/events/${eventId}/top-placement/cancel`, {
        method: 'POST',
      });
      const placementData = await callApi(`/api/events/${eventId}/top-placement`);
      setPlacement(placementData as TopPlacementState);
      setPlacementMessage(redeemText(locale, 'topPlacementCancelMessage'));
    } catch (e) {
      setPlacementMessage(
        e instanceof Error
          ? e.message
          : redeemText(locale, 'topPlacementCancelFailed'),
      );
    } finally {
      setPlacementBusy(false);
    }
  };

  // 無料（料金 0）の間の参加表明。有料の間はこの操作自体が無い。
  const handlePlacementOptIn = async (optedIn: boolean) => {
    setPlacementBusy(true);
    setPlacementMessage('');
    try {
      await callApi(`/api/events/${eventId}/top-placement/opt-in`, {
        method: 'POST',
        body: JSON.stringify({ optedIn }),
      });
      const placementData = await callApi(`/api/events/${eventId}/top-placement`);
      setPlacement(placementData as TopPlacementState);
    } catch (e) {
      setPlacementMessage(
        e instanceof Error
          ? e.message
          : redeemText(locale, 'topPlacementOptInFailed'),
      );
    } finally {
      setPlacementBusy(false);
    }
  };

  const reloadShopAd = async () => {
    const adData = (await callApi(
      `/api/events/${eventId}/shop-ad`,
    )) as ShopAdState;
    setShopAd(adData);
    return adData;
  };

  const handleAdSubscribe = async () => {
    setAdBusy(true);
    setAdMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/shop-ad/checkout`, {
        method: 'POST',
      });
      if (typeof data.checkoutUrl !== 'string') throw new Error('no checkout url');
      window.location.href = data.checkoutUrl;
    } catch (e) {
      setAdMessage(
        e instanceof Error ? e.message : redeemText(locale, 'adSubscribeFailed'),
      );
      setAdBusy(false);
    }
  };

  const handleAdCancel = async () => {
    setAdBusy(true);
    setAdMessage('');
    try {
      await callApi(`/api/events/${eventId}/shop-ad/cancel`, {
        method: 'POST',
      });
      await reloadShopAd();
      setAdMessage(redeemText(locale, 'adCancelMessage'));
    } catch (e) {
      setAdMessage(
        e instanceof Error ? e.message : redeemText(locale, 'adCancelFailed'),
      );
    } finally {
      setAdBusy(false);
    }
  };

  const handleAdSubmit = async () => {
    setAdBusy(true);
    setAdMessage('');
    try {
      await callApi(`/api/events/${eventId}/shop-ad`, {
        method: 'PUT',
        body: JSON.stringify(adForm),
      });
      await reloadShopAd();
      setAdMessage(redeemText(locale, 'adSubmittedMessage'));
    } catch (e) {
      setAdMessage(
        e instanceof Error ? e.message : redeemText(locale, 'adSubmitFailed'),
      );
    } finally {
      setAdBusy(false);
    }
  };

  const handleAdPhotoSelect = async (file: File | undefined) => {
    if (!file || !user) return;
    setAdPhotoUploading(true);
    setAdMessage('');
    try {
      const idToken = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('purpose', 'ad');
      const res = await fetch(`/api/events/${eventId}/shop-profile/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== 'string') {
        throw new Error(data.error ?? redeemText(locale, 'profilePhotoFailed'));
      }
      setAdForm((current) => ({ ...current, imageUrl: data.url }));
    } catch (e) {
      setAdMessage(
        e instanceof Error ? e.message : redeemText(locale, 'profilePhotoFailed'),
      );
    } finally {
      setAdPhotoUploading(false);
    }
  };

  const handleLocaleChange = async (next: Locale) => {
    setLocale(next);
    try {
      window.localStorage.setItem(`event-locale:${eventId}`, next);
    } catch {
      // 保存できなくても画面の切替は有効にする
    }
    if (user && exhibitor) {
      try {
        await callApi(`/api/events/${eventId}/exhibitor-me`, {
          method: 'PATCH',
          body: JSON.stringify({ lang: next }),
        });
      } catch {
        // 保存に失敗しても画面の切替は止めない
      }
    }
  };

  const languagePills = (
    <div
      role="group"
      aria-label={uiText(locale, 'language')}
      style={{
        display: 'inline-flex',
        backgroundColor: '#eef1f5',
        borderRadius: 999,
        padding: 3,
        gap: 2,
        flexShrink: 0,
      }}
    >
      {SUPPORTED_LOCALES.map((l) => {
        const selected = l === locale;
        return (
          <button
            key={l}
            onClick={() => void handleLocaleChange(l)}
            aria-pressed={selected}
            style={{
              padding: '6px 12px',
              fontSize: 13.5,
              fontWeight: 700,
              borderRadius: 999,
              border: 'none',
              backgroundColor: selected ? VIOLET : 'transparent',
              color: selected ? '#ffffff' : '#475569',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {PILL_LABELS[l]}
          </button>
        );
      })}
    </div>
  );

  const brandRow = (right?: React.ReactNode) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
      }}
    >
      <p style={{ fontSize: 21, fontWeight: 800, color: VIOLET, margin: 0, letterSpacing: -0.2 }}>
        {eventName}
      </p>
      {right}
    </div>
  );

  const handleLogin = async () => {
    setBusy(true);
    setLoginError('');
    try {
      // 消込画面と同じ作法: メール+パスワード（コード）をサーバーで照合し、
      // 返ってきたカスタムトークンでセッションを作る。
      const res = await fetch(`/api/events/${eventId}/exhibitor-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.customToken !== 'string') {
        throw new Error('login failed');
      }
      await signInWithCustomToken(auth, data.customToken);
    } catch {
      setLoginError(redeemText(locale, 'loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleForgotPassword = async () => {
    if (!email.trim()) {
      setForgotMessage(redeemText(locale, 'forgotPasswordNeedEmail'));
      return;
    }
    setForgotBusy(true);
    setForgotMessage('');
    try {
      const res = await fetch(`/api/events/${eventId}/exhibitor-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error('request failed');
      setForgotMessage(redeemText(locale, 'forgotPasswordDone'));
    } catch {
      setForgotMessage(redeemText(locale, 'forgotPasswordFailed'));
    } finally {
      setForgotBusy(false);
    }
  };

  const updateField = (field: keyof ShopProfile, value: string | boolean) => {
    setProfile((current) => ({ ...current, [field]: value }));
  };

  const handlePhotoSelect = async (file: File | undefined) => {
    if (!file || !user) return;
    setPhotoUploading(true);
    setMessage('');
    try {
      const idToken = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/events/${eventId}/shop-profile/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== 'string') {
        throw new Error(data.error ?? redeemText(locale, 'profilePhotoFailed'));
      }
      setProfile((current) => ({
        ...current,
        photoUrls: [...current.photoUrls, data.url].slice(0, PHOTO_MAX),
      }));
    } catch (e) {
      setMessageOk(false);
      setMessage(
        e instanceof Error ? e.message : redeemText(locale, 'profilePhotoFailed'),
      );
    } finally {
      setPhotoUploading(false);
    }
  };

  const handleRemovePhoto = (index: number) => {
    setProfile((current) => ({
      ...current,
      photoUrls: current.photoUrls.filter((_, i) => i !== index),
    }));
  };

  const handleCoverPhotoSelect = async (file: File | undefined) => {
    if (!file || !user) return;
    setCoverPhotoUploading(true);
    setMessage('');
    try {
      const idToken = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('purpose', 'cover');
      const res = await fetch(`/api/events/${eventId}/shop-profile/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== 'string') {
        throw new Error(data.error ?? redeemText(locale, 'profilePhotoFailed'));
      }
      setProfile((current) => ({ ...current, coverImageUrl: data.url }));
    } catch (e) {
      setMessageOk(false);
      setMessage(
        e instanceof Error ? e.message : redeemText(locale, 'profilePhotoFailed'),
      );
    } finally {
      setCoverPhotoUploading(false);
    }
  };

  const handleRemoveCoverPhoto = () => {
    setProfile((current) => ({ ...current, coverImageUrl: null }));
  };

  const updateFreeDish = (field: keyof ShopFreeDish, value: string | null) => {
    setProfile((current) => ({
      ...current,
      freeDish: { ...(current.freeDish ?? EMPTY_FREE_DISH), [field]: value },
    }));
  };

  const updateLoginReward = (field: keyof ShopFreeDish, value: string | null) => {
    setProfile((current) => ({
      ...current,
      loginReward: { ...(current.loginReward ?? EMPTY_FREE_DISH), [field]: value },
    }));
  };

  const handleLoginRewardPhotoSelect = async (file: File | undefined) => {
    if (!file || !user) return;
    setLoginRewardPhotoUploading(true);
    setMessage('');
    try {
      const idToken = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('purpose', 'login-reward');
      const res = await fetch(`/api/events/${eventId}/shop-profile/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== 'string') {
        throw new Error(data.error ?? redeemText(locale, 'profilePhotoFailed'));
      }
      updateLoginReward('photoUrl', data.url);
    } catch (e) {
      setMessageOk(false);
      setMessage(
        e instanceof Error ? e.message : redeemText(locale, 'profilePhotoFailed'),
      );
    } finally {
      setLoginRewardPhotoUploading(false);
    }
  };

  const handleFreeDishPhotoSelect = async (file: File | undefined) => {
    if (!file || !user) return;
    setFreeDishPhotoUploading(true);
    setMessage('');
    try {
      const idToken = await user.getIdToken();
      const formData = new FormData();
      formData.append('file', file);
      formData.append('purpose', 'free-dish');
      const res = await fetch(`/api/events/${eventId}/shop-profile/photo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || typeof data.url !== 'string') {
        throw new Error(data.error ?? redeemText(locale, 'profilePhotoFailed'));
      }
      updateFreeDish('photoUrl', data.url);
    } catch (e) {
      setMessageOk(false);
      setMessage(
        e instanceof Error ? e.message : redeemText(locale, 'profilePhotoFailed'),
      );
    } finally {
      setFreeDishPhotoUploading(false);
    }
  };

  const updateLink = (index: number, field: keyof ShopLink, value: string) => {
    setProfile((current) => ({
      ...current,
      links: current.links.map((link, i) =>
        i === index ? { ...link, [field]: value } : link,
      ),
    }));
  };

  const handleAddLink = () => {
    setProfile((current) => ({
      ...current,
      links: [...current.links, { label: '', url: '' }].slice(0, LINK_MAX),
    }));
  };

  const handleRemoveLink = (index: number) => {
    setProfile((current) => ({
      ...current,
      links: current.links.filter((_, i) => i !== index),
    }));
  };

  const handleSave = async () => {
    setBusy(true);
    setMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/shop-profile`, {
        method: 'PUT',
        body: JSON.stringify(profile),
      });
      if (data.profile) setProfile({ ...EMPTY_PROFILE, ...data.profile });
      setMessageOk(true);
      setMessage(redeemText(locale, 'profileSaved'));
    } catch (e) {
      setMessageOk(false);
      setMessage(
        e instanceof Error ? e.message : redeemText(locale, 'profileSaveFailed'),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!authReady) return <main style={containerStyle}>{uiText(locale, 'loading')}</main>;

  if (!user) {
    return (
      <main style={{ ...containerStyle, ...themeCssVars(themeColor) } as React.CSSProperties}>
        {brandRow(languagePills)}
        <h1 style={{ fontSize: 20, fontWeight: 800, margin: '18px 0 0' }}>
          {redeemText(locale, 'shopLoginTitle')}
        </h1>
        <section style={{ ...cardStyle, padding: 16, marginTop: 14 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
            {redeemText(locale, 'emailLabel')}
            <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginTop: 12 }}>
            {redeemText(locale, 'passwordLabel')}
            <PasswordInput style={inputStyle} value={password} onChange={setPassword} autoComplete="current-password" />
          </label>
          <button
            onClick={handleLogin}
            disabled={busy}
            style={{ ...primaryButtonStyle, marginTop: 20, opacity: busy ? 0.6 : 1 }}
          >
            {redeemText(locale, 'loginButton')}
          </button>
          <button
            onClick={() => void handleForgotPassword()}
            disabled={forgotBusy}
            style={{
              display: 'block',
              margin: '14px auto 0',
              padding: 0,
              background: 'none',
              border: 'none',
              color: VIOLET,
              fontSize: 13.5,
              fontWeight: 600,
              textDecoration: 'underline',
              cursor: 'pointer',
              opacity: forgotBusy ? 0.6 : 1,
            }}
          >
            {redeemText(locale, 'forgotPasswordLink')}
          </button>
          {forgotMessage && (
            <p style={{ fontSize: 13.5, color: '#334155', marginTop: 10, textAlign: 'center' }}>
              {forgotMessage}
            </p>
          )}
          {loginError && (
            <p style={{ fontSize: 14, fontWeight: 600, color: '#b91c1c', marginTop: 12 }}>
              {loginError}
            </p>
          )}
        </section>
        <PoweredByFooter />
      </main>
    );
  }

  // 協賛（広告専用）アカウントには広告の画面だけを出す
  const isAdvertiser = exhibitor?.kind === 'advertiser';

  return (
    <main style={{ ...containerStyle, ...themeCssVars(themeColor) } as React.CSSProperties}>
      {brandRow(
        <button onClick={() => void signOut(auth)} style={logoutButtonStyle}>
          {redeemText(locale, 'logoutButton')}
        </button>,
      )}

      {exhibitorError && (
        <>
          {!exhibitor && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
              {languagePills}
            </div>
          )}
          <div
            style={{
              ...cardStyle,
              marginTop: 12,
              padding: '14px 16px',
              fontSize: 15,
              fontWeight: 600,
              color: '#b91c1c',
              backgroundColor: '#fef2f2',
              border: '1px solid #fecaca',
            }}
          >
            {exhibitorError}
            {redeemText(locale, 'exhibitorErrorNote')}
          </div>
        </>
      )}

      {exhibitor && (
        <>
          <section
            style={{
              ...cardStyle,
              padding: '12px 14px',
              marginTop: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <p style={{ fontSize: 16.5, fontWeight: 800, margin: 0, flex: 1, minWidth: 110 }}>
              {exhibitor.name}
            </p>
            {languagePills}
          </section>

          {isAdvertiser && (
            <p style={{ fontSize: 13.5, color: '#475569', marginTop: 14 }}>
              {redeemText(locale, 'advertiserNote')}
            </p>
          )}

          {!isAdvertiser && (
            <>
          <h1 style={{ fontSize: 19, fontWeight: 800, margin: '20px 0 0' }}>
            {redeemText(locale, 'shopPageTitle')}
          </h1>
          <p style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>
            {redeemText(locale, 'shopProfileNote')}
          </p>
          <p style={{ marginTop: 8 }}>
            <a
              href={`/e/${eventId}/redeem`}
              style={{ fontSize: 13.5, fontWeight: 600, color: VIOLET }}
            >
              {redeemText(locale, 'toRedeemPage')}
            </a>
          </p>
          <p style={{ marginTop: 6 }}>
            <a
              href={specialSiteShopUrl(eventId, exhibitor.id)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13.5, fontWeight: 600, color: VIOLET }}
            >
              {redeemText(locale, 'specialSiteShopLink')} ↗
            </a>
          </p>
          <p style={{ marginTop: 4 }}>
            <a
              href={specialSiteUrl(eventId)}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 13.5, fontWeight: 600, color: VIOLET }}
            >
              {redeemText(locale, 'specialSiteTopLink')} ↗
            </a>
          </p>

          <section style={{ ...cardStyle, padding: 16, marginTop: 12 }}>
            <label style={{ ...labelStyle, marginTop: 0 }}>
              {redeemText(locale, 'profileDisplayName')}
              <input
                style={inputStyle}
                value={profile.displayName}
                onChange={(e) => updateField('displayName', e.target.value)}
              />
            </label>
            <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
              {redeemText(locale, 'profileDisplayNameNote', { name: exhibitor.name })}
            </p>
            <label style={labelStyle}>
              {redeemText(locale, 'profileAddress')}
              <input
                style={inputStyle}
                value={profile.address}
                onChange={(e) => updateField('address', e.target.value)}
              />
            </label>
            <label style={labelStyle}>
              {redeemText(locale, 'profilePhone')}
              <input
                style={inputStyle}
                type="tel"
                value={profile.phone}
                onChange={(e) => updateField('phone', e.target.value)}
              />
            </label>
            <label style={labelStyle}>
              {redeemText(locale, 'profileHours')}
              <input
                style={inputStyle}
                value={profile.hoursText}
                placeholder={redeemText(locale, 'profileHoursPlaceholder')}
                onChange={(e) => updateField('hoursText', e.target.value)}
              />
            </label>
            <label style={labelStyle}>
              {redeemText(locale, 'profileMenuName')}
              <input
                style={inputStyle}
                value={profile.menuName}
                onChange={(e) => updateField('menuName', e.target.value)}
              />
            </label>
            <label style={labelStyle}>
              {redeemText(locale, 'profileMenuDescription')}
              <textarea
                style={{ ...inputStyle, minHeight: 72 }}
                value={profile.menuDescription}
                onChange={(e) => updateField('menuDescription', e.target.value)}
              />
            </label>

            <div
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '12px 14px 14px',
                marginTop: 16,
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                {redeemText(locale, 'profileFreeDishTitle')}
              </p>
              <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                {redeemText(locale, 'profileFreeDishNote')}
              </p>
              <label style={labelStyle}>
                {redeemText(locale, 'profileFreeDishName')}
                <input
                  style={inputStyle}
                  value={(profile.freeDish ?? EMPTY_FREE_DISH).name}
                  onChange={(e) => updateFreeDish('name', e.target.value)}
                />
              </label>
              <label style={labelStyle}>
                {redeemText(locale, 'profileFreeDishDescription')}
                <textarea
                  style={{ ...inputStyle, minHeight: 60 }}
                  value={(profile.freeDish ?? EMPTY_FREE_DISH).description}
                  onChange={(e) => updateFreeDish('description', e.target.value)}
                />
              </label>
              {(profile.freeDish ?? EMPTY_FREE_DISH).photoUrl ? (
                <div style={{ width: 96, marginTop: 12 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={(profile.freeDish ?? EMPTY_FREE_DISH).photoUrl ?? ''}
                    alt=""
                    style={{
                      width: 96,
                      height: 96,
                      objectFit: 'cover',
                      borderRadius: 10,
                      border: '1px solid #e2e8f0',
                      display: 'block',
                    }}
                  />
                  <button
                    onClick={() => updateFreeDish('photoUrl', null)}
                    style={{
                      width: '100%',
                      marginTop: 6,
                      padding: '5px 0',
                      fontSize: 12.5,
                      fontWeight: 600,
                      borderRadius: 8,
                      border: '1px solid #fca5a5',
                      backgroundColor: '#ffffff',
                      color: '#b91c1c',
                      cursor: 'pointer',
                    }}
                  >
                    {redeemText(locale, 'profilePhotoRemove')}
                  </button>
                </div>
              ) : (
                <label
                  style={{
                    display: 'inline-block',
                    marginTop: 12,
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    borderRadius: 10,
                    border: `1px solid ${VIOLET}`,
                    color: VIOLET,
                    backgroundColor: '#ffffff',
                    cursor: freeDishPhotoUploading ? 'wait' : 'pointer',
                    opacity: freeDishPhotoUploading ? 0.6 : 1,
                  }}
                >
                  {redeemText(locale, 'profilePhotoAdd')}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    disabled={freeDishPhotoUploading}
                    onChange={(e) => {
                      void handleFreeDishPhotoSelect(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>

            <div
              style={{
                border: '1px solid #e2e8f0',
                borderRadius: 12,
                padding: '12px 14px 14px',
                marginTop: 16,
              }}
            >
              <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                {redeemText(locale, 'profileLoginRewardTitle')}
              </p>
              <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                {redeemText(locale, 'profileLoginRewardNote')}
              </p>
              <label style={labelStyle}>
                {redeemText(locale, 'profileLoginRewardName')}
                <input
                  style={inputStyle}
                  value={(profile.loginReward ?? EMPTY_FREE_DISH).name}
                  onChange={(e) => updateLoginReward('name', e.target.value)}
                />
              </label>
              <label style={labelStyle}>
                {redeemText(locale, 'profileLoginRewardDescription')}
                <textarea
                  style={{ ...inputStyle, minHeight: 60 }}
                  value={(profile.loginReward ?? EMPTY_FREE_DISH).description}
                  onChange={(e) => updateLoginReward('description', e.target.value)}
                />
              </label>
              {(profile.loginReward ?? EMPTY_FREE_DISH).photoUrl ? (
                <div style={{ width: 96, marginTop: 12 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={(profile.loginReward ?? EMPTY_FREE_DISH).photoUrl ?? ''}
                    alt=""
                    style={{
                      width: 96,
                      height: 96,
                      objectFit: 'cover',
                      borderRadius: 10,
                      border: '1px solid #e2e8f0',
                      display: 'block',
                    }}
                  />
                  <button
                    onClick={() => updateLoginReward('photoUrl', null)}
                    style={{
                      width: '100%',
                      marginTop: 6,
                      padding: '5px 0',
                      fontSize: 12.5,
                      fontWeight: 600,
                      borderRadius: 8,
                      border: '1px solid #fca5a5',
                      backgroundColor: '#ffffff',
                      color: '#b91c1c',
                      cursor: 'pointer',
                    }}
                  >
                    {redeemText(locale, 'profilePhotoRemove')}
                  </button>
                </div>
              ) : (
                <label
                  style={{
                    display: 'inline-block',
                    marginTop: 12,
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    borderRadius: 10,
                    border: `1px solid ${VIOLET}`,
                    color: VIOLET,
                    backgroundColor: '#ffffff',
                    cursor: loginRewardPhotoUploading ? 'wait' : 'pointer',
                    opacity: loginRewardPhotoUploading ? 0.6 : 1,
                  }}
                >
                  {redeemText(locale, 'profilePhotoAdd')}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    disabled={loginRewardPhotoUploading}
                    onChange={(e) => {
                      void handleLoginRewardPhotoSelect(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>

            <label style={labelStyle}>
              {redeemText(locale, 'profileDescription')}
              <textarea
                style={{ ...inputStyle, minHeight: 96 }}
                value={profile.description}
                onChange={(e) => updateField('description', e.target.value)}
              />
            </label>

            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                {redeemText(locale, 'profileCoverImage')}
              </p>
              <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                {redeemText(locale, 'profileCoverImageNote')}
              </p>
              {profile.coverImageUrl ? (
                <div style={{ marginTop: 10 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={profile.coverImageUrl}
                    alt=""
                    style={{
                      width: '100%',
                      height: 180,
                      objectFit: 'cover',
                      borderRadius: 10,
                      border: '1px solid #e2e8f0',
                      display: 'block',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <label
                      style={{
                        padding: '6px 14px',
                        fontSize: 12.5,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: `1px solid ${VIOLET}`,
                        backgroundColor: '#ffffff',
                        color: VIOLET,
                        cursor: coverPhotoUploading ? 'wait' : 'pointer',
                        opacity: coverPhotoUploading ? 0.6 : 1,
                      }}
                    >
                      {redeemText(locale, 'profileCoverImageReplace')}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        style={{ display: 'none' }}
                        disabled={coverPhotoUploading}
                        onChange={(e) => {
                          void handleCoverPhotoSelect(e.target.files?.[0]);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <button
                      onClick={handleRemoveCoverPhoto}
                      style={{
                        padding: '6px 14px',
                        fontSize: 12.5,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: '1px solid #fca5a5',
                        backgroundColor: '#ffffff',
                        color: '#b91c1c',
                        cursor: 'pointer',
                      }}
                    >
                      {redeemText(locale, 'profilePhotoRemove')}
                    </button>
                  </div>
                </div>
              ) : (
                <label
                  style={{
                    display: 'inline-block',
                    marginTop: 10,
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    borderRadius: 10,
                    border: `1px solid ${VIOLET}`,
                    color: VIOLET,
                    backgroundColor: '#ffffff',
                    cursor: coverPhotoUploading ? 'wait' : 'pointer',
                    opacity: coverPhotoUploading ? 0.6 : 1,
                  }}
                >
                  {redeemText(locale, 'profilePhotoAdd')}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    disabled={coverPhotoUploading}
                    onChange={(e) => {
                      void handleCoverPhotoSelect(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>

            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                {redeemText(locale, 'profilePhotos')}
              </p>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
                {profile.photoUrls.map((url, index) => (
                  <div key={url} style={{ width: 96 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt=""
                      style={{
                        width: 96,
                        height: 96,
                        objectFit: 'cover',
                        borderRadius: 10,
                        border: '1px solid #e2e8f0',
                        display: 'block',
                      }}
                    />
                    <button
                      onClick={() => handleRemovePhoto(index)}
                      style={{
                        width: '100%',
                        marginTop: 6,
                        padding: '5px 0',
                        fontSize: 12.5,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: '1px solid #fca5a5',
                        backgroundColor: '#ffffff',
                        color: '#b91c1c',
                        cursor: 'pointer',
                      }}
                    >
                      {redeemText(locale, 'profilePhotoRemove')}
                    </button>
                  </div>
                ))}
              </div>
              {profile.photoUrls.length < PHOTO_MAX && (
                <label
                  style={{
                    display: 'inline-block',
                    marginTop: 10,
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    borderRadius: 10,
                    border: `1px solid ${VIOLET}`,
                    color: VIOLET,
                    backgroundColor: '#ffffff',
                    cursor: photoUploading ? 'wait' : 'pointer',
                    opacity: photoUploading ? 0.6 : 1,
                  }}
                >
                  {redeemText(locale, 'profilePhotoAdd')}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    style={{ display: 'none' }}
                    disabled={photoUploading}
                    onChange={(e) => {
                      void handlePhotoSelect(e.target.files?.[0]);
                      e.target.value = '';
                    }}
                  />
                </label>
              )}
            </div>

            <label style={labelStyle}>
              {redeemText(locale, 'profileInstagram')}
              <input
                style={inputStyle}
                type="url"
                placeholder="https://"
                value={profile.instagramUrl}
                onChange={(e) => updateField('instagramUrl', e.target.value)}
              />
            </label>

            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                {redeemText(locale, 'profileLinks')}
              </p>
              <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                {redeemText(locale, 'profileLinksNote')}
              </p>
              {profile.links.map((link, index) => (
                <div
                  key={index}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    padding: '10px 12px 12px',
                    marginTop: 10,
                  }}
                >
                  <label style={{ ...labelStyle, marginTop: 0 }}>
                    {redeemText(locale, 'profileLinkLabel')}
                    <input
                      style={inputStyle}
                      value={link.label}
                      placeholder={redeemText(locale, 'profileLinkLabelPlaceholder')}
                      onChange={(e) => updateLink(index, 'label', e.target.value)}
                    />
                  </label>
                  <label style={labelStyle}>
                    {redeemText(locale, 'profileLinkUrl')}
                    <input
                      style={inputStyle}
                      type="url"
                      placeholder="https://"
                      value={link.url}
                      onChange={(e) => updateLink(index, 'url', e.target.value)}
                    />
                  </label>
                  <button
                    onClick={() => handleRemoveLink(index)}
                    style={{
                      marginTop: 10,
                      padding: '5px 12px',
                      fontSize: 12.5,
                      fontWeight: 600,
                      borderRadius: 8,
                      border: '1px solid #fca5a5',
                      backgroundColor: '#ffffff',
                      color: '#b91c1c',
                      cursor: 'pointer',
                    }}
                  >
                    {redeemText(locale, 'profilePhotoRemove')}
                  </button>
                </div>
              ))}
              {profile.links.length < LINK_MAX && (
                <button
                  onClick={handleAddLink}
                  style={{
                    marginTop: 10,
                    padding: '10px 16px',
                    fontSize: 14,
                    fontWeight: 700,
                    borderRadius: 10,
                    border: `1px solid ${VIOLET}`,
                    color: VIOLET,
                    backgroundColor: '#ffffff',
                    cursor: 'pointer',
                  }}
                >
                  {redeemText(locale, 'profileLinkAdd')}
                </button>
              )}
            </div>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                fontWeight: 600,
                marginTop: 16,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={profile.published}
                onChange={(e) => updateField('published', e.target.checked)}
                style={{ width: 18, height: 18 }}
              />
              {redeemText(locale, 'profilePublished')}
            </label>

            <button
              onClick={() => void handleSave()}
              disabled={busy}
              style={{ ...primaryButtonStyle, marginTop: 20, opacity: busy ? 0.6 : 1 }}
            >
              {redeemText(locale, 'profileSaveButton')}
            </button>
            {message && (
              <p
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: messageOk ? '#15803d' : '#b91c1c',
                  marginTop: 12,
                }}
              >
                {message}
              </p>
            )}
          </section>
            </>
          )}

          {!isAdvertiser && placement && (placement.freeMode || placement.featured || placement.available) && (
            <section style={{ ...cardStyle, padding: 16, marginTop: 16 }}>
              <h2 style={{ fontSize: 16.5, fontWeight: 800, margin: 0 }}>
                {redeemText(locale, 'topPlacementTitle')}
              </h2>
              {placement.freeMode ? (
                placement.optedIn ? (
                  <>
                    <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                      {redeemText(locale, 'topPlacementOptedInNote')}
                    </p>
                    <button
                      onClick={() => void handlePlacementOptIn(false)}
                      disabled={placementBusy}
                      style={{
                        marginTop: 12,
                        padding: '9px 16px',
                        fontSize: 13.5,
                        fontWeight: 700,
                        borderRadius: 10,
                        border: '1px solid #fca5a5',
                        backgroundColor: '#ffffff',
                        color: '#b91c1c',
                        cursor: 'pointer',
                        opacity: placementBusy ? 0.6 : 1,
                      }}
                    >
                      {redeemText(locale, 'topPlacementOptOutButton')}
                    </button>
                  </>
                ) : (
                  <>
                    <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                      {redeemText(locale, 'topPlacementOptInNote')}
                    </p>
                    <p style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>
                      {redeemText(locale, 'freePriceLabel')}
                    </p>
                    <button
                      onClick={() => void handlePlacementOptIn(true)}
                      disabled={placementBusy}
                      style={{ ...primaryButtonStyle, marginTop: 12, opacity: placementBusy ? 0.6 : 1 }}
                    >
                      {redeemText(locale, 'topPlacementOptInButton')}
                    </button>
                  </>
                )
              ) : placement.featured ? (
                <>
                  <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                    {placement.status === 'past_due'
                      ? redeemText(locale, 'topPlacementPastDueNote')
                      : redeemText(locale, 'topPlacementFeaturedNote')}
                  </p>
                  <button
                    onClick={() => void handlePlacementCancel()}
                    disabled={placementBusy}
                    style={{
                      marginTop: 12,
                      padding: '9px 16px',
                      fontSize: 13.5,
                      fontWeight: 700,
                      borderRadius: 10,
                      border: '1px solid #fca5a5',
                      backgroundColor: '#ffffff',
                      color: '#b91c1c',
                      cursor: 'pointer',
                      opacity: placementBusy ? 0.6 : 1,
                    }}
                  >
                    {redeemText(locale, 'topPlacementCancelButton')}
                  </button>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                    {redeemText(locale, 'topPlacementNote')}
                  </p>
                  {placement.price !== null && (
                    <p style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>
                      {placement.price === 0
                        ? redeemText(locale, 'freePriceLabel')
                        : redeemText(locale, 'topPlacementPrice', {
                            price: placement.price.toLocaleString('ja-JP'),
                          })}
                    </p>
                  )}
                  <button
                    onClick={() => void handlePlacementSubscribe()}
                    disabled={placementBusy}
                    style={{ ...primaryButtonStyle, marginTop: 12, opacity: placementBusy ? 0.6 : 1 }}
                  >
                    {redeemText(locale, 'topPlacementSubscribeButton')}
                  </button>
                </>
              )}
              {placementMessage && (
                <p style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 12 }}>
                  {placementMessage}
                </p>
              )}
            </section>
          )}

          {shopAd && shopAd.enabled && (
            <section style={{ ...cardStyle, padding: 16, marginTop: 16 }}>
              <h2 style={{ fontSize: 16.5, fontWeight: 800, margin: 0 }}>
                {redeemText(locale, 'adSectionTitle')}
              </h2>
              <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                {redeemText(locale, 'adNote')}
              </p>
              {!shopAd.optionEnabled && (
                <p style={{ fontSize: 13.5, fontWeight: 700, color: '#b91c1c', marginTop: 8 }}>
                  {redeemText(locale, 'adOptionStoppedNote')}
                </p>
              )}
              {shopAd.freeMode ? (
                <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                  {redeemText(locale, 'adFreeNote')}
                </p>
              ) : shopAd.subscribed ? (
                <>
                  <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                    {shopAd.status === 'past_due'
                      ? redeemText(locale, 'adPastDueNote')
                      : redeemText(locale, 'adSubscribedNote')}
                  </p>
                  <button
                    onClick={() => void handleAdCancel()}
                    disabled={adBusy}
                    style={{
                      marginTop: 12,
                      padding: '9px 16px',
                      fontSize: 13.5,
                      fontWeight: 700,
                      borderRadius: 10,
                      border: '1px solid #fca5a5',
                      backgroundColor: '#ffffff',
                      color: '#b91c1c',
                      cursor: 'pointer',
                      opacity: adBusy ? 0.6 : 1,
                    }}
                  >
                    {redeemText(locale, 'adCancelButton')}
                  </button>
                </>
              ) : shopAd.available ? (
                <>
                  {shopAd.price !== null && (
                    <p style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>
                      {shopAd.price === 0
                        ? redeemText(locale, 'freePriceLabel')
                        : redeemText(locale, 'adPrice', {
                            price: shopAd.price.toLocaleString('ja-JP'),
                          })}
                    </p>
                  )}
                  <button
                    onClick={() => void handleAdSubscribe()}
                    disabled={adBusy}
                    style={{ ...primaryButtonStyle, marginTop: 12, opacity: adBusy ? 0.6 : 1 }}
                  >
                    {redeemText(locale, 'adSubscribeButton')}
                  </button>
                </>
              ) : null}

              <div
                style={{
                  border: '1px solid #e2e8f0',
                  borderRadius: 12,
                  padding: '12px 14px 14px',
                  marginTop: 16,
                }}
              >
                <p style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>
                  {redeemText(locale, 'adFormTitle')}
                </p>
                <p style={{ fontSize: 12, color: '#64748b', margin: '6px 0 0' }}>
                  {redeemText(locale, 'adFormNote')}
                </p>
                <p style={{ fontSize: 12.5, fontWeight: 700, color: VIOLET, margin: '10px 0 0' }}>
                  {shopAd.ad.pending
                    ? redeemText(locale, 'adStatusPending')
                    : shopAd.ad.live
                      ? redeemText(locale, 'adStatusLive')
                      : shopAd.ad.lastRejectedAt
                        ? redeemText(locale, 'adStatusRejected')
                        : redeemText(locale, 'adStatusNone')}
                </p>
                <label style={labelStyle}>
                  {redeemText(locale, 'adTitleLabel')}
                  <input
                    style={inputStyle}
                    maxLength={40}
                    value={adForm.title}
                    onChange={(e) =>
                      setAdForm((current) => ({ ...current, title: e.target.value }))
                    }
                  />
                </label>
                <label style={labelStyle}>
                  {redeemText(locale, 'adTextLabel')}
                  <textarea
                    style={{ ...inputStyle, minHeight: 72 }}
                    maxLength={200}
                    value={adForm.text}
                    onChange={(e) =>
                      setAdForm((current) => ({ ...current, text: e.target.value }))
                    }
                  />
                </label>
                <label style={labelStyle}>
                  {redeemText(locale, 'adLinkLabel')}
                  <input
                    style={inputStyle}
                    type="url"
                    placeholder="https://"
                    value={adForm.linkUrl ?? ''}
                    onChange={(e) =>
                      setAdForm((current) => ({
                        ...current,
                        linkUrl: e.target.value ? e.target.value : null,
                      }))
                    }
                  />
                </label>
                <p style={{ fontSize: 13, fontWeight: 600, margin: '14px 0 0' }}>
                  {redeemText(locale, 'adImageLabel')}
                </p>
                {adForm.imageUrl ? (
                  <div style={{ width: 160, marginTop: 10 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={adForm.imageUrl}
                      alt=""
                      style={{
                        width: 160,
                        height: 100,
                        objectFit: 'cover',
                        borderRadius: 10,
                        border: '1px solid #e2e8f0',
                        display: 'block',
                      }}
                    />
                    <button
                      onClick={() =>
                        setAdForm((current) => ({ ...current, imageUrl: null }))
                      }
                      style={{
                        width: '100%',
                        marginTop: 6,
                        padding: '5px 0',
                        fontSize: 12.5,
                        fontWeight: 600,
                        borderRadius: 8,
                        border: '1px solid #fca5a5',
                        backgroundColor: '#ffffff',
                        color: '#b91c1c',
                        cursor: 'pointer',
                      }}
                    >
                      {redeemText(locale, 'profilePhotoRemove')}
                    </button>
                  </div>
                ) : (
                  <label
                    style={{
                      display: 'inline-block',
                      marginTop: 10,
                      padding: '10px 16px',
                      fontSize: 14,
                      fontWeight: 700,
                      borderRadius: 10,
                      border: `1px solid ${VIOLET}`,
                      color: VIOLET,
                      backgroundColor: '#ffffff',
                      cursor: adPhotoUploading ? 'wait' : 'pointer',
                      opacity: adPhotoUploading ? 0.6 : 1,
                    }}
                  >
                    {redeemText(locale, 'profilePhotoAdd')}
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      style={{ display: 'none' }}
                      disabled={adPhotoUploading}
                      onChange={(e) => {
                        void handleAdPhotoSelect(e.target.files?.[0]);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
                <button
                  onClick={() => void handleAdSubmit()}
                  disabled={adBusy || !shopAd.optionEnabled}
                  style={{ ...primaryButtonStyle, marginTop: 16, opacity: adBusy || !shopAd.optionEnabled ? 0.6 : 1 }}
                >
                  {redeemText(locale, 'adSubmitButton')}
                </button>
              </div>
              {adMessage && (
                <p style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 12 }}>
                  {adMessage}
                </p>
              )}
            </section>
          )}
          {!isAdvertiser && !placement?.featured && !placement?.available && placementMessage && (
            <p style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 16 }}>
              {placementMessage}
            </p>
          )}

          {!isAdvertiser && chargeMessage && (
            <p style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 16 }}>
              {chargeMessage}
            </p>
          )}

          {!isAdvertiser && shopCoupons && (
            <section style={{ ...cardStyle, padding: 16, marginTop: 16 }}>
              <h2 style={{ fontSize: 16.5, fontWeight: 800, margin: 0 }}>
                {redeemText(locale, 'couponIssueTitle')}
              </h2>
              <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                {redeemText(locale, 'couponIssueNote')}
              </p>
              <p style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>
                {shopCoupons.fee > 0
                  ? redeemText(locale, 'couponIssueFee', {
                      price: shopCoupons.fee.toLocaleString('ja-JP'),
                    })
                  : redeemText(locale, 'freePriceLabel')}
              </p>
              {shopCoupons.fee > 0 && (
                <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
                  {redeemText(locale, 'couponIssuePaidNote')}
                </p>
              )}
              <label style={labelStyle}>
                {redeemText(locale, 'couponTitleLabel')}
                <input
                  style={inputStyle}
                  type="text"
                  value={couponForm.title}
                  onChange={(e) =>
                    setCouponForm((current) => ({ ...current, title: e.target.value }))
                  }
                />
              </label>
              <label style={labelStyle}>
                {redeemText(locale, 'couponDescriptionLabel')}
                <textarea
                  style={{ ...inputStyle, minHeight: 64 }}
                  value={couponForm.description}
                  onChange={(e) =>
                    setCouponForm((current) => ({
                      ...current,
                      description: e.target.value,
                    }))
                  }
                />
              </label>
              <label style={labelStyle}>
                {redeemText(locale, 'couponKeywordsLabel')}
                <input
                  style={inputStyle}
                  type="text"
                  value={couponForm.keywords}
                  onChange={(e) =>
                    setCouponForm((current) => ({
                      ...current,
                      keywords: e.target.value,
                    }))
                  }
                />
              </label>
              <button
                onClick={() => void handleCouponCreate()}
                disabled={couponBusy || !couponForm.title.trim()}
                style={{
                  ...primaryButtonStyle,
                  marginTop: 16,
                  opacity: couponBusy || !couponForm.title.trim() ? 0.6 : 1,
                }}
              >
                {redeemText(locale, 'couponIssueButton')}
              </button>
              {couponMessage && (
                <p style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 12 }}>
                  {couponMessage}
                </p>
              )}
              {shopCoupons.coupons.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 800, margin: 0 }}>
                    {redeemText(locale, 'ownCouponsTitle')}
                  </h3>
                  {shopCoupons.coupons.map((coupon) => (
                    <div
                      key={coupon.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        borderTop: '1px solid #e2e8f0',
                        paddingTop: 10,
                        marginTop: 10,
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{coupon.title}</span>
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 700,
                          color: '#ffffff',
                          backgroundColor:
                            coupon.approvalStatus === 'rejected'
                              ? '#dc2626'
                              : coupon.approvalStatus === 'pending'
                                ? '#b45309'
                                : coupon.paymentPending
                                  ? '#b45309'
                                  : coupon.active
                                    ? '#16a34a'
                                    : '#6b7280',
                          borderRadius: 6,
                          padding: '2px 8px',
                        }}
                      >
                        {coupon.approvalStatus === 'rejected'
                          ? redeemText(locale, 'couponStatusRejected')
                          : coupon.approvalStatus === 'pending'
                            ? redeemText(locale, 'couponStatusAwaitingApproval')
                            : coupon.paymentPending
                              ? redeemText(locale, 'couponStatusUnpaid')
                              : coupon.active
                                ? redeemText(locale, 'couponStatusActive')
                                : redeemText(locale, 'couponStatusInactive')}
                      </span>
                      {coupon.paymentPending && (
                        <button
                          onClick={() => void handleCouponPay(coupon.id)}
                          disabled={couponBusy}
                          style={{
                            marginLeft: 'auto',
                            padding: '7px 14px',
                            fontSize: 13,
                            fontWeight: 700,
                            borderRadius: 10,
                            border: 'none',
                            backgroundColor: VIOLET,
                            color: '#ffffff',
                            cursor: 'pointer',
                            opacity: couponBusy ? 0.6 : 1,
                          }}
                        >
                          {redeemText(locale, 'chargePayButton')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {!isAdvertiser && shopPushRequests && (
            <section style={{ ...cardStyle, padding: 16, marginTop: 16 }}>
              <h2 style={{ fontSize: 16.5, fontWeight: 800, margin: 0 }}>
                {redeemText(locale, 'pushRequestTitle')}
              </h2>
              <p style={{ fontSize: 13.5, color: '#334155', marginTop: 8 }}>
                {redeemText(locale, 'pushRequestNote')}
              </p>
              <p style={{ fontSize: 15, fontWeight: 800, marginTop: 8 }}>
                {shopPushRequests.fee > 0
                  ? redeemText(locale, 'pushRequestFee', {
                      price: shopPushRequests.fee.toLocaleString('ja-JP'),
                    })
                  : redeemText(locale, 'freePriceLabel')}
              </p>
              {shopPushRequests.fee > 0 && (
                <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
                  {redeemText(locale, 'pushRequestPaidNote')}
                </p>
              )}
              <label style={labelStyle}>
                {redeemText(locale, 'pushTitleLabel')}
                <input
                  style={inputStyle}
                  type="text"
                  value={pushForm.title}
                  onChange={(e) =>
                    setPushForm((current) => ({ ...current, title: e.target.value }))
                  }
                />
              </label>
              <label style={labelStyle}>
                {redeemText(locale, 'pushBodyLabel')}
                <textarea
                  style={{ ...inputStyle, minHeight: 80 }}
                  value={pushForm.body}
                  onChange={(e) =>
                    setPushForm((current) => ({ ...current, body: e.target.value }))
                  }
                />
              </label>
              <button
                onClick={() => void handlePushRequestCreate()}
                disabled={pushBusy || !pushForm.title.trim() || !pushForm.body.trim()}
                style={{
                  ...primaryButtonStyle,
                  marginTop: 16,
                  opacity:
                    pushBusy || !pushForm.title.trim() || !pushForm.body.trim()
                      ? 0.6
                      : 1,
                }}
              >
                {redeemText(locale, 'pushRequestButton')}
              </button>
              {pushMessage && (
                <p style={{ fontSize: 13.5, fontWeight: 600, color: '#334155', marginTop: 12 }}>
                  {pushMessage}
                </p>
              )}
              {shopPushRequests.requests.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 14, fontWeight: 800, margin: 0 }}>
                    {redeemText(locale, 'ownPushRequestsTitle')}
                  </h3>
                  {shopPushRequests.requests.map((request) => (
                    <div
                      key={request.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        flexWrap: 'wrap',
                        borderTop: '1px solid #e2e8f0',
                        paddingTop: 10,
                        marginTop: 10,
                      }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 700 }}>{request.title}</span>
                      <span
                        style={{
                          fontSize: 11.5,
                          fontWeight: 700,
                          color: '#ffffff',
                          backgroundColor:
                            request.status === 'unpaid'
                              ? '#b45309'
                              : request.status === 'pending'
                                ? '#d97706'
                                : request.status === 'sent'
                                  ? '#16a34a'
                                  : request.status === 'rejected'
                                    ? '#6b7280'
                                    : '#b91c1c',
                          borderRadius: 6,
                          padding: '2px 8px',
                        }}
                      >
                        {request.status === 'unpaid'
                          ? redeemText(locale, 'pushStatusUnpaid')
                          : request.status === 'pending'
                            ? redeemText(locale, 'pushStatusPending')
                            : request.status === 'sent'
                              ? redeemText(locale, 'pushStatusSent')
                              : request.status === 'rejected'
                                ? redeemText(locale, 'pushStatusRejected')
                                : redeemText(locale, 'pushStatusFailed')}
                      </span>
                      {request.status === 'unpaid' && (
                        <button
                          onClick={() => void handlePushRequestPay(request.id)}
                          disabled={pushBusy}
                          style={{
                            marginLeft: 'auto',
                            padding: '7px 14px',
                            fontSize: 13,
                            fontWeight: 700,
                            borderRadius: 10,
                            border: 'none',
                            backgroundColor: VIOLET,
                            color: '#ffffff',
                            cursor: 'pointer',
                            opacity: pushBusy ? 0.6 : 1,
                          }}
                        >
                          {redeemText(locale, 'chargePayButton')}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}
      <PoweredByFooter />
    </main>
  );
}
