'use client';

// app/event-admin/[eventId]/page.tsx
// プロジェクトのダッシュボード（プロジェクトのホーム画面）。
// プロジェクト一覧（主催者トップ）のカードで「ダッシュボードを開く」を
// 押すとここに入り、この時点で左サイドバーがそのプロジェクトの
// メニューに切り替わる（AdminNav がプロジェクト名を見出しに出す）。
// 中身は軽く保つ: プロジェクト名＋状態、登録者数と上限ゲージ、
// 参加店数・レビュー数（既存の主催者向け API から数えるだけ）、
// 主要画面へのクイックリンク。
// データはすべて既存 API の流用で、新しい集計 API は作らない。
// 画面の固定文は4言語辞書（lib/ui-text.ts の ADMIN_TEXT）。
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
  adminPageTitleStyle,
} from '@/components/AdminBrand';
import { adminText, uiText } from '@/lib/ui-text';
import { AdminShell } from '@/components/AdminShell';
import { CapWarningBanner } from '@/components/CapWarningBanner';
import { AdminNav } from './AdminNav';
import { EventConfig, subscriberUsage } from '@/lib/event';
import { specialSiteUrl } from '@/lib/special-site';

const VIOLET = '#8B5E34';

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

const quickLinkStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '16px 18px',
  fontSize: 15,
  fontWeight: 700,
  color: '#26233B',
  textDecoration: 'none',
  backgroundColor: '#ffffff',
  border: `1px solid ${ADMIN_CARD_BORDER}`,
  borderRadius: 18,
  boxShadow: ADMIN_CARD_SHADOW,
};

function statusBadgeColors(status: EventConfig['status']): {
  bg: string;
  color: string;
  dot: string;
} {
  if (status === 'live') return { bg: '#D9F5E3', color: '#15803d', dot: '#22C55E' };
  if (status === 'ended') return { bg: '#E8EAF1', color: '#5B6472', dot: '#94A3B8' };
  return { bg: '#ECECF1', color: '#55565F', dot: '#9CA3AF' };
}

type DashboardEvent = EventConfig & { subscriberCount?: number };

export default function EventDashboardPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [event, setEvent] = useState<DashboardEvent | null>(null);
  const [shopCount, setShopCount] = useState<number | null>(null);
  const [reviewCount, setReviewCount] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [busy, setBusy] = useState(false);

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

  // プロジェクト本体と登録者数は一覧 API（トップのカードと同じデータ経路）。
  const loadEvent = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi('/api/events');
      const found = (data.events ?? []).find(
        (e: DashboardEvent) => e.id === eventId,
      ) as DashboardEvent | undefined;
      if (!found) throw new Error(adminText(locale, 'loadFailed'));
      setEvent(found);
      setLoadMessage('');
    } catch (e) {
      setLoadMessage(e instanceof Error ? e.message : adminText(locale, 'loadFailed'));
    }
  }, [user, eventId, callApi, locale]);

  useEffect(() => {
    if (user) void loadEvent();
  }, [user, loadEvent]);

  // 参加店数・レビュー数は既存 API の件数を数えるだけ。取れなければ出さない。
  const loadCounts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}/exhibitors`);
      if (Array.isArray(data.exhibitors)) {
        // 参加店数には協賛（広告専用）とスポット（チェックポイント専用）
        // を含めない
        setShopCount(
          data.exhibitors.filter(
            (e: { kind?: string }) => (e.kind ?? 'shop') === 'shop',
          ).length,
        );
      }
    } catch {
      // 件数が出ないだけ
    }
    try {
      const data = await callApi(`/api/events/${eventId}/reviews`);
      if (Array.isArray(data.reviews)) setReviewCount(data.reviews.length);
    } catch {
      // 件数が出ないだけ
    }
  }, [user, eventId, callApi]);

  useEffect(() => {
    if (user) void loadCounts();
  }, [user, loadCounts]);

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

  const badge = event ? statusBadgeColors(event.status) : null;
  const statusText = event
    ? adminText(
        locale,
        event.status === 'live'
          ? 'statusLive'
          : event.status === 'ended'
            ? 'statusEnded'
            : 'statusDraft',
      )
    : '';
  const usage =
    event && typeof event.subscriberCount === 'number'
      ? subscriberUsage(event.subscriberCount, event.subscriberCap)
      : null;
  const usageBarColor = usage
    ? usage.level === 'full'
      ? '#DC2626'
      : usage.level === 'warning'
        ? '#F59E0B'
        : '#B07B45'
    : '#B07B45';

  const quickLinks: Array<{ href: string; label: string; external?: boolean }> = [
    { href: `/event-admin/${eventId}/push`, label: adminText(locale, 'navPush') },
    { href: `/event-admin/${eventId}/schedule`, label: adminText(locale, 'navSchedule') },
    { href: `/event-admin/${eventId}/coupons`, label: adminText(locale, 'navCoupons') },
    { href: `/event-admin/${eventId}/site`, label: adminText(locale, 'navSiteEdit') },
    { href: `/event-admin/${eventId}/ads`, label: adminText(locale, 'navAds') },
    { href: `/event-admin/${eventId}/push-requests`, label: adminText(locale, 'navPushRequests') },
    { href: specialSiteUrl(eventId), label: adminText(locale, 'specialSiteOpen'), external: true },
  ];

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={
        <AdminNav
          eventId={eventId}
          eventName={event?.name}
          current="ダッシュボード"
          locale={locale}
        />
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ ...adminPageTitleStyle, margin: 0 }}>
          {event ? event.name : adminText(locale, 'navDashboard')}
        </h1>
        {event && badge && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 12px',
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 999,
              backgroundColor: badge.bg,
              color: badge.color,
              whiteSpace: 'nowrap',
            }}
          >
            <span
              style={{ width: 7, height: 7, borderRadius: '50%', backgroundColor: badge.dot }}
            />
            {statusText}
          </span>
        )}
      </div>

      <CapWarningBanner locale={locale} />

      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}

      {event && (
        <section style={{ ...cardStyle, marginTop: 22, padding: '20px 22px' }}>
          {usage && (
            <div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  gap: 8,
                  fontSize: 14,
                  color: '#475569',
                }}
              >
                <span style={{ fontWeight: 600 }}>
                  {adminText(locale, 'currentSubscribersLabel')}
                </span>
                <span>
                  {(event.subscriberCount ?? 0).toLocaleString('ja-JP')}
                  {adminText(locale, 'peopleSuffix')} /{' '}
                  {Number(event.subscriberCap).toLocaleString('ja-JP')}
                  {adminText(locale, 'peopleSuffix')}（{usage.percent}%）
                </span>
              </div>
              <div
                style={{
                  height: 8,
                  borderRadius: 999,
                  backgroundColor: '#F3E8D2',
                  overflow: 'hidden',
                  marginTop: 8,
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${usage.percent}%`,
                    backgroundColor: usageBarColor,
                    borderRadius: 999,
                  }}
                />
              </div>
            </div>
          )}
          {(shopCount !== null || reviewCount !== null) && (
            <div
              style={{
                display: 'flex',
                gap: 28,
                flexWrap: 'wrap',
                marginTop: usage ? 18 : 0,
              }}
            >
              {shopCount !== null && (
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b' }}>
                    {adminText(locale, 'dashboardShopsLabel')}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>
                    {shopCount.toLocaleString('ja-JP')}
                  </div>
                </div>
              )}
              {reviewCount !== null && (
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: '#64748b' }}>
                    {adminText(locale, 'dashboardReviewsLabel')}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, marginTop: 2 }}>
                    {reviewCount.toLocaleString('ja-JP')}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <section
        style={{
          marginTop: 22,
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
          gap: 14,
        }}
      >
        {quickLinks.map((link) => (
          <a
            key={link.href}
            href={link.href}
            style={quickLinkStyle}
            {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            {link.label}
            <span aria-hidden="true" style={{ fontSize: 13, color: '#94a3b8' }}>
              {link.external ? '↗' : '→'}
            </span>
          </a>
        ))}
      </section>
    </AdminShell>
  );
}
