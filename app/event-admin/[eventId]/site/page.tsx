'use client';

// app/event-admin/[eventId]/site/page.tsx
// Push-taro.スタンプラリー 主催者向けの特設サイト編集画面。
// 本家（push-taro.com）上の特設サイトに表示される、プロジェクトごとの
// 紹介文・ご当地グルメの定義・ヒーロー画像・アイコン・テーマカラー・
// 追加事項（タイトル＋本文、最大5件）を編集する。
// あわせて、トップ掲載（先頭5枠）課金の ON/OFF と月額料金もここで設定する。
// 保存先はプロジェクトドキュメントのトップレベル項目で、読み書きは
// /api/events/{eventId}/site-settings、画像アップロードは
// /api/events/{eventId}/site-image 経由。
// 画面の固定文は4言語辞書（lib/ui-text.ts の ADMIN_TEXT）。
// 見た目は設定画面と共通（AdminShell + カード + フォーム直下フィードバック）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth } from '@/lib/firebase-client';
import { AdminLanguageSelect, useAdminLocale } from '@/components/AdminLocale';
import {
  ADMIN_CARD_BORDER,
  ADMIN_CARD_SHADOW,
  ADMIN_PAGE_BG,
  AdminBrandBar,
  ButtonSpinner,
  adminButtonContentStyle,
  adminErrorTextStyle,
  adminFeedbackStyle,
  adminPageTitleStyle,
} from '@/components/AdminBrand';
import { adminText, uiText } from '@/lib/ui-text';
import { AdminShell } from '@/components/AdminShell';
import { CapWarningBanner } from '@/components/CapWarningBanner';
import { AdminNav } from '../AdminNav';
import { specialSiteUrl } from '@/lib/special-site';
import { eventShopApplyUrl } from '@/lib/app-origin';
import {
  MAX_GOURMET_DEFINITION_LENGTH,
  MAX_SITE_DESCRIPTION_LENGTH,
  MAX_SITE_NOTE_BODY_LENGTH,
  MAX_SITE_NOTE_TITLE_LENGTH,
  MAX_SITE_NOTES,
  type SiteNote,
} from '@/lib/event-site';

const VIOLET = '#8B5E34';

/**
 * テーマカラーのプリセット（グルメ系プロジェクトに合う色味）。
 * 先頭の茶色がサイト既定色。表示ラベルは16進コード（言語中立）を使う。
 */
const THEME_COLOR_PRESETS = [
  '#8b5e34', // 茶（サイト既定）
  '#dd5e22', // 柿
  '#c73e2c', // トマト
  '#6f7d3c', // 抹茶
  '#2f4a67', // 藍
  '#d9a62e', // からし
  '#83406a', // 梅紫
  '#3a3a3a', // 炭
] as const;

const THEME_COLOR_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

const containerStyle: React.CSSProperties = {
  padding: '20px 16px 48px',
  maxWidth: 880,
  margin: '0 auto',
  fontFamily: 'sans-serif',
  backgroundColor: ADMIN_PAGE_BG,
  minHeight: '100vh',
  boxSizing: 'border-box',
  color: '#0f172a',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: `1px solid ${ADMIN_CARD_BORDER}`,
  borderRadius: 18,
  boxShadow: ADMIN_CARD_SHADOW,
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '11px 12px',
  marginTop: 6,
  border: '1px solid #E8DCC4',
  borderRadius: 12,
  fontSize: 14,
  backgroundColor: '#ffffff',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 12,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '12px 22px',
  fontWeight: 700,
  fontSize: 15,
  backgroundColor: VIOLET,
  color: '#ffffff',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(139, 94, 52, 0.25)',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '9px 18px',
  fontSize: 13.5,
  fontWeight: 700,
  borderRadius: 12,
  border: `1px solid ${VIOLET}`,
  backgroundColor: '#ffffff',
  color: VIOLET,
  cursor: 'pointer',
};

const dangerButtonStyle: React.CSSProperties = {
  padding: '7px 16px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 12,
  border: '1px solid #fca5a5',
  backgroundColor: '#ffffff',
  color: '#b91c1c',
  cursor: 'pointer',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 800,
  margin: 0,
};

const noteTextStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: '#64748b',
  marginTop: 5,
};

export default function SiteEditAdminPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginMessage, setLoginMessage] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [eventName, setEventName] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [description, setDescription] = useState('');
  const [gourmetDefinition, setGourmetDefinition] = useState('');
  const [heroImageUrl, setHeroImageUrl] = useState<string | null>(null);
  const [siteIconUrl, setSiteIconUrl] = useState<string | null>(null);
  const [themeColor, setThemeColor] = useState<string | null>(null);
  const [themeColorHex, setThemeColorHex] = useState('');
  const [notes, setNotes] = useState<SiteNote[]>([{ title: '', body: '' }]);
  const [topPlacementEnabled, setTopPlacementEnabled] = useState(false);
  const [topPlacementPrice, setTopPlacementPrice] = useState('');
  const [adsEnabled, setAdsEnabled] = useState(false);
  const [adsSlots, setAdsSlots] = useState('5');
  const [adsPrice, setAdsPrice] = useState('');
  // 広告オプション（本家との別料金契約）。読み取り専用で、契約状態は
  // 本家側からプロビジョニングで届く。無効な間は広告を有効にできない。
  const [adsOptionEnabled, setAdsOptionEnabled] = useState(false);
  const [couponIssuePrice, setCouponIssuePrice] = useState('');
  const [pushPrice, setPushPrice] = useState('');
  const [shopMonthlyPrice, setShopMonthlyPrice] = useState('');
  const [applyUrlCopied, setApplyUrlCopied] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [imageMessage, setImageMessage] = useState('');
  const [iconUploading, setIconUploading] = useState(false);
  const [iconMessage, setIconMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const iconFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  const callApi = useCallback(
    async (path: string, init?: RequestInit) => {
      if (!user) throw new Error(adminText(locale, 'loginRequired'));
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
        throw new Error(data.error ?? adminText(locale, 'apiError', { status: String(res.status) }));
      return data;
    },
    [user, locale],
  );

  const loadSettings = useCallback(async () => {
    if (!user) return;
    try {
      const [eventData, siteData] = await Promise.all([
        callApi(`/api/events/${eventId}`).catch(() => null),
        callApi(`/api/events/${eventId}/site-settings`),
      ]);
      if (typeof eventData?.event?.name === 'string') {
        setEventName(eventData.event.name);
      }
      setDescription(
        typeof siteData.siteDescription === 'string' ? siteData.siteDescription : '',
      );
      setGourmetDefinition(
        typeof siteData.gourmetDefinition === 'string'
          ? siteData.gourmetDefinition
          : '',
      );
      setHeroImageUrl(
        typeof siteData.heroImageUrl === 'string' ? siteData.heroImageUrl : null,
      );
      setSiteIconUrl(
        typeof siteData.siteIconUrl === 'string' ? siteData.siteIconUrl : null,
      );
      const loadedThemeColor =
        typeof siteData.themeColor === 'string' ? siteData.themeColor : null;
      setThemeColor(loadedThemeColor);
      setThemeColorHex(loadedThemeColor ?? '');
      const loadedNotes: SiteNote[] = Array.isArray(siteData.siteNotes)
        ? siteData.siteNotes
        : [];
      setNotes(loadedNotes.length > 0 ? loadedNotes : [{ title: '', body: '' }]);
      setTopPlacementEnabled(siteData.topPlacementEnabled === true);
      setTopPlacementPrice(
        typeof siteData.topPlacementPrice === 'number'
          ? String(siteData.topPlacementPrice)
          : '',
      );
      setAdsEnabled(siteData.adsEnabled === true);
      setAdsOptionEnabled(siteData.adsOptionEnabled === true);
      setAdsSlots(
        typeof siteData.adsSlots === 'number' ? String(siteData.adsSlots) : '5',
      );
      setAdsPrice(
        typeof siteData.adsPrice === 'number' ? String(siteData.adsPrice) : '',
      );
      setCouponIssuePrice(
        typeof siteData.couponIssuePrice === 'number'
          ? String(siteData.couponIssuePrice)
          : '',
      );
      setPushPrice(
        typeof siteData.pushPrice === 'number' ? String(siteData.pushPrice) : '',
      );
      setShopMonthlyPrice(
        typeof siteData.shopMonthlyPrice === 'number'
          ? String(siteData.shopMonthlyPrice)
          : '',
      );
      setLoadMessage('');
    } catch (e) {
      setLoadMessage(e instanceof Error ? e.message : adminText(locale, 'loadFailed'));
    }
  }, [user, eventId, callApi, locale]);

  useEffect(() => {
    if (user) void loadSettings();
  }, [user, loadSettings]);

  const handleLogin = async () => {
    setLoginBusy(true);
    setLoginMessage('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch {
      setLoginMessage(adminText(locale, 'loginFailed'));
    } finally {
      setLoginBusy(false);
    }
  };

  // 画像アップロード共通処理（kind でヒーロー画像／アイコンを区別する）。
  // URL はフォーム状態にだけ入れる。公開ページへの反映は「保存する」時点。
  const uploadSiteImage = async (
    file: File,
    kind: 'hero' | 'icon',
  ): Promise<string> => {
    if (!user) throw new Error(adminText(locale, 'heroImageUploadFailed'));
    const idToken = await user.getIdToken();
    const form = new FormData();
    form.append('file', file);
    form.append('kind', kind);
    const res = await fetch(`/api/events/${eventId}/site-image`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error ?? adminText(locale, 'heroImageUploadFailed'));
    }
    return data.url as string;
  };

  const handleImageSelected = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !user) return;
    setUploading(true);
    setImageMessage('');
    try {
      setHeroImageUrl(await uploadSiteImage(file, 'hero'));
    } catch (e) {
      setImageMessage(
        e instanceof Error ? e.message : adminText(locale, 'heroImageUploadFailed'),
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleIconSelected = async (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !user) return;
    setIconUploading(true);
    setIconMessage('');
    try {
      setSiteIconUrl(await uploadSiteImage(file, 'icon'));
    } catch (e) {
      setIconMessage(
        e instanceof Error ? e.message : adminText(locale, 'heroImageUploadFailed'),
      );
    } finally {
      setIconUploading(false);
      if (iconFileInputRef.current) iconFileInputRef.current.value = '';
    }
  };

  const applyThemeColor = (value: string | null) => {
    setThemeColor(value);
    setThemeColorHex(value ?? '');
  };

  const handleThemeColorHexChange = (raw: string) => {
    setThemeColorHex(raw);
    const trimmed = raw.trim();
    if (!trimmed) {
      setThemeColor(null);
    } else if (THEME_COLOR_HEX_PATTERN.test(trimmed)) {
      setThemeColor(trimmed.toLowerCase());
    }
    // 形式が整うまでは themeColor を変えない（入力途中の文字列で壊さない）
  };

  const updateNote = (index: number, field: keyof SiteNote, value: string) => {
    setNotes((current) =>
      current.map((note, i) => (i === index ? { ...note, [field]: value } : note)),
    );
  };

  // 参加店の自己登録ページはどこからもリンクされていないため、
  // 主催者がこの URL を店へ渡して案内する。
  const shopApplyUrl = eventShopApplyUrl(eventId);
  const handleCopyShopApplyUrl = async () => {
    try {
      await navigator.clipboard.writeText(shopApplyUrl);
      setApplyUrlCopied(true);
      window.setTimeout(() => setApplyUrlCopied(false), 2000);
    } catch {
      // コピーできない環境では入力欄の URL を手動でコピーしてもらう。
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage('');
    try {
      const priceText = topPlacementPrice.trim();
      const adsPriceText = adsPrice.trim();
      const couponIssuePriceText = couponIssuePrice.trim();
      const pushPriceText = pushPrice.trim();
      const shopMonthlyPriceText = shopMonthlyPrice.trim();
      const data = await callApi(`/api/events/${eventId}/site-settings`, {
        method: 'PUT',
        body: JSON.stringify({
          siteDescription: description,
          gourmetDefinition,
          heroImageUrl,
          siteIconUrl,
          themeColor,
          siteNotes: notes,
          topPlacementEnabled,
          topPlacementPrice: priceText === '' ? null : Number(priceText),
          adsEnabled,
          adsSlots: adsSlots.trim() === '' ? null : Number(adsSlots),
          adsPrice: adsPriceText === '' ? null : Number(adsPriceText),
          couponIssuePrice:
            couponIssuePriceText === '' ? null : Number(couponIssuePriceText),
          pushPrice: pushPriceText === '' ? null : Number(pushPriceText),
          shopMonthlyPrice:
            shopMonthlyPriceText === '' ? null : Number(shopMonthlyPriceText),
        }),
      });
      // サーバー側で正規化された値（空行の除去など）をそのまま表示に戻す
      if (typeof data.siteDescription === 'string') {
        setDescription(data.siteDescription);
      }
      if (typeof data.gourmetDefinition === 'string') {
        setGourmetDefinition(data.gourmetDefinition);
      }
      setHeroImageUrl(
        typeof data.heroImageUrl === 'string' ? data.heroImageUrl : null,
      );
      setSiteIconUrl(
        typeof data.siteIconUrl === 'string' ? data.siteIconUrl : null,
      );
      const savedThemeColor =
        typeof data.themeColor === 'string' ? data.themeColor : null;
      setThemeColor(savedThemeColor);
      setThemeColorHex(savedThemeColor ?? '');
      const savedNotes: SiteNote[] = Array.isArray(data.siteNotes)
        ? data.siteNotes
        : [];
      setNotes(savedNotes.length > 0 ? savedNotes : [{ title: '', body: '' }]);
      setTopPlacementEnabled(data.topPlacementEnabled === true);
      setTopPlacementPrice(
        typeof data.topPlacementPrice === 'number'
          ? String(data.topPlacementPrice)
          : '',
      );
      setAdsEnabled(data.adsEnabled === true);
      setAdsOptionEnabled(data.adsOptionEnabled === true);
      setAdsSlots(
        typeof data.adsSlots === 'number' ? String(data.adsSlots) : '5',
      );
      setAdsPrice(
        typeof data.adsPrice === 'number' ? String(data.adsPrice) : '',
      );
      setCouponIssuePrice(
        typeof data.couponIssuePrice === 'number'
          ? String(data.couponIssuePrice)
          : '',
      );
      setPushPrice(
        typeof data.pushPrice === 'number' ? String(data.pushPrice) : '',
      );
      setShopMonthlyPrice(
        typeof data.shopMonthlyPrice === 'number'
          ? String(data.shopMonthlyPrice)
          : '',
      );
      setSaveMessage(adminText(locale, 'savedMessage'));
    } catch (e) {
      setSaveMessage(
        e instanceof Error ? e.message : adminText(locale, 'siteSaveFailed'),
      );
    } finally {
      setSaving(false);
    }
  };

  if (!authReady) return <main style={containerStyle}>{uiText(locale, 'loading')}</main>;

  if (!user) {
    return (
      <main style={{ ...containerStyle, maxWidth: 480 }}>
        <AdminBrandBar right={<AdminLanguageSelect locale={locale} onChange={setLocale} />} />
        <section style={{ ...cardStyle, padding: 24, marginTop: 16 }}>
          <h1 style={{ fontSize: 18, fontWeight: 800, margin: '0 0 16px' }}>{adminText(locale, 'adminLoginTitle')}</h1>
          <label style={labelStyle}>
            {adminText(locale, 'emailLabel')}
            <input style={inputStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label style={labelStyle}>
            {adminText(locale, 'passwordLabel')}
            <input style={inputStyle} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button onClick={handleLogin} disabled={loginBusy} style={{ ...primaryButtonStyle, width: '100%' }}>
            <span style={adminButtonContentStyle}>
              {loginBusy && <ButtonSpinner />}
              {adminText(locale, 'loginButton')}
            </span>
          </button>
          {loginMessage && <p style={{ color: '#b91c1c', marginTop: 12, fontSize: 14 }}>{loginMessage}</p>}
        </section>
      </main>
    );
  }

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={<AdminNav eventId={eventId} eventName={eventName} current="site" locale={locale} />}
    >
      <h1 style={adminPageTitleStyle}>{adminText(locale, 'siteEditPageTitle')}</h1>
      <CapWarningBanner locale={locale} />
      <p style={{ fontSize: 13, color: '#475569', marginTop: 8 }}>
        {adminText(locale, 'siteEditNote')}{' '}
        <a
          href={specialSiteUrl(eventId)}
          target="_blank"
          rel="noreferrer"
          style={{ color: VIOLET, fontWeight: 700 }}
        >
          {adminText(locale, 'specialSiteOpen')} ↗
        </a>
      </p>
      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}

      <section style={{ marginTop: 22 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'siteDescriptionLabel')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'siteDescriptionNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <textarea
            style={{ ...inputStyle, marginTop: 0, minHeight: 110, resize: 'vertical' }}
            value={description}
            maxLength={MAX_SITE_DESCRIPTION_LENGTH}
            placeholder={adminText(locale, 'siteDescriptionPlaceholder')}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 6, textAlign: 'right' }}>
            {adminText(locale, 'siteCharCount', {
              count: String(description.length),
              max: String(MAX_SITE_DESCRIPTION_LENGTH),
            })}
          </div>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'gourmetDefinitionLabel')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'gourmetDefinitionNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <textarea
            style={{ ...inputStyle, marginTop: 0, minHeight: 140, resize: 'vertical' }}
            value={gourmetDefinition}
            maxLength={MAX_GOURMET_DEFINITION_LENGTH}
            placeholder={adminText(locale, 'gourmetDefinitionPlaceholder')}
            onChange={(e) => setGourmetDefinition(e.target.value)}
          />
          <div style={{ fontSize: 12, color: '#64748b', marginTop: 6, textAlign: 'right' }}>
            {adminText(locale, 'siteCharCount', {
              count: String(gourmetDefinition.length),
              max: String(MAX_GOURMET_DEFINITION_LENGTH),
            })}
          </div>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'heroImageLabel')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'heroImageNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          {heroImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={heroImageUrl}
              alt={adminText(locale, 'heroImageLabel')}
              style={{
                display: 'block',
                width: '100%',
                maxHeight: 320,
                objectFit: 'cover',
                borderRadius: 12,
                marginBottom: 16,
              }}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => void handleImageSelected(e.target.files)}
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={secondaryButtonStyle}
            >
              <span style={adminButtonContentStyle}>
                {uploading && <ButtonSpinner />}
                {uploading
                  ? adminText(locale, 'heroImageUploading')
                  : heroImageUrl
                    ? adminText(locale, 'heroImageReplaceButton')
                    : adminText(locale, 'heroImageUploadButton')}
              </span>
            </button>
            {heroImageUrl && (
              <button
                onClick={() => setHeroImageUrl(null)}
                disabled={uploading}
                style={dangerButtonStyle}
              >
                {adminText(locale, 'heroImageRemoveButton')}
              </button>
            )}
          </div>
          {imageMessage && <p style={adminFeedbackStyle}>{imageMessage}</p>}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'siteIconLabel')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'siteIconNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          {siteIconUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={siteIconUrl}
              alt={adminText(locale, 'siteIconLabel')}
              style={{
                display: 'block',
                width: 96,
                height: 96,
                objectFit: 'cover',
                borderRadius: 20,
                border: '1px solid #E8DCC4',
                marginBottom: 16,
              }}
            />
          )}
          <input
            ref={iconFileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={(e) => void handleIconSelected(e.target.files)}
          />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button
              onClick={() => iconFileInputRef.current?.click()}
              disabled={iconUploading}
              style={secondaryButtonStyle}
            >
              <span style={adminButtonContentStyle}>
                {iconUploading && <ButtonSpinner />}
                {iconUploading
                  ? adminText(locale, 'heroImageUploading')
                  : siteIconUrl
                    ? adminText(locale, 'heroImageReplaceButton')
                    : adminText(locale, 'heroImageUploadButton')}
              </span>
            </button>
            {siteIconUrl && (
              <button
                onClick={() => setSiteIconUrl(null)}
                disabled={iconUploading}
                style={dangerButtonStyle}
              >
                {adminText(locale, 'heroImageRemoveButton')}
              </button>
            )}
          </div>
          {iconMessage && <p style={adminFeedbackStyle}>{iconMessage}</p>}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'themeColorLabel')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'themeColorNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {THEME_COLOR_PRESETS.map((preset) => {
              const selected = themeColor === preset;
              return (
                <button
                  key={preset}
                  type="button"
                  title={preset}
                  aria-pressed={selected}
                  onClick={() => applyThemeColor(preset)}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    backgroundColor: preset,
                    border: selected
                      ? '3px solid #0f172a'
                      : '1px solid rgba(15, 23, 42, 0.25)',
                    boxShadow: selected
                      ? '0 0 0 2px #ffffff inset'
                      : undefined,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                />
              );
            })}
          </div>
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              marginTop: 16,
            }}
          >
            <label style={{ ...labelStyle, marginBottom: 0 }}>
              #RRGGBB
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  style={{ ...inputStyle, width: 150 }}
                  value={themeColorHex}
                  placeholder="#8b5e34"
                  onChange={(e) => handleThemeColorHexChange(e.target.value)}
                />
                <input
                  type="color"
                  value={themeColor ?? '#8b5e34'}
                  onChange={(e) => applyThemeColor(e.target.value)}
                  style={{
                    width: 48,
                    height: 44,
                    padding: 2,
                    border: '1px solid #E8DCC4',
                    borderRadius: 12,
                    backgroundColor: '#ffffff',
                    cursor: 'pointer',
                  }}
                />
              </span>
            </label>
            {themeColor && (
              <button
                type="button"
                onClick={() => applyThemeColor(null)}
                style={dangerButtonStyle}
              >
                {adminText(locale, 'themeColorResetButton')}
              </button>
            )}
          </div>
          <p style={noteTextStyle}>
            {themeColor ?? adminText(locale, 'themeColorUnset')}
          </p>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'siteNotesTitle')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'siteNotesNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          {notes.map((note, i) => (
            <div
              key={i}
              style={{
                borderTop: i > 0 ? '1px solid #E8DCC4' : undefined,
                paddingTop: i > 0 ? 18 : 0,
                marginTop: i > 0 ? 18 : 0,
              }}
            >
              <label style={labelStyle}>
                {adminText(locale, 'siteNoteTitleLabel')}
                <input
                  style={inputStyle}
                  value={note.title}
                  maxLength={MAX_SITE_NOTE_TITLE_LENGTH}
                  onChange={(e) => updateNote(i, 'title', e.target.value)}
                />
              </label>
              <label style={{ ...labelStyle, marginBottom: 0 }}>
                {adminText(locale, 'siteNoteBodyLabel')}
                <textarea
                  style={{ ...inputStyle, minHeight: 76, resize: 'vertical' }}
                  value={note.body}
                  maxLength={MAX_SITE_NOTE_BODY_LENGTH}
                  onChange={(e) => updateNote(i, 'body', e.target.value)}
                />
              </label>
              {notes.length > 1 && (
                <button
                  onClick={() =>
                    setNotes((current) => current.filter((_, j) => j !== i))
                  }
                  style={{ ...dangerButtonStyle, marginTop: 10 }}
                >
                  {adminText(locale, 'deleteButton')}
                </button>
              )}
            </div>
          ))}
          {notes.length < MAX_SITE_NOTES && (
            <button
              onClick={() =>
                setNotes((current) => [...current, { title: '', body: '' }])
              }
              style={{ ...secondaryButtonStyle, marginTop: 18 }}
            >
              {adminText(locale, 'siteNoteAddButton')}
            </button>
          )}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'siteTopPlacementTitle')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'siteTopPlacementNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={topPlacementEnabled}
              onChange={(e) => setTopPlacementEnabled(e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            {adminText(locale, 'siteTopPlacementEnabledLabel')}
          </label>
          <label style={{ ...labelStyle, marginTop: 16, marginBottom: 0 }}>
            {adminText(locale, 'siteTopPlacementPriceLabel')}
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={1000000}
              step={100}
              inputMode="numeric"
              placeholder="3000"
              value={topPlacementPrice}
              onChange={(e) => setTopPlacementPrice(e.target.value)}
            />
          </label>
          {topPlacementPrice.trim() === '0' && (
            <p style={noteTextStyle}>{adminText(locale, 'siteFreePriceNote')}</p>
          )}
          <p style={noteTextStyle}>{adminText(locale, 'siteTopPlacementCancelNote')}</p>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'siteAdsTitle')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'siteAdsNote')}</p>
        {!adsOptionEnabled && (
          <p style={{ ...noteTextStyle, color: '#b91c1c', fontWeight: 700 }}>
            {adminText(locale, 'siteAdsOptionRequiredNote')}
          </p>
        )}
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={adsEnabled}
              onChange={(e) => setAdsEnabled(e.target.checked)}
              disabled={!adsOptionEnabled && !adsEnabled}
              style={{ width: 18, height: 18 }}
            />
            {adminText(locale, 'siteAdsEnabledLabel')}
          </label>
          <label style={{ ...labelStyle, marginTop: 16, marginBottom: 0 }}>
            {adminText(locale, 'siteAdsSlotsLabel')}
            <input
              style={inputStyle}
              type="number"
              min={1}
              max={50}
              step={1}
              inputMode="numeric"
              placeholder="5"
              value={adsSlots}
              onChange={(e) => setAdsSlots(e.target.value)}
            />
          </label>
          <label style={{ ...labelStyle, marginTop: 16, marginBottom: 0 }}>
            {adminText(locale, 'siteAdsPriceLabel')}
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={1000000}
              step={100}
              inputMode="numeric"
              placeholder="3000"
              value={adsPrice}
              onChange={(e) => setAdsPrice(e.target.value)}
            />
          </label>
          {adsPrice.trim() === '0' && (
            <p style={noteTextStyle}>{adminText(locale, 'siteFreePriceNote')}</p>
          )}
          <p style={noteTextStyle}>{adminText(locale, 'siteAdsCancelNote')}</p>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'siteShopChargesTitle')}</h2>
        <p style={noteTextStyle}>{adminText(locale, 'siteShopChargesNote')}</p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label style={{ ...labelStyle, marginTop: 0, marginBottom: 0 }}>
            {adminText(locale, 'siteCouponIssuePriceLabel')}
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={1000000}
              step={100}
              inputMode="numeric"
              placeholder="500"
              value={couponIssuePrice}
              onChange={(e) => setCouponIssuePrice(e.target.value)}
            />
          </label>
          <label style={{ ...labelStyle, marginTop: 16, marginBottom: 0 }}>
            {adminText(locale, 'sitePushPriceLabel')}
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={1000000}
              step={100}
              inputMode="numeric"
              placeholder="3000"
              value={pushPrice}
              onChange={(e) => setPushPrice(e.target.value)}
            />
          </label>
          <label style={{ ...labelStyle, marginTop: 16, marginBottom: 0 }}>
            {adminText(locale, 'siteShopMonthlyPriceLabel')}
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={1000000}
              step={100}
              inputMode="numeric"
              placeholder="3000"
              value={shopMonthlyPrice}
              onChange={(e) => setShopMonthlyPrice(e.target.value)}
            />
          </label>
          <p style={noteTextStyle}>{adminText(locale, 'siteShopMonthlyPriceNote')}</p>
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px' }}>
              {adminText(locale, 'siteShopApplyUrlLabel')}
            </p>
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <input
                style={{ ...inputStyle, flex: '1 1 320px' }}
                type="text"
                readOnly
                value={shopApplyUrl}
                onFocus={(e) => e.target.select()}
              />
              <button
                type="button"
                onClick={() => void handleCopyShopApplyUrl()}
                style={secondaryButtonStyle}
              >
                {applyUrlCopied
                  ? adminText(locale, 'specialSiteUrlCopied')
                  : adminText(locale, 'specialSiteUrlCopy')}
              </button>
            </div>
            <p style={noteTextStyle}>{adminText(locale, 'siteShopApplyUrlNote')}</p>
          </div>
        </div>
      </section>

      <div style={{ marginTop: 28 }}>
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          style={primaryButtonStyle}
        >
          <span style={adminButtonContentStyle}>
            {saving && <ButtonSpinner />}
            {adminText(locale, 'saveButton')}
          </span>
        </button>
        {saveMessage && <p style={adminFeedbackStyle}>{saveMessage}</p>}
      </div>
    </AdminShell>
  );
}
