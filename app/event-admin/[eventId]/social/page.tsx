'use client';

// app/event-admin/[eventId]/social/page.tsx
// Push-taro.スタンプラリー 主催者向けの Instagram 投稿連携画面。
// ここで作った投稿は「投稿待ちキュー」に入るだけで、製品は Instagram に
// 投稿しない。実際の投稿は主催者自身の Muse が、連携キーを使って
// 朝・昼・夜にキューを確認し、投稿して「投稿済み」を付けに来る。
// そのためこの画面には、投稿作成・投稿一覧に加えて、連携キーの
// 発行／失効と、自分の Muse にそのまま渡せるセットアップ案内文
// （コピー可能）を置く。キーの平文は発行直後だけ案内文に差し込み、
// 画面に恒常表示はしない。
// 画面の固定文は4言語辞書（lib/ui-text.ts の ADMIN_TEXT）。
// ログイン後は共通シェル（components/AdminShell）を使う。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { resolveAppOrigin } from '@/lib/app-origin';
import {
  buildSocialQueueInstructions,
  socialQueueEndpoints,
} from '@/lib/event-social-instructions';
import { AdminNav } from '../AdminNav';

interface SocialPostItem {
  id: string;
  text: string;
  photoUrls: string[];
  status: 'queued' | 'posted';
  createdAt: string | null;
  postedAt: string | null;
  postedUrl: string | null;
}

interface QueueKeyItem {
  id: string;
  createdAt: string | null;
  revokedAt: string | null;
  revoked: boolean;
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

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 16px',
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 12,
  border: '1px solid #E8DCC4',
  backgroundColor: '#ffffff',
  color: '#26233B',
  cursor: 'pointer',
};

const dangerButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: '1px solid #fca5a5',
  color: '#b91c1c',
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 800,
  margin: '0 0 10px',
};

function formatDateTime(iso: string | null, locale: string): string {
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

export default function EventSocialAdminPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [eventName, setEventName] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const [posts, setPosts] = useState<SocialPostItem[]>([]);
  const [loadMessage, setLoadMessage] = useState('');
  const [postText, setPostText] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [photoMessage, setPhotoMessage] = useState('');
  const [creating, setCreating] = useState(false);
  const [createMessage, setCreateMessage] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [keys, setKeys] = useState<QueueKeyItem[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [keyMessage, setKeyMessage] = useState('');
  const [justIssuedKey, setJustIssuedKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

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

  const loadPosts = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}/social-posts`);
      setPosts((data.posts as SocialPostItem[]) ?? []);
      setLoadMessage('');
    } catch (e) {
      setLoadMessage(e instanceof Error ? e.message : adminText(locale, 'loadFailed'));
    }
  }, [user, eventId, callApi, locale]);

  const loadKeys = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}/social-queue-keys`);
      setKeys((data.keys as QueueKeyItem[]) ?? []);
    } catch {
      // キー一覧が読み込めなくても投稿作成は止めない
    }
  }, [user, eventId, callApi]);

  const loadEventName = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}`);
      if (typeof data.event?.name === 'string') setEventName(data.event.name);
    } catch {
      // 名前が読み込めなくても投稿連携は止めない
    }
  }, [user, eventId, callApi]);

  useEffect(() => {
    if (user) {
      void loadPosts();
      void loadKeys();
      void loadEventName();
    }
  }, [user, loadPosts, loadKeys, loadEventName]);

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

  const handlePhotoSelected = async (files: FileList | null) => {
    if (!files || files.length === 0 || !user) return;
    setPhotoMessage('');
    const selected = Array.from(files);
    if (photoUrls.length + selected.length > 4) {
      setPhotoMessage(adminText(locale, 'socialPhotoLimit'));
      return;
    }
    setUploading(true);
    try {
      const idToken = await user.getIdToken();
      const uploaded: string[] = [];
      for (const file of selected) {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch(`/api/events/${eventId}/social-posts/photo`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          body: form,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error ?? adminText(locale, 'socialPhotoUploadFailed'));
        }
        uploaded.push(data.url as string);
      }
      setPhotoUrls((current) => [...current, ...uploaded].slice(0, 4));
    } catch (e) {
      setPhotoMessage(
        e instanceof Error ? e.message : adminText(locale, 'socialPhotoUploadFailed'),
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreatePost = async () => {
    setCreating(true);
    setCreateMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/social-posts`, {
        method: 'POST',
        body: JSON.stringify({ text: postText, photoUrls }),
      });
      if (data.post) {
        setPosts((current) => [data.post as SocialPostItem, ...current]);
      }
      setPostText('');
      setPhotoUrls([]);
      setCreateMessage(adminText(locale, 'socialCreated'));
    } catch (e) {
      setCreateMessage(
        e instanceof Error ? e.message : adminText(locale, 'socialCreateFailed'),
      );
    } finally {
      setCreating(false);
    }
  };

  const handleDeletePost = async (post: SocialPostItem) => {
    if (!window.confirm(adminText(locale, 'socialConfirmDelete'))) return;
    setDeletingId(post.id);
    try {
      await callApi(`/api/events/${eventId}/social-posts/${post.id}`, {
        method: 'DELETE',
      });
      setPosts((current) => current.filter((item) => item.id !== post.id));
    } catch (e) {
      setCreateMessage(
        e instanceof Error ? e.message : adminText(locale, 'socialDeleteFailed'),
      );
    } finally {
      setDeletingId(null);
    }
  };

  const handleIssueKey = async () => {
    setIssuing(true);
    setKeyMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/social-queue-keys`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (typeof data.key === 'string') setJustIssuedKey(data.key);
      setKeyMessage(adminText(locale, 'socialKeyIssued'));
      await loadKeys();
    } catch (e) {
      setKeyMessage(
        e instanceof Error ? e.message : adminText(locale, 'socialKeyIssueFailed'),
      );
    } finally {
      setIssuing(false);
    }
  };

  const handleRevokeKey = async (key: QueueKeyItem) => {
    if (!window.confirm(adminText(locale, 'socialConfirmRevokeKey'))) return;
    setRevokingId(key.id);
    setKeyMessage('');
    try {
      await callApi(`/api/events/${eventId}/social-queue-keys/${key.id}`, {
        method: 'DELETE',
      });
      await loadKeys();
    } catch (e) {
      setKeyMessage(e instanceof Error ? e.message : adminText(locale, 'apiError', { status: '' }));
    } finally {
      setRevokingId(null);
    }
  };

  const instructions = useMemo(
    () =>
      buildSocialQueueInstructions({
        endpoints: socialQueueEndpoints(resolveAppOrigin(), eventId),
        key: justIssuedKey,
      }),
    [eventId, justIssuedKey],
  );

  const handleCopyInstructions = async () => {
    try {
      await navigator.clipboard.writeText(instructions);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // クリップボードが使えない環境ではテキストエリアから手でコピーしてもらう
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
      nav={<AdminNav eventId={eventId} eventName={eventName} current="⑤" locale={locale} />}
    >
      <h1 style={adminPageTitleStyle}>{adminText(locale, 'socialPageTitle')}</h1>
      <CapWarningBanner locale={locale} />
      <p style={{ fontSize: 13.5, color: '#475569', marginTop: 10, lineHeight: 1.7 }}>
        {adminText(locale, 'socialIntro')}
      </p>
      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}

      <section style={{ ...cardStyle, padding: '18px 20px', marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'socialCreateTitle')}</h2>
        <label style={labelStyle}>
          {adminText(locale, 'socialTextLabel')}
          <textarea
            style={{ ...inputStyle, minHeight: 110, resize: 'vertical' }}
            value={postText}
            onChange={(e) => setPostText(e.target.value)}
            placeholder={adminText(locale, 'socialTextPlaceholder')}
            maxLength={2200}
          />
        </label>
        <p style={{ fontSize: 13, fontWeight: 600, margin: '4px 0 8px' }}>
          {adminText(locale, 'socialPhotosLabel')}
        </p>
        {photoUrls.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
            {photoUrls.map((url) => (
              <span key={url} style={{ position: 'relative', display: 'inline-block' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={url}
                  alt=""
                  style={{
                    width: 84,
                    height: 84,
                    objectFit: 'cover',
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                    display: 'block',
                  }}
                />
                <button
                  onClick={() => setPhotoUrls((current) => current.filter((item) => item !== url))}
                  style={{
                    ...secondaryButtonStyle,
                    padding: '2px 8px',
                    fontSize: 11.5,
                    marginTop: 4,
                    width: '100%',
                  }}
                >
                  {adminText(locale, 'socialPhotoRemoveButton')}
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => void handlePhotoSelected(e.target.files)}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading || photoUrls.length >= 4}
          style={secondaryButtonStyle}
        >
          <span style={adminButtonContentStyle}>
            {uploading && <ButtonSpinner />}
            {adminText(locale, 'socialAddPhotoButton')}
          </span>
        </button>
        {photoMessage && <p style={adminErrorTextStyle}>{photoMessage}</p>}
        <div style={{ marginTop: 16 }}>
          <button
            onClick={() => void handleCreatePost()}
            disabled={creating || !postText.trim()}
            style={{ ...primaryButtonStyle, opacity: creating || !postText.trim() ? 0.6 : 1 }}
          >
            <span style={adminButtonContentStyle}>
              {creating && <ButtonSpinner />}
              {adminText(locale, 'socialCreateButton')}
            </span>
          </button>
          {createMessage && (
            <p style={{ fontSize: 13.5, color: '#334155', marginTop: 10 }}>{createMessage}</p>
          )}
        </div>
      </section>

      <section style={{ marginTop: 26 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'socialListTitle')}</h2>
        {posts.length === 0 && !loadMessage ? (
          <p style={{ fontSize: 14, color: '#64748b' }}>{adminText(locale, 'socialEmpty')}</p>
        ) : (
          posts.map((post) => (
            <article key={post.id} style={{ ...cardStyle, padding: '14px 18px', marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    backgroundColor: post.status === 'posted' ? '#15803d' : '#d97706',
                    color: '#ffffff',
                    borderRadius: 6,
                    padding: '3px 10px',
                    fontWeight: 700,
                    fontSize: 12,
                  }}
                >
                  {post.status === 'posted'
                    ? adminText(locale, 'socialStatusPosted')
                    : adminText(locale, 'socialStatusQueued')}
                </span>
                <span style={{ fontSize: 12.5, color: '#64748b' }}>
                  {formatDateTime(post.createdAt, locale)}
                </span>
                <span style={{ flex: 1 }} />
                {post.status === 'queued' && (
                  <button
                    onClick={() => void handleDeletePost(post)}
                    disabled={deletingId === post.id}
                    style={dangerButtonStyle}
                  >
                    <span style={adminButtonContentStyle}>
                      {deletingId === post.id && <ButtonSpinner />}
                      {adminText(locale, 'socialDeleteButton')}
                    </span>
                  </button>
                )}
              </div>
              <p style={{ fontSize: 14, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>{post.text}</p>
              {post.photoUrls.length > 0 && (
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  {post.photoUrls.map((url) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={url}
                        alt=""
                        style={{
                          width: 84,
                          height: 84,
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
              {post.status === 'posted' && (
                <p style={{ fontSize: 12.5, color: '#64748b', margin: '8px 0 0' }}>
                  {adminText(locale, 'socialPostedAtLabel')}: {formatDateTime(post.postedAt, locale)}
                  {post.postedUrl && (
                    <>
                      {' ／ '}
                      <a href={post.postedUrl} target="_blank" rel="noreferrer">
                        {adminText(locale, 'socialPostedUrlLabel')}
                      </a>
                    </>
                  )}
                </p>
              )}
            </article>
          ))
        )}
      </section>

      <section style={{ ...cardStyle, padding: '18px 20px', marginTop: 26 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'socialKeysTitle')}</h2>
        <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.7, margin: '0 0 12px' }}>
          {adminText(locale, 'socialKeysNote')}
        </p>
        <button onClick={() => void handleIssueKey()} disabled={issuing} style={primaryButtonStyle}>
          <span style={adminButtonContentStyle}>
            {issuing && <ButtonSpinner />}
            {adminText(locale, 'socialIssueKeyButton')}
          </span>
        </button>
        {keyMessage && (
          <p style={{ fontSize: 13.5, color: '#334155', marginTop: 10 }}>{keyMessage}</p>
        )}
        {keys.length === 0 ? (
          <p style={{ fontSize: 13.5, color: '#64748b', marginTop: 14 }}>
            {adminText(locale, 'socialKeysEmpty')}
          </p>
        ) : (
          keys.map((key) => (
            <div
              key={key.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                borderTop: '1px solid #eeeafb',
                padding: '10px 0',
                marginTop: 10,
              }}
            >
              <code style={{ fontSize: 12.5, color: '#334155' }}>{key.id}</code>
              <span
                style={{
                  backgroundColor: key.revoked ? '#6b7280' : '#15803d',
                  color: '#ffffff',
                  borderRadius: 6,
                  padding: '3px 10px',
                  fontWeight: 700,
                  fontSize: 12,
                }}
              >
                {key.revoked
                  ? adminText(locale, 'socialKeyRevokedBadge')
                  : adminText(locale, 'socialKeyActiveBadge')}
              </span>
              <span style={{ fontSize: 12.5, color: '#64748b' }}>
                {formatDateTime(key.createdAt, locale)}
              </span>
              <span style={{ flex: 1 }} />
              {!key.revoked && (
                <button
                  onClick={() => void handleRevokeKey(key)}
                  disabled={revokingId === key.id}
                  style={dangerButtonStyle}
                >
                  <span style={adminButtonContentStyle}>
                    {revokingId === key.id && <ButtonSpinner />}
                    {adminText(locale, 'socialRevokeButton')}
                  </span>
                </button>
              )}
            </div>
          ))
        )}
      </section>

      <section style={{ ...cardStyle, padding: '18px 20px', marginTop: 16 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'socialSetupTitle')}</h2>
        <p style={{ fontSize: 13, color: '#475569', lineHeight: 1.7, margin: '0 0 12px' }}>
          {adminText(locale, 'socialSetupNote')}
        </p>
        <textarea
          readOnly
          value={instructions}
          style={{
            ...inputStyle,
            minHeight: 300,
            resize: 'vertical',
            fontFamily: 'monospace',
            fontSize: 12.5,
            lineHeight: 1.7,
          }}
          onFocus={(e) => e.target.select()}
        />
        <div style={{ marginTop: 12 }}>
          <button onClick={() => void handleCopyInstructions()} style={secondaryButtonStyle}>
            {copied ? adminText(locale, 'socialCopied') : adminText(locale, 'socialCopyButton')}
          </button>
        </div>
      </section>
    </AdminShell>
  );
}
