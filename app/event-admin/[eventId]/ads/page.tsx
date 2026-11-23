'use client';

// app/event-admin/[eventId]/ads/page.tsx
// Push-taro.スタンプラリー 主催者向けの広告管理画面。
// 参加店が出した広告は、申請版（pending）がここで承認されて初めて
// 掲載版（live）になり、特設サイトに出る。差し戻すと申請版は破棄され、
// 掲載版はそのまま残る。承認は料金が有料でも無料でも必要。
// 画面の固定文は4言語辞書（lib/ui-text.ts の ADMIN_TEXT）。
// ログイン後は共通シェル（components/AdminShell）を使う。
import { useCallback, useEffect, useState } from 'react';
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

interface AdContent {
  imageUrl: string | null;
  title: string;
  text: string;
  linkUrl: string | null;
}

interface AdminAdItem {
  exhibitorId: string;
  shopName: string;
  /** アカウントの種類（'shop' = 参加店 / 'advertiser' = 協賛） */
  kind: string;
  ad: {
    live: AdContent | null;
    pending: AdContent | null;
    pendingSubmittedAt: string | null;
    approvedAt: string | null;
    lastRejectedAt: string | null;
  };
}

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
  backgroundColor: '#8B5E34',
  color: '#ffffff',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
  boxShadow: '0 4px 12px rgba(139, 94, 52, 0.25)',
};

const approveButtonStyle: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13.5,
  fontWeight: 700,
  borderRadius: 12,
  border: 'none',
  backgroundColor: '#16a34a',
  color: '#ffffff',
  cursor: 'pointer',
};

const rejectButtonStyle: React.CSSProperties = {
  padding: '8px 18px',
  fontSize: 13.5,
  fontWeight: 700,
  borderRadius: 12,
  border: '1px solid #fca5a5',
  backgroundColor: '#ffffff',
  color: '#b91c1c',
  cursor: 'pointer',
};

const badgeStyle = (bg: string): React.CSSProperties => ({
  backgroundColor: bg,
  color: '#ffffff',
  borderRadius: 6,
  padding: '3px 10px',
  fontWeight: 700,
  fontSize: 12,
});

function dateLabel(iso: string | null, locale: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function AdPreview({ content }: { content: AdContent }) {
  return (
    <div style={{ marginTop: 10 }}>
      {content.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={content.imageUrl}
          alt={content.title}
          style={{
            width: 240,
            maxWidth: '100%',
            height: 150,
            objectFit: 'cover',
            borderRadius: 10,
            border: '1px solid #e2e8f0',
            display: 'block',
          }}
        />
      )}
      <p style={{ fontSize: 15, fontWeight: 800, margin: '10px 0 0' }}>
        {content.title}
      </p>
      {content.text && (
        <p style={{ fontSize: 14, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
          {content.text}
        </p>
      )}
      {content.linkUrl && (
        <p style={{ fontSize: 13, margin: '6px 0 0', wordBreak: 'break-all' }}>
          <a href={content.linkUrl} target="_blank" rel="noreferrer">
            {content.linkUrl}
          </a>
        </p>
      )}
    </div>
  );
}

export default function EventAdsAdminPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [eventName, setEventName] = useState('');
  const [ads, setAds] = useState<AdminAdItem[]>([]);
  const [adsEnabled, setAdsEnabled] = useState(false);
  // 広告オプション（本家との別料金契約）。無効な間は承認・却下できない。
  const [adsOptionEnabled, setAdsOptionEnabled] = useState(true);
  const [message, setMessage] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState('');

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

  const loadAds = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}/ads`);
      setAds((data.ads as AdminAdItem[]) ?? []);
      setAdsEnabled(data.adsEnabled === true);
      setAdsOptionEnabled(data.adsOptionEnabled === true);
      setLoadMessage('');
    } catch (e) {
      setLoadMessage(e instanceof Error ? e.message : adminText(locale, 'loadFailed'));
    }
  }, [user, eventId, callApi, locale]);

  const loadEventName = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}`);
      if (typeof data.event?.name === 'string') setEventName(data.event.name);
    } catch {
      // 名前が読み込めなくても広告管理は止めない
    }
  }, [user, eventId, callApi]);

  useEffect(() => {
    if (user) {
      void loadAds();
      void loadEventName();
    }
  }, [user, loadAds, loadEventName]);

  const handleLogin = async () => {
    setBusy(true);
    setMessage('');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch {
      setMessage(adminText(locale, 'loginFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleAction = async (item: AdminAdItem, action: 'approve' | 'reject') => {
    setActingId(item.exhibitorId);
    setActionMessage('');
    try {
      await callApi(`/api/events/${eventId}/ads/${item.exhibitorId}/${action}`, {
        method: 'POST',
      });
      await loadAds();
      setActionMessage(
        adminText(locale, action === 'approve' ? 'adsApprovedMessage' : 'adsRejectedMessage'),
      );
    } catch (e) {
      setActionMessage(
        e instanceof Error ? e.message : adminText(locale, 'adsActionFailed'),
      );
    } finally {
      setActingId(null);
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
          <button onClick={handleLogin} disabled={busy} style={{ ...primaryButtonStyle, width: '100%' }}>
            <span style={adminButtonContentStyle}>
              {busy && <ButtonSpinner />}
              {adminText(locale, 'loginButton')}
            </span>
          </button>
          {message && <p style={{ color: '#b91c1c', marginTop: 12, fontSize: 14 }}>{message}</p>}
        </section>
      </main>
    );
  }

  const pendingItems = ads.filter((item) => item.ad.pending);
  const liveItems = ads.filter((item) => item.ad.live);

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={<AdminNav eventId={eventId} eventName={eventName} current="⑨" locale={locale} />}
    >
      <h1 style={adminPageTitleStyle}>{adminText(locale, 'adsPageTitle')}</h1>
      <CapWarningBanner locale={locale} />
      <p style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>
        {adminText(locale, 'adsPageNote')}
      </p>
      {!adsEnabled && (
        <p style={adminFeedbackStyle}>{adminText(locale, 'adsSettingsOffNote')}</p>
      )}
      {!adsOptionEnabled && (
        <p style={adminErrorTextStyle}>{adminText(locale, 'adsOptionRequiredNote')}</p>
      )}
      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}
      {actionMessage && <p style={adminFeedbackStyle}>{actionMessage}</p>}

      <h2 style={{ fontSize: 16, fontWeight: 800, marginTop: 28 }}>
        {adminText(locale, 'adsPendingSectionTitle')}
      </h2>
      {pendingItems.length === 0 ? (
        <p style={{ fontSize: 14, color: '#64748b', marginTop: 10 }}>
          {adminText(locale, 'adsNoPending')}
        </p>
      ) : (
        pendingItems.map((item) => (
          <article
            key={item.exhibitorId}
            style={{ ...cardStyle, padding: '16px 20px', marginTop: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>{item.shopName}</span>
              <span style={badgeStyle(item.kind === 'advertiser' ? '#7c3aed' : '#0e7490')}>
                {adminText(
                  locale,
                  item.kind === 'advertiser' ? 'adsKindSponsor' : 'adsKindShop',
                )}
              </span>
              <span style={badgeStyle('#d97706')}>
                {adminText(locale, 'adsPendingBadge')}
              </span>
              <span style={{ fontSize: 12.5, color: '#64748b' }}>
                {adminText(locale, 'adsSubmittedAtLabel', {
                  date: dateLabel(item.ad.pendingSubmittedAt, locale),
                })}
              </span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => void handleAction(item, 'approve')}
                disabled={actingId === item.exhibitorId || !adsOptionEnabled}
                style={{ ...approveButtonStyle, opacity: actingId === item.exhibitorId || !adsOptionEnabled ? 0.6 : 1 }}
              >
                <span style={adminButtonContentStyle}>
                  {actingId === item.exhibitorId && <ButtonSpinner />}
                  {adminText(locale, 'adsApproveButton')}
                </span>
              </button>
              <button
                onClick={() => void handleAction(item, 'reject')}
                disabled={actingId === item.exhibitorId || !adsOptionEnabled}
                style={{ ...rejectButtonStyle, opacity: actingId === item.exhibitorId || !adsOptionEnabled ? 0.6 : 1 }}
              >
                {adminText(locale, 'adsRejectButton')}
              </button>
            </div>
            {item.ad.pending && <AdPreview content={item.ad.pending} />}
          </article>
        ))
      )}

      <h2 style={{ fontSize: 16, fontWeight: 800, marginTop: 32 }}>
        {adminText(locale, 'adsLiveSectionTitle')}
      </h2>
      {liveItems.length === 0 ? (
        <p style={{ fontSize: 14, color: '#64748b', marginTop: 10 }}>
          {adminText(locale, 'adsNoEntries')}
        </p>
      ) : (
        liveItems.map((item) => (
          <article
            key={item.exhibitorId}
            style={{ ...cardStyle, padding: '16px 20px', marginTop: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 800, fontSize: 15 }}>{item.shopName}</span>
              <span style={badgeStyle(item.kind === 'advertiser' ? '#7c3aed' : '#0e7490')}>
                {adminText(
                  locale,
                  item.kind === 'advertiser' ? 'adsKindSponsor' : 'adsKindShop',
                )}
              </span>
              <span style={badgeStyle('#16a34a')}>
                {adminText(locale, 'adsLiveBadge')}
              </span>
              <span style={{ fontSize: 12.5, color: '#64748b' }}>
                {adminText(locale, 'adsApprovedAtLabel', {
                  date: dateLabel(item.ad.approvedAt, locale),
                })}
              </span>
              {item.ad.pending && (
                <span style={badgeStyle('#d97706')}>
                  {adminText(locale, 'adsPendingBadge')}
                </span>
              )}
            </div>
            {item.ad.live && <AdPreview content={item.ad.live} />}
          </article>
        ))
      )}
    </AdminShell>
  );
}
