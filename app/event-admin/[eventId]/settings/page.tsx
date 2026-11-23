'use client';

// app/event-admin/[eventId]/settings/page.tsx
// Push-taro.スタンプラリー 主催者向けの設定画面。
// 来場者登録用QRコードの表示・ダウンロード、案内PDFの管理
// （アップロード／一覧／削除、最大5件）と、主催者リンクの管理
// （タイトル＋URL、最大3件）を行う。
// 以前はクーポン管理画面の中にあったが、設定系の項目の受け皿として
// 独立した画面に移した（2026-11-11）。今後設定項目が増えたらここに置く。
// 画面の固定文は4言語辞書（lib/ui-text.ts の ADMIN_TEXT）。
// 見た目は承認済みモック準拠。ログイン後は共通シェル（components/AdminShell）
// を使い、PC は左サイドバー固定の2カラム、スマホはアコーディオンになる。
// フィードバック文はフォームの直下に出す。
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { auth, storage } from '@/lib/firebase-client';
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
import {
  DEFAULT_REVIEW_CATEGORIES,
  REVIEW_CATEGORY_LABEL_MAX_LENGTH,
  REVIEW_CATEGORY_MAX_COUNT,
  REVIEW_CATEGORY_MIN_COUNT,
} from '@/lib/event';
import { AdminShell } from '@/components/AdminShell';
import { CapWarningBanner } from '@/components/CapWarningBanner';
import { AdminNav } from '../AdminNav';
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import { useDropzone } from 'react-dropzone';
import { VisitorQr } from '@/components/VisitorQr';

interface InfoPdf {
  id: string;
  title: string;
  url: string;
}

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

export default function EventSettingsAdminPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [eventName, setEventName] = useState('');
  const [eventStatus, setEventStatus] = useState('');
  const [endMessage, setEndMessage] = useState('');
  const [ending, setEnding] = useState(false);
  const [pdfs, setPdfs] = useState<InfoPdf[]>([]);
  const [linkSlots, setLinkSlots] = useState<Array<{ title: string; url: string }>>([
    { title: '', url: '' },
    { title: '', url: '' },
    { title: '', url: '' },
  ]);
  const [linksMessage, setLinksMessage] = useState('');
  const [linksSaving, setLinksSaving] = useState(false);
  const [stampGoalCount, setStampGoalCount] = useState(5);
  const [stampRewardType, setStampRewardType] = useState<'free-dish' | 'benefit'>('free-dish');
  const [stampBenefitText, setStampBenefitText] = useState('');
  const [stampGoalMessage, setStampGoalMessage] = useState('');
  const [stampGoalSaving, setStampGoalSaving] = useState(false);
  const [rankingMinReviews, setRankingMinReviews] = useState(3);
  const [rankingMessage, setRankingMessage] = useState('');
  const [rankingSaving, setRankingSaving] = useState(false);
  const [reviewCategoryLabels, setReviewCategoryLabels] = useState<string[]>([
    ...DEFAULT_REVIEW_CATEGORIES,
  ]);
  const [reviewCategoriesMessage, setReviewCategoriesMessage] = useState('');
  const [reviewCategoriesSaving, setReviewCategoriesSaving] = useState(false);
  const [loginBonusEnabled, setLoginBonusEnabled] = useState(false);
  const [loginBonusDays, setLoginBonusDays] = useState(7);
  const [loginBonusMessage, setLoginBonusMessage] = useState('');
  const [loginBonusSaving, setLoginBonusSaving] = useState(false);
  const [pdfTitle, setPdfTitle] = useState('');
  const [pdfUploading, setPdfUploading] = useState(false);
  const [message, setMessage] = useState('');
  const [loadMessage, setLoadMessage] = useState('');
  const [pdfMessage, setPdfMessage] = useState('');
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

  const loadPdfs = useCallback(async () => {
    if (!user) return;
    try {
      const pdfData = await callApi(`/api/events/${eventId}/info-pdfs`);
      setPdfs(pdfData.pdfs ?? []);
      setLoadMessage('');
    } catch (e) {
      setLoadMessage(e instanceof Error ? e.message : adminText(locale, 'loadFailed'));
    }
  }, [user, eventId, callApi, locale]);

  useEffect(() => {
    if (user) void loadPdfs();
  }, [user, loadPdfs]);

  const loadLinks = useCallback(async () => {
    if (!user) return;
    try {
      const data = await callApi(`/api/events/${eventId}`);
      if (typeof data.event?.name === 'string') setEventName(data.event.name);
      if (typeof data.event?.status === 'string') setEventStatus(data.event.status);
      if (typeof data.event?.stampGoalCount === 'number') {
        setStampGoalCount(data.event.stampGoalCount);
      }
      if (data.event?.stampRewardType === 'benefit') {
        setStampRewardType('benefit');
      } else if (data.event?.stampRewardType === 'free-dish') {
        setStampRewardType('free-dish');
      }
      if (typeof data.event?.stampBenefitText === 'string') {
        setStampBenefitText(data.event.stampBenefitText);
      }
      if (typeof data.event?.rankingMinReviews === 'number') {
        setRankingMinReviews(data.event.rankingMinReviews);
      }
      if (Array.isArray(data.event?.reviewCategories)) {
        const labels = data.event.reviewCategories.filter(
          (value: unknown): value is string => typeof value === 'string',
        );
        if (labels.length > 0) setReviewCategoryLabels(labels);
      }
      if (typeof data.event?.loginBonusEnabled === 'boolean') {
        setLoginBonusEnabled(data.event.loginBonusEnabled);
      }
      if (typeof data.event?.loginBonusDays === 'number') {
        setLoginBonusDays(data.event.loginBonusDays);
      }
      const links: Array<{ title: string; url: string }> = data.event?.links ?? [];
      setLinkSlots(
        [0, 1, 2].map((i) => ({
          title: links[i]?.title ?? '',
          url: links[i]?.url ?? '',
        })),
      );
    } catch {
      // リンクが読み込めなくてもPDF管理は止めない
    }
  }, [user, eventId, callApi]);

  useEffect(() => {
    if (user) void loadLinks();
  }, [user, loadLinks]);

  const updateLinkSlot = (index: number, field: 'title' | 'url', value: string) => {
    setLinkSlots((slots) =>
      slots.map((slot, i) => (i === index ? { ...slot, [field]: value } : slot)),
    );
  };

  const handleSaveLinks = async () => {
    const normalized: Array<{ title: string; url: string }> = [];
    for (const slot of linkSlots) {
      const title = slot.title.trim();
      const url = slot.url.trim();
      if (!title && !url) continue;
      if (!title || !url) {
        setLinksMessage(adminText(locale, 'linkPairError'));
        return;
      }
      if (!url.startsWith('https://')) {
        setLinksMessage(adminText(locale, 'linkUrlError'));
        return;
      }
      normalized.push({ title, url });
    }
    setLinksSaving(true);
    setLinksMessage('');
    try {
      await callApi(`/api/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ links: normalized }),
      });
      setLinksMessage(adminText(locale, 'linksSaved'));
      setLinkSlots(
        [0, 1, 2].map((i) => ({
          title: normalized[i]?.title ?? '',
          url: normalized[i]?.url ?? '',
        })),
      );
    } catch (e) {
      setLinksMessage(e instanceof Error ? e.message : adminText(locale, 'linksSaveFailed'));
    } finally {
      setLinksSaving(false);
    }
  };

  const handleSaveStampGoal = async () => {
    if (stampRewardType === 'benefit' && !stampBenefitText.trim()) {
      setStampGoalMessage(adminText(locale, 'stampBenefitRequired'));
      return;
    }
    setStampGoalSaving(true);
    setStampGoalMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ stampGoalCount, stampRewardType, stampBenefitText }),
      });
      if (typeof data.event?.stampGoalCount === 'number') {
        setStampGoalCount(data.event.stampGoalCount);
      }
      if (data.event?.stampRewardType === 'benefit') {
        setStampRewardType('benefit');
      } else if (data.event?.stampRewardType === 'free-dish') {
        setStampRewardType('free-dish');
      }
      if (typeof data.event?.stampBenefitText === 'string') {
        setStampBenefitText(data.event.stampBenefitText);
      }
      setStampGoalMessage(adminText(locale, 'stampGoalSaved'));
    } catch (e) {
      setStampGoalMessage(
        e instanceof Error ? e.message : adminText(locale, 'stampGoalSaveFailed'),
      );
    } finally {
      setStampGoalSaving(false);
    }
  };

  const handleSaveRanking = async () => {
    setRankingSaving(true);
    setRankingMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ rankingMinReviews }),
      });
      if (typeof data.event?.rankingMinReviews === 'number') {
        setRankingMinReviews(data.event.rankingMinReviews);
      }
      setRankingMessage(adminText(locale, 'rankingSaved'));
    } catch (e) {
      setRankingMessage(
        e instanceof Error ? e.message : adminText(locale, 'rankingSaveFailed'),
      );
    } finally {
      setRankingSaving(false);
    }
  };

  const updateReviewCategoryLabel = (index: number, value: string) => {
    setReviewCategoryLabels((labels) =>
      labels.map((label, i) => (i === index ? value : label)),
    );
  };

  const handleSaveReviewCategories = async () => {
    const normalized = reviewCategoryLabels.map((label) => label.trim());
    const invalid =
      normalized.length < REVIEW_CATEGORY_MIN_COUNT ||
      normalized.length > REVIEW_CATEGORY_MAX_COUNT ||
      normalized.some(
        (label) => !label || label.length > REVIEW_CATEGORY_LABEL_MAX_LENGTH,
      ) ||
      new Set(normalized).size !== normalized.length;
    if (invalid) {
      setReviewCategoriesMessage(
        adminText(locale, 'reviewCategoriesInvalidError'),
      );
      return;
    }
    setReviewCategoriesSaving(true);
    setReviewCategoriesMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ reviewCategories: normalized }),
      });
      if (Array.isArray(data.event?.reviewCategories)) {
        setReviewCategoryLabels(data.event.reviewCategories);
      }
      setReviewCategoriesMessage(adminText(locale, 'reviewCategoriesSaved'));
    } catch (e) {
      setReviewCategoriesMessage(
        e instanceof Error
          ? e.message
          : adminText(locale, 'reviewCategoriesSaveFailed'),
      );
    } finally {
      setReviewCategoriesSaving(false);
    }
  };

  const handleSaveLoginBonus = async () => {
    setLoginBonusSaving(true);
    setLoginBonusMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}`, {
        method: 'PATCH',
        body: JSON.stringify({ loginBonusEnabled, loginBonusDays }),
      });
      if (typeof data.event?.loginBonusEnabled === 'boolean') {
        setLoginBonusEnabled(data.event.loginBonusEnabled);
      }
      if (typeof data.event?.loginBonusDays === 'number') {
        setLoginBonusDays(data.event.loginBonusDays);
      }
      setLoginBonusMessage(adminText(locale, 'loginBonusSaved'));
    } catch (e) {
      setLoginBonusMessage(
        e instanceof Error ? e.message : adminText(locale, 'loginBonusSaveFailed'),
      );
    } finally {
      setLoginBonusSaving(false);
    }
  };

  const handleEndProject = async () => {
    if (!window.confirm(adminText(locale, 'confirmEndProject'))) return;
    setEnding(true);
    setEndMessage('');
    try {
      const data = await callApi(`/api/events/${eventId}/end`, { method: 'POST' });
      if (typeof data.event?.status === 'string') setEventStatus(data.event.status);
      else setEventStatus('ended');
      setEndMessage(adminText(locale, 'projectEndDone'));
    } catch (e) {
      setEndMessage(e instanceof Error ? e.message : adminText(locale, 'projectEndFailed'));
    } finally {
      setEnding(false);
    }
  };

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

  const handlePdfDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file || !user) return;
      setPdfUploading(true);
      setPdfMessage('');
      try {
        const storagePath = `organizers/${user.uid}/events/${eventId}/info-pdfs/${crypto.randomUUID()}.pdf`;
        const ref = storageRef(storage, storagePath);
        await uploadBytes(ref, file, { contentType: 'application/pdf' });
        const url = await getDownloadURL(ref);
        await callApi(`/api/events/${eventId}/info-pdfs`, {
          method: 'POST',
          body: JSON.stringify({
            title: pdfTitle.trim() || file.name.replace(/\.pdf$/i, ''),
            url,
            storagePath,
          }),
        });
        setPdfTitle('');
        setPdfMessage(adminText(locale, 'pdfAdded'));
        await loadPdfs();
      } catch (e) {
        setPdfMessage(e instanceof Error ? e.message : adminText(locale, 'pdfAddFailed'));
      } finally {
        setPdfUploading(false);
      }
    },
    [user, eventId, pdfTitle, callApi, loadPdfs, locale],
  );

  const pdfDropzone = useDropzone({
    onDrop: handlePdfDrop,
    accept: { 'application/pdf': ['.pdf'] },
    maxFiles: 1,
    disabled: pdfUploading || pdfs.length >= 5,
  });

  const handleDeletePdf = async (pdfId: string) => {
    if (!window.confirm(adminText(locale, 'confirmDeletePdf'))) return;
    setBusy(true);
    setPdfMessage('');
    try {
      await callApi(`/api/events/${eventId}/info-pdfs/${pdfId}`, { method: 'DELETE' });
      setPdfMessage(adminText(locale, 'pdfDeleted'));
      await loadPdfs();
    } catch (e) {
      setPdfMessage(e instanceof Error ? e.message : adminText(locale, 'pdfDeleteFailed'));
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

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={<AdminNav eventId={eventId} eventName={eventName} current="⑥" locale={locale} />}
    >
      <h1 style={adminPageTitleStyle}>{adminText(locale, 'settingsPageTitle')}</h1>
      <CapWarningBanner locale={locale} />
      {loadMessage && <p style={adminErrorTextStyle}>{loadMessage}</p>}

      <section style={{ marginTop: 22 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'visitorQrTitle')}</h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'visitorQrNote')}
        </p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <VisitorQr
            eventId={eventId}
            locale={locale}
            showUrl
            buttonStyle={primaryButtonStyle}
          />
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>
          {adminText(locale, 'pdfsTitle', { count: String(pdfs.length) })}
        </h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'pdfsNote')}
        </p>
        {pdfs.map((pdf) => (
          <div
            key={pdf.id}
            style={{ ...cardStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 20px', marginTop: 12 }}
          >
            <a href={pdf.url} target="_blank" rel="noreferrer" style={{ fontSize: 14, fontWeight: 600, color: VIOLET }}>
              {pdf.title}
            </a>
            <button onClick={() => void handleDeletePdf(pdf.id)} disabled={busy} style={dangerButtonStyle}>
              {adminText(locale, 'deleteButton')}
            </button>
          </div>
        ))}
        {pdfMessage && <p style={adminFeedbackStyle}>{pdfMessage}</p>}
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            {adminText(locale, 'pdfTitleLabel')}
            <input style={inputStyle} value={pdfTitle} onChange={(e) => setPdfTitle(e.target.value)} placeholder={adminText(locale, 'pdfTitlePlaceholder')} />
          </label>
          <div
            {...pdfDropzone.getRootProps()}
            style={{
              border: `2px dashed ${pdfDropzone.isDragActive ? '#8B5E34' : '#D9BE8C'}`,
              backgroundColor: pdfDropzone.isDragActive ? '#FBF6EA' : '#ffffff',
              borderRadius: 16,
              padding: 24,
              marginTop: 12,
              textAlign: 'center',
              fontSize: 14,
              color: '#475569',
              cursor: pdfs.length >= 5 ? 'not-allowed' : 'pointer',
              opacity: pdfs.length >= 5 ? 0.5 : 1,
            }}
          >
            <input {...pdfDropzone.getInputProps()} />
            {pdfUploading
              ? adminText(locale, 'pdfUploading')
              : pdfs.length >= 5
                ? adminText(locale, 'pdfCapReached')
                : adminText(locale, 'pdfDropHint')}
          </div>
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'organizerLinksTitle')}</h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'organizerLinksNote')}
        </p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          {linkSlots.map((slot, i) => (
            <div key={i} style={{ marginBottom: i < linkSlots.length - 1 ? 20 : 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                {adminText(locale, 'linkSlotLabel', { n: String(i + 1) })}
              </div>
              <label style={labelStyle}>
                {adminText(locale, 'linkTitleLabel')}
                <input
                  style={inputStyle}
                  value={slot.title}
                  onChange={(e) => updateLinkSlot(i, 'title', e.target.value)}
                />
              </label>
              <label style={{ ...labelStyle, marginBottom: 0 }}>
                {adminText(locale, 'linkUrlLabel')}
                <input
                  style={inputStyle}
                  value={slot.url}
                  onChange={(e) => updateLinkSlot(i, 'url', e.target.value)}
                  placeholder="https://"
                  inputMode="url"
                />
              </label>
            </div>
          ))}
          <button
            onClick={() => void handleSaveLinks()}
            disabled={linksSaving}
            style={{ ...primaryButtonStyle, marginTop: 20 }}
          >
            <span style={adminButtonContentStyle}>
              {linksSaving && <ButtonSpinner />}
              {adminText(locale, 'linksSaveButton')}
            </span>
          </button>
          {linksMessage && <p style={adminFeedbackStyle}>{linksMessage}</p>}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'stampSettingsTitle')}</h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'stampGoalNote')}
        </p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            {adminText(locale, 'stampGoalLabel')}
            <select
              style={inputStyle}
              value={stampGoalCount}
              onChange={(e) => setStampGoalCount(Number(e.target.value))}
            >
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <fieldset style={{ border: 'none', padding: 0, margin: '20px 0 0' }}>
            <legend style={{ fontSize: 13, fontWeight: 600, padding: 0 }}>
              {adminText(locale, 'stampRewardTypeLabel')}
            </legend>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                fontWeight: 600,
                marginTop: 10,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="stampRewardType"
                checked={stampRewardType === 'free-dish'}
                onChange={() => setStampRewardType('free-dish')}
                style={{ width: 18, height: 18 }}
              />
              {adminText(locale, 'stampRewardFreeDishOption')}
            </label>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 14,
                fontWeight: 600,
                marginTop: 8,
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="stampRewardType"
                checked={stampRewardType === 'benefit'}
                onChange={() => setStampRewardType('benefit')}
                style={{ width: 18, height: 18 }}
              />
              {adminText(locale, 'stampRewardBenefitOption')}
            </label>
          </fieldset>
          {stampRewardType === 'benefit' && (
            <label style={{ ...labelStyle, marginBottom: 0 }}>
              {adminText(locale, 'stampBenefitTextLabel')}
              <input
                style={inputStyle}
                value={stampBenefitText}
                maxLength={100}
                placeholder={adminText(locale, 'stampBenefitTextPlaceholder')}
                onChange={(e) => setStampBenefitText(e.target.value)}
              />
            </label>
          )}
          <p style={{ fontSize: 12.5, color: '#64748b', margin: '12px 0 0' }}>
            {adminText(locale, 'stampRewardNote')}
          </p>
          <button
            onClick={() => void handleSaveStampGoal()}
            disabled={stampGoalSaving}
            style={{ ...primaryButtonStyle, marginTop: 20 }}
          >
            <span style={adminButtonContentStyle}>
              {stampGoalSaving && <ButtonSpinner />}
              {adminText(locale, 'stampGoalSaveButton')}
            </span>
          </button>
          {stampGoalMessage && <p style={adminFeedbackStyle}>{stampGoalMessage}</p>}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'rankingSettingsTitle')}</h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'rankingMinNote')}
        </p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>
            {adminText(locale, 'rankingMinLabel')}
            <select
              style={inputStyle}
              value={rankingMinReviews}
              onChange={(e) => setRankingMinReviews(Number(e.target.value))}
            >
              {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void handleSaveRanking()}
            disabled={rankingSaving}
            style={{ ...primaryButtonStyle, marginTop: 20 }}
          >
            <span style={adminButtonContentStyle}>
              {rankingSaving && <ButtonSpinner />}
              {adminText(locale, 'rankingSaveButton')}
            </span>
          </button>
          {rankingMessage && <p style={adminFeedbackStyle}>{rankingMessage}</p>}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'reviewCategoriesSettingsTitle')}</h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'reviewCategoriesNote')}
        </p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          {reviewCategoryLabels.map((label, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 10,
                marginBottom: i < reviewCategoryLabels.length - 1 ? 14 : 0,
              }}
            >
              <label style={{ ...labelStyle, marginBottom: 0, flex: 1 }}>
                {adminText(locale, 'reviewCategorySlotLabel', { n: String(i + 1) })}
                <input
                  style={inputStyle}
                  value={label}
                  maxLength={REVIEW_CATEGORY_LABEL_MAX_LENGTH}
                  onChange={(e) => updateReviewCategoryLabel(i, e.target.value)}
                />
              </label>
              <button
                onClick={() =>
                  setReviewCategoryLabels((labels) =>
                    labels.filter((_, index) => index !== i),
                  )
                }
                disabled={reviewCategoryLabels.length <= REVIEW_CATEGORY_MIN_COUNT}
                style={{
                  ...dangerButtonStyle,
                  opacity:
                    reviewCategoryLabels.length <= REVIEW_CATEGORY_MIN_COUNT
                      ? 0.5
                      : 1,
                }}
              >
                {adminText(locale, 'deleteButton')}
              </button>
            </div>
          ))}
          <div style={{ marginTop: 16 }}>
            <button
              onClick={() =>
                setReviewCategoryLabels((labels) => [...labels, ''])
              }
              disabled={reviewCategoryLabels.length >= REVIEW_CATEGORY_MAX_COUNT}
              style={{
                padding: '7px 16px',
                fontSize: 13,
                fontWeight: 600,
                borderRadius: 12,
                border: '1px solid #E8DCC4',
                backgroundColor: '#ffffff',
                color: VIOLET,
                cursor: 'pointer',
                opacity:
                  reviewCategoryLabels.length >= REVIEW_CATEGORY_MAX_COUNT
                    ? 0.5
                    : 1,
              }}
            >
              {adminText(locale, 'reviewCategoryAddButton')}
            </button>
          </div>
          <button
            onClick={() => void handleSaveReviewCategories()}
            disabled={reviewCategoriesSaving}
            style={{ ...primaryButtonStyle, marginTop: 20 }}
          >
            <span style={adminButtonContentStyle}>
              {reviewCategoriesSaving && <ButtonSpinner />}
              {adminText(locale, 'reviewCategoriesSaveButton')}
            </span>
          </button>
          {reviewCategoriesMessage && (
            <p style={adminFeedbackStyle}>{reviewCategoriesMessage}</p>
          )}
        </div>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={sectionTitleStyle}>{adminText(locale, 'loginBonusSettingsTitle')}</h2>
        <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 5 }}>
          {adminText(locale, 'loginBonusNote')}
        </p>
        <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={loginBonusEnabled}
              onChange={(e) => setLoginBonusEnabled(e.target.checked)}
              style={{ width: 18, height: 18 }}
            />
            {adminText(locale, 'loginBonusEnabledLabel')}
          </label>
          <label style={{ ...labelStyle, marginTop: 16, marginBottom: 0 }}>
            {adminText(locale, 'loginBonusDaysLabel')}
            <select
              style={inputStyle}
              value={loginBonusDays}
              onChange={(e) => setLoginBonusDays(Number(e.target.value))}
            >
              {Array.from({ length: 16 }, (_, i) => i + 5).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={() => void handleSaveLoginBonus()}
            disabled={loginBonusSaving}
            style={{ ...primaryButtonStyle, marginTop: 20 }}
          >
            <span style={adminButtonContentStyle}>
              {loginBonusSaving && <ButtonSpinner />}
              {adminText(locale, 'loginBonusSaveButton')}
            </span>
          </button>
          {loginBonusMessage && <p style={adminFeedbackStyle}>{loginBonusMessage}</p>}
        </div>
      </section>

      {(eventStatus === 'live' || eventStatus === 'ended') && (
        <section style={{ marginTop: 32 }}>
          <h2 style={sectionTitleStyle}>{adminText(locale, 'projectManageTitle')}</h2>
          <div style={{ ...cardStyle, marginTop: 12, padding: 24 }}>
            {eventStatus === 'live' ? (
              <>
                <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
                  {adminText(locale, 'projectEndNote')}
                </p>
                <button
                  onClick={() => void handleEndProject()}
                  disabled={ending}
                  style={{ ...dangerButtonStyle, marginTop: 16 }}
                >
                  <span style={adminButtonContentStyle}>
                    {ending && <ButtonSpinner />}
                    {adminText(locale, 'projectEndButton')}
                  </span>
                </button>
              </>
            ) : (
              <p style={{ fontSize: 13, color: '#475569', margin: 0 }}>
                {adminText(locale, 'projectEndedNote')}
              </p>
            )}
            {endMessage && <p style={adminFeedbackStyle}>{endMessage}</p>}
          </div>
        </section>
      )}
    </AdminShell>
  );
}
