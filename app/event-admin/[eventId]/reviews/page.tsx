'use client';

// app/event-admin/[eventId]/reviews/page.tsx
// Push-taro.スタンプラリー 主催者向けのレビュー管理画面。
// 来場者の書き込み（レビュー）は即時公開が原則で、不適切なものだけ
// 主催者がここで非表示にできる（参加店は触れない）。非表示にしても
// 本人の画面には「非表示中」と分かる形で残り、再表示もできる。
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
  adminPageTitleStyle,
} from '@/components/AdminBrand';
import { adminText, uiText } from '@/lib/ui-text';
import { AdminShell } from '@/components/AdminShell';
import { CapWarningBanner } from '@/components/CapWarningBanner';
import { AdminNav } from '../AdminNav';

interface AdminReviewItem {
  id: string;
  exhibitorId: string;
  exhibitorName: string;
  stars: number;
  /** 投稿時点の項目名つき項目別評価（表示はこの項目名を使う） */
  categoryScores: Array<{ label: string; stars: number }>;
  text: string;
  nickname: string;
  photoUrls: string[];
  visible: boolean;
  createdAt: string | null;
  updatedAt: string | null;
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

const toggleButtonStyle: React.CSSProperties = {
  padding: '7px 16px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 12,
  border: '1px solid #E8DCC4',
  backgroundColor: '#ffffff',
  color: '#26233B',
  cursor: 'pointer',
};

const dangerToggleButtonStyle: React.CSSProperties = {
  ...toggleButtonStyle,
  border: '1px solid #fca5a5',
  color: '#b91c1c',
};

function starLabel(stars: number): string {
  return '★'.repeat(stars) + '☆'.repeat(Math.max(5 - stars, 0));
}

export default function EventReviewsAdminPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [eventName, setEventName] = useState('');
  const [reviews, setReviews] = useState<AdminReviewItem[]>([]);
  const [message, setMessage] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleMessage, setToggleMessage] = useState('');

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

  const loadReviews = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}/reviews`);
      setReviews((data.reviews as AdminReviewItem[]) ?? []);
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
      // 名前が読み込めなくてもレビュー管理は止めない
    }
  }, [user, eventId, callApi]);

  useEffect(() => {
    if (user) {
      void loadReviews();
      void loadEventName();
    }
  }, [user, loadReviews, loadEventName]);

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

  const handleToggleVisibility = async (review: AdminReviewItem) => {
    setTogglingId(review.id);
    setToggleMessage('');
    try {
      await callApi(`/api/events/${eventId}/reviews/${review.id}/visibility`, {
        method: 'POST',
        body: JSON.stringify({ visible: !review.visible }),
      });
      setReviews((current) =>
        current.map((item) =>
          item.id === review.id ? { ...item, visible: !item.visible } : item,
        ),
      );
    } catch (e) {
      setToggleMessage(
        e instanceof Error ? e.message : adminText(locale, 'reviewVisibilityFailed'),
      );
    } finally {
      setTogglingId(null);
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

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={<AdminNav eventId={eventId} eventName={eventName} current="reviews" locale={locale} />}
    >
      <h1 style={adminPageTitleStyle}>{adminText(locale, 'reviewsPageTitle')}</h1>
      <CapWarningBanner locale={locale} />
      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}
      {toggleMessage && <p style={adminErrorTextStyle}>{toggleMessage}</p>}

      {reviews.length === 0 && !loadMessage ? (
        <p style={{ fontSize: 14, color: '#64748b', marginTop: 18 }}>
          {adminText(locale, 'reviewsEmpty')}
        </p>
      ) : (
        reviews.map((review) => {
          const created = review.createdAt ? new Date(review.createdAt) : null;
          const createdLabel =
            created && !Number.isNaN(created.getTime())
              ? created.toLocaleString(locale, {
                  year: 'numeric',
                  month: 'numeric',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })
              : '';
          return (
            <article
              key={review.id}
              style={{
                ...cardStyle,
                padding: '16px 20px',
                marginTop: 12,
                opacity: review.visible ? 1 : 0.75,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 800, fontSize: 15 }}>
                  {review.exhibitorName}
                </span>
                <span style={{ color: '#f59e0b', fontSize: 15 }} aria-label={`${review.stars}/5`}>
                  {starLabel(review.stars)}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: 700 }}>{review.stars}.0</span>
                {!review.visible && (
                  <span
                    style={{
                      backgroundColor: '#6b7280',
                      color: '#ffffff',
                      borderRadius: 6,
                      padding: '3px 10px',
                      fontWeight: 700,
                      fontSize: 12,
                    }}
                  >
                    {adminText(locale, 'reviewHiddenBadge')}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  onClick={() => void handleToggleVisibility(review)}
                  disabled={togglingId === review.id}
                  style={review.visible ? dangerToggleButtonStyle : toggleButtonStyle}
                >
                  <span style={adminButtonContentStyle}>
                    {togglingId === review.id && <ButtonSpinner />}
                    {review.visible
                      ? adminText(locale, 'reviewHideButton')
                      : adminText(locale, 'reviewShowButton')}
                  </span>
                </button>
              </div>
              <p style={{ fontSize: 12.5, color: '#64748b', margin: '6px 0 0' }}>
                {review.categoryScores
                  .map((score) => `${score.label}: ${score.stars}`)
                  .join(' ／ ')}
                {review.nickname ? ` ／ ${review.nickname}` : ''}
                {createdLabel ? ` ／ ${createdLabel}` : ''}
              </p>
              {review.text && (
                <p style={{ fontSize: 14, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
                  {review.text}
                </p>
              )}
              {review.photoUrls.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {review.photoUrls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt={review.exhibitorName}
                        style={{
                          width: 96,
                          height: 96,
                          objectFit: 'cover',
                          borderRadius: 10,
                          border: '1px solid #e2e8f0',
                          display: 'block',
                        }}
                      />
                    </a>
                  ))}
                </div>
              )}
            </article>
          );
        })
      )}
    </AdminShell>
  );
}
