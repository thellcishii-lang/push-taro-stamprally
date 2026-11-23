'use client';

// app/event-admin/[eventId]/push-requests/page.tsx
// Push-taro.スタンプラリー 主催者向けのプッシュ申請画面。
// 参加店が店舗ページから申請したプッシュ配信は、ここで承認されて
// 初めて購読者全員に配信される（承認したその場で配信される）。
// 有料のプロジェクトでは、支払いが完了した申請だけが承認待ちに
// なり、未払いの申請は承認できない（状態だけ一覧で見える）。
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
import type { Locale } from '@/lib/i18n';
import { AdminShell } from '@/components/AdminShell';
import { CapWarningBanner } from '@/components/CapWarningBanner';
import { AdminNav } from '../AdminNav';

type PushRequestStatus = 'unpaid' | 'pending' | 'sent' | 'rejected' | 'failed';

interface PushRequestItem {
  id: string;
  exhibitorId: string;
  exhibitorName: string;
  title: string;
  body: string;
  status: PushRequestStatus;
  feeAmount: number;
  sentCount: number | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  texts: Array<{ locale: string; title: string; body: string }>;
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

const STATUS_BADGES = {
  unpaid: { color: '#b45309', key: 'pushRequestStatusUnpaid' },
  pending: { color: '#d97706', key: 'pushRequestStatusPending' },
  sent: { color: '#16a34a', key: 'pushRequestStatusSent' },
  rejected: { color: '#6b7280', key: 'pushRequestStatusRejected' },
  failed: { color: '#b91c1c', key: 'pushRequestStatusFailed' },
} as const satisfies Record<PushRequestStatus, { color: string; key: string }>;

function RequestPreview({
  item,
  locale,
}: {
  item: PushRequestItem;
  locale: Locale;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <p style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>{item.title}</p>
      <p style={{ fontSize: 14, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
        {item.body}
      </p>
      <p style={{ fontSize: 12, fontWeight: 700, color: '#64748b', margin: '12px 0 0' }}>
        {adminText(locale, 'pushRequestTextsLabel')}
      </p>
      {item.texts.map((text) => (
        <div key={text.locale} style={{ marginTop: 6 }}>
          <span
            style={{
              fontSize: 11.5,
              fontWeight: 700,
              color: '#8B5E34',
              border: '1px solid #E8DCC4',
              borderRadius: 6,
              padding: '1px 7px',
              marginRight: 8,
            }}
          >
            {text.locale}
          </span>
          <span style={{ fontSize: 13, fontWeight: 700 }}>{text.title}</span>
          <span style={{ fontSize: 13, color: '#334155' }}> — {text.body}</span>
        </div>
      ))}
      {item.status === 'sent' && item.sentCount !== null && (
        <p style={{ fontSize: 12.5, color: '#64748b', margin: '10px 0 0' }}>
          {adminText(locale, 'pushRequestSentCountLabel', {
            count: String(item.sentCount),
          })}
        </p>
      )}
      {item.status === 'failed' && item.error && (
        <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '10px 0 0' }}>
          {item.error}
        </p>
      )}
    </div>
  );
}

export default function EventPushRequestsAdminPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [eventName, setEventName] = useState('');
  const [requests, setRequests] = useState<PushRequestItem[]>([]);
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

  const loadRequests = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}/push-requests`);
      setRequests((data.requests as PushRequestItem[]) ?? []);
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
      // 名前が読み込めなくても申請管理は止めない
    }
  }, [user, eventId, callApi]);

  useEffect(() => {
    if (user) {
      void loadRequests();
      void loadEventName();
    }
  }, [user, loadRequests, loadEventName]);

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

  const handleAction = async (item: PushRequestItem, action: 'approve' | 'reject') => {
    setActingId(item.id);
    setActionMessage('');
    try {
      const data = await callApi(
        `/api/events/${eventId}/push-requests/${item.id}/${action}`,
        { method: 'POST' },
      );
      await loadRequests();
      if (action === 'reject') {
        setActionMessage(adminText(locale, 'pushRequestRejectedMessage'));
      } else if (data.request?.status === 'sent') {
        setActionMessage(adminText(locale, 'pushRequestSentMessage'));
      } else {
        setActionMessage(adminText(locale, 'pushRequestSendFailedMessage'));
      }
    } catch (e) {
      setActionMessage(
        e instanceof Error ? e.message : adminText(locale, 'pushRequestActionFailed'),
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

  const pendingItems = requests.filter((item) => item.status === 'pending');
  const otherItems = requests.filter((item) => item.status !== 'pending');

  const renderItem = (item: PushRequestItem, withActions: boolean) => {
    const badge = STATUS_BADGES[item.status];
    return (
      <article
        key={item.id}
        style={{ ...cardStyle, padding: '16px 20px', marginTop: 12 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 800, fontSize: 15 }}>{item.exhibitorName}</span>
          <span style={badgeStyle(badge.color)}>
            {adminText(locale, badge.key)}
          </span>
          <span style={{ fontSize: 12.5, color: '#64748b' }}>
            {item.feeAmount > 0
              ? adminText(locale, 'pushRequestFeeLabel', {
                  price: item.feeAmount.toLocaleString('ja-JP'),
                })
              : adminText(locale, 'pushRequestFreeLabel')}
          </span>
          <span style={{ fontSize: 12.5, color: '#64748b' }}>
            {adminText(locale, 'pushRequestSubmittedAtLabel', {
              date: dateLabel(item.createdAt, locale),
            })}
          </span>
          {withActions && (
            <>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => void handleAction(item, 'approve')}
                disabled={actingId === item.id}
                style={{ ...approveButtonStyle, opacity: actingId === item.id ? 0.6 : 1 }}
              >
                <span style={adminButtonContentStyle}>
                  {actingId === item.id && <ButtonSpinner />}
                  {adminText(locale, 'pushRequestApproveButton')}
                </span>
              </button>
              <button
                onClick={() => void handleAction(item, 'reject')}
                disabled={actingId === item.id}
                style={{ ...rejectButtonStyle, opacity: actingId === item.id ? 0.6 : 1 }}
              >
                {adminText(locale, 'pushRequestRejectButton')}
              </button>
            </>
          )}
        </div>
        <RequestPreview item={item} locale={locale} />
      </article>
    );
  };

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={<AdminNav eventId={eventId} eventName={eventName} current="⑩" locale={locale} />}
    >
      <h1 style={adminPageTitleStyle}>{adminText(locale, 'pushRequestsPageTitle')}</h1>
      <CapWarningBanner locale={locale} />
      <p style={{ fontSize: 13, color: '#475569', marginTop: 6 }}>
        {adminText(locale, 'pushRequestsPageNote')}
      </p>
      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}
      {actionMessage && <p style={adminFeedbackStyle}>{actionMessage}</p>}

      <h2 style={{ fontSize: 16, fontWeight: 800, marginTop: 28 }}>
        {adminText(locale, 'pushRequestsPendingSectionTitle')}
      </h2>
      {pendingItems.length === 0 ? (
        <p style={{ fontSize: 14, color: '#64748b', marginTop: 10 }}>
          {adminText(locale, 'pushRequestsNoPending')}
        </p>
      ) : (
        pendingItems.map((item) => renderItem(item, true))
      )}

      <h2 style={{ fontSize: 16, fontWeight: 800, marginTop: 32 }}>
        {adminText(locale, 'pushRequestsHistorySectionTitle')}
      </h2>
      {otherItems.length === 0 ? (
        <p style={{ fontSize: 14, color: '#64748b', marginTop: 10 }}>
          {adminText(locale, 'pushRequestsNoEntries')}
        </p>
      ) : (
        otherItems.map((item) => renderItem(item, false))
      )}
    </AdminShell>
  );
}
