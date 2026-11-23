'use client';

// app/e/[eventId]/page.tsx
// Push-taro.スタンプラリー の来場者登録画面（QRコードの着地先）。
// 本人確認の方式は契約のデータ上のスイッチ（公開APIの smsAuthEnabled）で
// 切り替わる。画面に切り替え UI は無い:
// - SMSオン: プロジェクト情報の確認 → 電話番号のSMS認証 → 通知許可と
//   FCMトークン取得 → 登録API。電話番号認証の作法は本家の登録画面
//   （app/subscribe）に合わせている。SMSを送る直前に残高ゲート
//   （/sms-gate）を通す。
// - SMSオフ（既定）: 電話番号は使わない。匿名認証で端末の識別子（uid）を
//   得て、そのまま通知許可と登録APIへ進む。
// 画面の固定文は4言語辞書（lib/ui-text.ts）で切り替える。初期表示は
// プロジェクトのデフォルト言語、本人が切り替えたらその選択が優先される。
// クーポン表示: 取得済みを上部に固定し、全カタログは出店者ごとの
// アコーディオンにする（100件あっても縦に伸びないように）。
// 取得状態は画面を開いている間15秒ごと＋タブ復帰時に再取得し、
// 消込が手動リロードなしで「使用済み」に切り替わるようにしている。
// 見た目は承認済みモック（来場者 v2）準拠: ブランド行＋薄紫のプロジェクト
// カード（言語はピル選択）、取得済みカードはQR常時表示、登録フェーズでは
// 画面下に固定したプッシュ有効化バナーが登録ボタンになる。
// 結果・エラーの文は、操作した場所のすぐ近くに出す（ページ末尾には出さない）。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  ConfirmationResult,
  RecaptchaVerifier,
  User,
  onAuthStateChanged,
  signInAnonymously,
  signInWithPhoneNumber,
} from 'firebase/auth';
import { auth, requestFCMToken } from '@/lib/firebase-client';
import {
  SUPPORTED_LOCALES,
  resolveLocale,
  type Locale,
} from '@/lib/i18n';
import { uiText, type UiTextKey } from '@/lib/ui-text';
import {
  AGE_BANDS,
  GENDERS,
  type AgeBand,
  type Gender,
} from '@/lib/member-demographics';
import { specialSiteUrl } from '@/lib/special-site';
import { themeCssVars, themePalette } from '@/lib/theme-color';
import PoweredByFooter from '@/components/PoweredByFooter';
import StampCelebration from '@/components/StampCelebration';
import {
  isCelebratedInStorage,
  markCelebratedInStorage,
  pickCelebrationCoupon,
  safeLocalStorage,
} from '@/lib/stamp-celebration';
import { buildCouponGroups } from '@/lib/coupon-groups';
import { haversineMeters, type GeoPoint } from '@/lib/geocode';
import { DEFAULT_REVIEW_CATEGORIES } from '@/lib/event';
import {
  buildFreeCouponQrPayload,
  buildStampQrPayload,
} from '@/lib/stamp-qr';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode } from 'html5-qrcode';

interface PublicEventLink {
  title: string;
  url: string;
}

interface PublicEvent {
  name: string;
  startDate: string;
  endDate: string;
  status: 'draft' | 'live' | 'ended';
  resetMode: 'full-daily' | 'keep-phones';
  defaultLocale: string;
  /** 入場用QRの取り込みが有効か（主催者設定。オフなら画面に何も出さない） */
  admissionQrEnabled: boolean;
  /**
   * 登録に SMS 電話認証を使うか（契約のデータ上のスイッチ。公開APIが
   * 契約レコードから解決して返す）。false（既定）は端末認証で、
   * 電話番号入力の段階そのものが出ない。
   */
  smsAuthEnabled: boolean;
  /** レビューの項目別評価の項目（主催者設定。未取得なら既定の4項目に倒す） */
  reviewCategories?: string[];
  /** 主催者リンク（最大3件）。未登録なら空で、画面に何も出さない */
  links?: PublicEventLink[];
  /** テーマカラー（特設サイト設定）。未設定は null で既定の茶系になる */
  themeColor?: string | null;
}

interface AdmissionQrState {
  stored: boolean;
  content: string | null;
}

type Phase =
  | 'loading'
  | 'not-found'
  | 'unavailable'
  | 'phone'
  | 'code'
  | 'register'
  | 'done';

interface PublicCoupon {
  id: string;
  title: string;
  description: string;
  exhibitorName: string;
  keywords: string[];
}

interface MemberClaim {
  claimId: string;
  couponId: string;
  title: string;
  exhibitorName: string;
  status: 'claimed' | 'redeemed';
}

interface MemberFreeCoupon {
  id: string;
  round: number;
  /** 発行元（'stamp' | 'login'。旧データでは未設定 = 'stamp'） */
  kind?: string;
  /** 発行時点の特典スナップショット（旧データでは未設定 = 'free-dish'） */
  rewardType?: string;
  benefitText?: string;
  status: 'active' | 'used';
  usedExhibitorName: string | null;
}

interface MemberLoginBonus {
  enabled: boolean;
  goalDays: number;
  countInCycle: number;
  remaining: number;
  checkedInToday: boolean;
  cyclesCompleted: number;
  totalEarned: number;
}

interface MemberStampCard {
  memberId: string;
  round: number;
  goalCount: number;
  /** プロジェクトの現在の特典設定（旧データでは未設定 = 'free-dish'） */
  rewardType?: string;
  benefitText?: string;
  countInRound: number;
  remaining: number;
  stamps: Array<{
    id: string;
    exhibitorId: string;
    exhibitorName: string;
    round: number;
  }>;
  freeCoupons: MemberFreeCoupon[];
}

interface MemberReview {
  id: string;
  exhibitorId: string;
  exhibitorName: string;
  stars: number;
  /** 投稿時点の項目名つき項目別評価（表示はこの項目名を使う） */
  categoryScores?: Array<{ label: string; stars: number }>;
  categories: {
    taste: number;
    service: number;
    atmosphere: number;
    presentation: number;
  };
  text: string;
  nickname: string;
  photoUrls: string[];
  visible: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

interface ReviewableShop {
  exhibitorId: string;
  exhibitorName: string;
}

/** GPS スタンプのスポット（公開 API から取得。distance は現在地からの概算）。 */
interface GpsSpot {
  exhibitorId: string;
  name: string;
  location: GeoPoint | null;
  distance: number | null;
}

interface InfoPdf {
  id: string;
  title: string;
  url: string;
}

interface EventNotice {
  id: string;
  title: string;
  body: string;
  sentAt: string | null;
  attachment: {
    url: string;
    type: 'pdf' | 'image';
    storagePath: string;
  } | null;
}

function normalizePhoneNumber(value: string): string {
  const compact = value
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    .replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) return `+${compact.slice(2)}`;
  if (compact.startsWith('0')) return `+81${compact.slice(1)}`;
  if (compact.startsWith('81')) return `+${compact}`;
  return compact;
}

// アクセント色はプロジェクトのテーマカラー（CSS カスタムプロパティ）
// 経由で使う。変数はルート要素に themeCssVars で渡し、未設定の場合は
// var() のフォールバック（現在のベージュ／茶系）になる。
const VIOLET = 'var(--theme-accent, #8B5E34)';
const VIOLET_BRIGHT = 'var(--theme-accent-bright, #B07B45)';
const CLAIM_BLUE = '#2563eb';
const INK = '#17122b';
const HERO_GRADIENT =
  'linear-gradient(135deg, var(--theme-hero-from, #F1E4CB), var(--theme-hero-to, #E7D3AC))';
const CARD_GRADIENT =
  'linear-gradient(180deg, var(--theme-card-from, #FBF6EA), var(--theme-card-to, #F3E8D2))';
const SOFT_BORDER = 'var(--theme-hero-to, #E7D3AC)';
const SOFT_BG = 'var(--theme-card-from, #FBF6EA)';

// モックの言語ピルは短い表記（EN など）。選択の保存・送信は従来どおり locale で行う。
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
  borderRadius: 16,
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '10px 12px',
  marginTop: 6,
  border: '1px solid #cbd5e1',
  borderRadius: 10,
  fontSize: 16,
  backgroundColor: '#ffffff',
  boxSizing: 'border-box',
};

// 年代・性別のコード値 → 表示文の辞書キー（値は lib/member-demographics.ts）
const AGE_BAND_LABEL_KEYS: Record<AgeBand, UiTextKey> = {
  'under-10': 'ageBandUnder10',
  '10s': 'ageBand10s',
  '20s': 'ageBand20s',
  '30s': 'ageBand30s',
  '40s': 'ageBand40s',
  '50s': 'ageBand50s',
  '60s': 'ageBand60s',
  '70-plus': 'ageBand70Plus',
  'no-answer': 'noAnswer',
};

const GENDER_LABEL_KEYS: Record<Gender, UiTextKey> = {
  male: 'genderMale',
  female: 'genderFemale',
  other: 'genderOther',
  'no-answer': 'noAnswer',
};

const buttonStyle: React.CSSProperties = {
  padding: '12px 20px',
  fontWeight: 700,
  fontSize: 15,
  width: '100%',
  marginTop: 16,
  backgroundColor: VIOLET,
  color: '#ffffff',
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
};

const feedbackStyle: React.CSSProperties = {
  marginTop: 12,
  fontSize: 14,
  color: '#b91c1c',
  whiteSpace: 'pre-wrap',
};

function PinLogo() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 44,
        height: 44,
        borderRadius: 12,
        background: `linear-gradient(135deg, ${VIOLET_BRIGHT}, ${VIOLET})`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        boxShadow: '0 3px 8px rgba(139, 94, 52, 0.35)',
      }}
    >
      <svg width="25" height="25" viewBox="0 0 24 24">
        <path
          d="M12 21.5s-7.2-5.6-7.2-11.1a7.2 7.2 0 1 1 14.4 0c0 5.5-7.2 11.1-7.2 11.1Z"
          fill="#ffffff"
        />
        <circle cx="12" cy="9.7" r="2.7" style={{ fill: VIOLET }} />
      </svg>
    </div>
  );
}

// 自分のレビューから「項目名 → 星」の対応を作る（編集の初期値用）。
// 項目名つき（categoryScores）を優先し、無ければ固定4項目の値を
// 既定の項目名に写す。
function reviewScoreByLabel(review: MemberReview | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!review) return map;
  if (review.categoryScores && review.categoryScores.length > 0) {
    for (const score of review.categoryScores) {
      map.set(score.label, score.stars);
    }
    return map;
  }
  const keys = ['taste', 'service', 'atmosphere', 'presentation'] as const;
  keys.forEach((key, i) => {
    map.set(DEFAULT_REVIEW_CATEGORIES[i], review.categories[key]);
  });
  return map;
}

function ReviewStarInput({
  value,
  onChange,
  fontSize = 26,
}: {
  value: number;
  onChange: (value: number) => void;
  fontSize?: number;
}) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((v) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          aria-label={`${v} / 5`}
          style={{
            border: 'none',
            background: 'none',
            padding: 2,
            fontSize,
            lineHeight: 1,
            cursor: 'pointer',
            color: v <= value ? '#f59e0b' : '#cbd5e1',
          }}
        >
          ★
        </button>
      ))}
    </div>
  );
}

// スタンプをもらった店1件分の「書き込み欄」。
// 未投稿なら「書き込む」、投稿済みなら自分のレビューと「編集する」を出す。
// 投稿が成功したら、その場にシェア導線（Threads＋共有シート）を出す。
function ReviewShopCard({
  eventId,
  locale,
  reviewCategories,
  shop,
  review,
  user,
  onSaved,
}: {
  eventId: string;
  locale: Locale;
  /** プロジェクトの現在の項目別評価の項目（フォームの行になる） */
  reviewCategories: string[];
  shop: ReviewableShop;
  review: MemberReview | null;
  user: User;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [stars, setStars] = useState(5);
  // 項目別評価の星。reviewCategories と同じ並びで持つ。
  const [scores, setScores] = useState<number[]>(() =>
    reviewCategories.map(() => 5),
  );
  const [text, setText] = useState('');
  const [nickname, setNickname] = useState('');
  const [photoUrls, setPhotoUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const [shareInfo, setShareInfo] = useState<{ stars: number; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const startEdit = () => {
    setStars(review?.stars ?? 5);
    const byLabel = reviewScoreByLabel(review);
    setScores(reviewCategories.map((label) => byLabel.get(label) ?? 5));
    setText(review?.text ?? '');
    setNickname(review?.nickname ?? '');
    setPhotoUrls(review?.photoUrls ?? []);
    setFeedback(null);
    setShareInfo(null);
    setEditing(true);
  };

  const handlePhotoFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const targets = Array.from(files).slice(0, Math.max(3 - photoUrls.length, 0));
    if (targets.length === 0) return;
    setUploading(true);
    setFeedback(null);
    try {
      const idToken = await user.getIdToken();
      const uploaded: string[] = [];
      for (const file of targets) {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`/api/events/${eventId}/reviews/photo`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          body: formData,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || typeof data.url !== 'string') {
          throw new Error(typeof data.error === 'string' ? data.error : '');
        }
        uploaded.push(data.url);
      }
      setPhotoUrls((current) => [...current, ...uploaded].slice(0, 3));
    } catch (e) {
      setFeedback({
        text:
          e instanceof Error && e.message
            ? e.message
            : uiText(locale, 'reviewPhotoFailed'),
        error: true,
      });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setFeedback(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/events/${eventId}/reviews`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          exhibitorId: shop.exhibitorId,
          stars,
          categoryScores: reviewCategories.map((label, i) => ({
            label,
            stars: scores[i] ?? 5,
          })),
          text,
          nickname,
          photoUrls,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          text: data.error ?? uiText(locale, 'reviewPostFailed'),
          error: true,
        });
        return;
      }
      setShareInfo({ stars, text });
      setEditing(false);
      setFeedback({
        text: uiText(locale, data.created ? 'reviewPosted' : 'reviewUpdated'),
        error: false,
      });
      onSaved();
    } catch {
      setFeedback({ text: uiText(locale, 'reviewPostFailed'), error: true });
    } finally {
      setSubmitting(false);
    }
  };

  const shareText = shareInfo
    ? [`「${shop.exhibitorName}」 ${'★'.repeat(shareInfo.stars)}`, shareInfo.text]
        .filter((line) => line.trim().length > 0)
        .join('\n')
    : '';
  const threadsUrl = shareInfo
    ? `https://www.threads.net/intent/post?text=${encodeURIComponent(shareText)}`
    : '';
  const canNativeShare =
    typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  // 項目名つきで保存されていない旧レビューの表示用（固定4項目）。
  const legacyCategoryRows: Array<{
    key: 'taste' | 'service' | 'atmosphere' | 'presentation';
    labelKey: 'reviewCategoryTaste' | 'reviewCategoryService' | 'reviewCategoryAtmosphere' | 'reviewCategoryPresentation';
  }> = [
    { key: 'taste', labelKey: 'reviewCategoryTaste' },
    { key: 'service', labelKey: 'reviewCategoryService' },
    { key: 'atmosphere', labelKey: 'reviewCategoryAtmosphere' },
    { key: 'presentation', labelKey: 'reviewCategoryPresentation' },
  ];
  // 投稿済みレビューの項目別表示は、投稿時点の項目名（スナップショット）を使う。
  const reviewCategorySummary =
    review && review.categoryScores && review.categoryScores.length > 0
      ? review.categoryScores
          .map((score) => `${score.label} ${score.stars}`)
          .join(' ／ ')
      : review
        ? legacyCategoryRows
            .map(
              (row) =>
                `${uiText(locale, row.labelKey)} ${review.categories[row.key]}`,
            )
            .join(' ／ ')
        : '';

  return (
    <article style={{ ...cardStyle, padding: 16, marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 15.5, flex: 1 }}>
          {shop.exhibitorName}
        </span>
        {review && (
          <span
            style={{
              backgroundColor: VIOLET,
              color: '#ffffff',
              borderRadius: 6,
              padding: '3px 10px',
              fontWeight: 700,
              fontSize: 12,
            }}
          >
            {uiText(locale, 'reviewYourReviewBadge')}
          </span>
        )}
      </div>

      {review && !editing && (
        <>
          <div style={{ marginTop: 8, color: '#f59e0b', fontSize: 17 }}>
            {'★'.repeat(review.stars)}
            {'☆'.repeat(Math.max(5 - review.stars, 0))}
            <span style={{ color: '#0f172a', fontSize: 13.5, fontWeight: 700, marginLeft: 6 }}>
              {review.stars}.0
            </span>
          </div>
          <p style={{ fontSize: 12.5, color: '#64748b', margin: '4px 0 0' }}>
            {reviewCategorySummary}
            {review.nickname ? ` ／ ${review.nickname}` : ''}
          </p>
          {review.text && (
            <p style={{ fontSize: 14, margin: '8px 0 0', whiteSpace: 'pre-wrap' }}>
              {review.text}
            </p>
          )}
          {review.photoUrls.length > 0 && (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              {review.photoUrls.map((url) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={url}
                  src={url}
                  alt={shop.exhibitorName}
                  style={{
                    width: 84,
                    height: 84,
                    objectFit: 'cover',
                    borderRadius: 10,
                    border: '1px solid #e2e8f0',
                    display: 'block',
                  }}
                />
              ))}
            </div>
          )}
          {!review.visible && (
            <p style={{ fontSize: 12.5, color: '#b91c1c', margin: '8px 0 0' }}>
              {uiText(locale, 'reviewHiddenNote')}
            </p>
          )}
          <button
            onClick={startEdit}
            style={{
              marginTop: 12,
              padding: '9px 18px',
              fontWeight: 700,
              fontSize: 14,
              backgroundColor: '#ffffff',
              color: VIOLET,
              border: `1px solid ${VIOLET}`,
              borderRadius: 10,
              cursor: 'pointer',
            }}
          >
            {uiText(locale, 'reviewEditButton')}
          </button>
        </>
      )}

      {!review && !editing && (
        <button
          onClick={startEdit}
          style={{
            marginTop: 12,
            padding: '10px 18px',
            fontWeight: 700,
            fontSize: 14,
            backgroundColor: VIOLET,
            color: '#ffffff',
            border: 'none',
            borderRadius: 10,
            cursor: 'pointer',
          }}
        >
          {uiText(locale, 'reviewWriteButton')}
        </button>
      )}

      {editing && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            {uiText(locale, 'reviewOverallLabel')}
          </div>
          <ReviewStarInput value={stars} onChange={setStars} />
          {reviewCategories.map((label, i) => (
            <div
              key={label}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 6,
              }}
            >
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{label}</span>
              <ReviewStarInput
                fontSize={20}
                value={scores[i] ?? 5}
                onChange={(v) =>
                  setScores((current) =>
                    reviewCategories.map((_, index) =>
                      index === i ? v : (current[index] ?? 5),
                    ),
                  )
                }
              />
            </div>
          ))}
          <label style={{ display: 'block', marginTop: 12 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {uiText(locale, 'reviewTextLabel')}
            </span>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={uiText(locale, 'reviewTextPlaceholder')}
              rows={3}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </label>
          <label style={{ display: 'block', marginTop: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {uiText(locale, 'reviewNicknameLabel')}
            </span>
            <input
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              style={inputStyle}
            />
          </label>
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {uiText(locale, 'reviewPhotosLabel')}
            </div>
            {photoUrls.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                {photoUrls.map((url) => (
                  <span key={url} style={{ position: 'relative', display: 'inline-block' }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={url}
                      alt=""
                      style={{
                        width: 72,
                        height: 72,
                        objectFit: 'cover',
                        borderRadius: 10,
                        border: '1px solid #e2e8f0',
                        display: 'block',
                      }}
                    />
                    <button
                      type="button"
                      aria-label="remove"
                      onClick={() =>
                        setPhotoUrls((current) => current.filter((u) => u !== url))
                      }
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 22,
                        height: 22,
                        borderRadius: '50%',
                        border: 'none',
                        backgroundColor: '#0f172a',
                        color: '#ffffff',
                        fontSize: 13,
                        lineHeight: 1,
                        cursor: 'pointer',
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {photoUrls.length < 3 && (
              <div style={{ marginTop: 8 }}>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  style={{
                    padding: '8px 14px',
                    fontWeight: 700,
                    fontSize: 13,
                    backgroundColor: '#ffffff',
                    color: VIOLET,
                    border: `1px solid ${SOFT_BORDER}`,
                    borderRadius: 10,
                    cursor: 'pointer',
                  }}
                >
                  {uploading ? '…' : uiText(locale, 'reviewPhotoAdd')}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  multiple
                  hidden
                  onChange={(e) => void handlePhotoFiles(e.target.files)}
                />
              </div>
            )}
          </div>
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting || uploading}
            style={{
              marginTop: 14,
              padding: '11px 20px',
              fontWeight: 700,
              fontSize: 14.5,
              backgroundColor: VIOLET,
              color: '#ffffff',
              border: 'none',
              borderRadius: 10,
              cursor: 'pointer',
              width: '100%',
            }}
          >
            {review ? uiText(locale, 'reviewUpdate') : uiText(locale, 'reviewSubmit')}
          </button>
        </div>
      )}

      {feedback && (
        <p
          style={{
            fontSize: 13.5,
            fontWeight: 700,
            margin: '12px 0 0',
            color: feedback.error ? '#b91c1c' : '#15803d',
          }}
        >
          {feedback.text}
        </p>
      )}

      {shareInfo && !editing && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <a
            href={threadsUrl}
            target="_blank"
            rel="noreferrer"
            style={{
              padding: '9px 16px',
              fontWeight: 700,
              fontSize: 13.5,
              backgroundColor: '#0f172a',
              color: '#ffffff',
              borderRadius: 10,
              textDecoration: 'none',
            }}
          >
            {uiText(locale, 'reviewShareThreads')}
          </a>
          {canNativeShare && (
            <button
              onClick={() => {
                void navigator.share({ text: shareText }).catch(() => {});
              }}
              style={{
                padding: '9px 16px',
                fontWeight: 700,
                fontSize: 13.5,
                backgroundColor: '#ffffff',
                color: VIOLET,
                border: `1px solid ${VIOLET}`,
                borderRadius: 10,
                cursor: 'pointer',
              }}
            >
              {uiText(locale, 'reviewShare')}
            </button>
          )}
        </div>
      )}
    </article>
  );
}

export default function EventVisitorPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [event, setEvent] = useState<PublicEvent | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [locale, setLocale] = useState<Locale>('ja');
  const [phoneNumber, setPhoneNumber] = useState('');
  // 年代・性別は任意回答。未選択（''）のときは送信せず、保存側で null になる
  const [ageBand, setAgeBand] = useState<AgeBand | ''>('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [verificationCode, setVerificationCode] = useState('');
  const [confirmationResult, setConfirmationResult] = useState<ConfirmationResult | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [couponQuery, setCouponQuery] = useState('');
  const [coupons, setCoupons] = useState<PublicCoupon[]>([]);
  const [myClaims, setMyClaims] = useState<MemberClaim[]>([]);
  const [stampCard, setStampCard] = useState<MemberStampCard | null>(null);
  // 場所QR・GPS の付与結果フィードバック（スタンプカードの近くに出す）
  const [stampFeedback, setStampFeedback] = useState<{ text: string; error: boolean } | null>(null);
  // GPS スタンプ: スポット一覧（現在地取得後に近い順）と取得した現在地
  const [gpsSpots, setGpsSpots] = useState<GpsSpot[] | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const [gpsMessage, setGpsMessage] = useState('');
  const gpsPositionRef = useRef<GeoPoint | null>(null);
  // 場所QRの二重処理防止（同じコードは1回だけ API に送る）
  const placedStampBusyRef = useRef(false);
  // ログインボーナスの状態（未登録・未取得なら null）
  const [loginBonus, setLoginBonus] = useState<MemberLoginBonus | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMessage, setLoginMessage] = useState('');
  // 達成セレブレーション表示中の無料クーポン（null = 出していない）
  const [celebrationCoupon, setCelebrationCoupon] = useState<MemberFreeCoupon | null>(null);
  // セッション内でお祝い済みのクーポン（localStorage が使えない環境の代替）
  const celebratedSessionRef = useRef<Set<string>>(new Set());
  const [myReviews, setMyReviews] = useState<MemberReview[]>([]);
  const [reviewableShops, setReviewableShops] = useState<ReviewableShop[]>([]);
  const [notices, setNotices] = useState<EventNotice[]>([]);
  const [couponMessage, setCouponMessage] = useState('');
  const [infoPdfs, setInfoPdfs] = useState<InfoPdf[]>([]);
  // QRを開いている取得済みクーポン。undefined = 未操作（先頭の未使用分を開く）
  const [openClaimId, setOpenClaimId] = useState<string | null | undefined>(undefined);
  // 入場用QR（外部発行）の保存状態。null = 未取得
  const [admissionQr, setAdmissionQr] = useState<AdmissionQrState | null>(null);
  const [qrExpanded, setQrExpanded] = useState(false);
  const [qrEditing, setQrEditing] = useState(false);
  const [qrScanning, setQrScanning] = useState(false);
  const [qrManual, setQrManual] = useState('');
  const [qrBusy, setQrBusy] = useState(false);
  const [qrFeedback, setQrFeedback] = useState<{ text: string; error: boolean } | null>(null);
  const qrScannerRef = useRef<Html5Qrcode | null>(null);
  // 登録状態の確認は端末（uid）ごとに1回だけ行うための記録
  const registrationCheckRef = useRef<string | null>(null);
  // カタログで展開中の出店者グループ（検索中は全グループ展開扱い）
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());

  // iPhone で「ホーム画面に追加」したときに Web アプリとして開かれるよう、
  // このプロジェクト専用の manifest（start_url = このページ）を差し込む。
  // manifest が無いと新しい iOS では Safari のブックマーク扱いになり、
  // スタンドアローン判定が false のまま通知登録が止まってしまう。
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'manifest';
    link.href = `/api/manifest/event/${eventId}`;
    document.head.appendChild(link);
    return () => {
      link.remove();
    };
  }, [eventId]);

  // 場所QRの着地: ?stamp={stampCode} を検出したら sessionStorage に保持し、
  // URL からは取り除く（再読込・共有で再処理しない）。実際の付与は登録が
  // 完了して利用画面（'done'）に入ったタイミングで行うため、未登録でも
  // 登録フロー後にそのままスタンプが付く。
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const code = params.get('stamp');
      if (!code) return;
      window.sessionStorage.setItem(`pending-stamp:${eventId}`, code);
      params.delete('stamp');
      const query = params.toString();
      window.history.replaceState(
        null,
        '',
        window.location.pathname + (query ? `?${query}` : ''),
      );
    } catch {
      // 保持できなくても通常の登録フローは止めない
    }
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/events/${eventId}/public`);
        if (!res.ok) {
          if (!cancelled) setPhase('not-found');
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        const ev = data.event as PublicEvent;
        setEvent(ev);
        // 本人の保存済み選択 > プロジェクトのデフォルト > 日本語
        let stored: string | null = null;
        try {
          stored = window.localStorage.getItem(`event-locale:${eventId}`);
        } catch {
          // 保存が読めなくてもデフォルト言語で続行する
        }
        setLocale(resolveLocale(stored, ev.defaultLocale));
        // SMSオンの契約だけ電話番号入力から始める。端末認証（既定）は
        // 電話番号の段階を飛ばして、そのまま登録（通知許可）の段階へ。
        setPhase(
          ev.status === 'live'
            ? ev.smsAuthEnabled === true
              ? 'phone'
              : 'register'
            : 'unavailable',
        );
        // 案内PDFは登録前でも見られる（会場案内など）
        try {
          const pdfRes = await fetch(`/api/events/${eventId}/info-pdfs/public`);
          const pdfData = await pdfRes.json().catch(() => ({}));
          if (!cancelled && pdfRes.ok) setInfoPdfs(pdfData.pdfs ?? []);
        } catch {
          // PDFが読めなくても登録フローは止めない
        }
      } catch {
        if (!cancelled) setPhase('not-found');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  useEffect(
    () =>
      onAuthStateChanged(auth, (u) => {
        setUser(u);
        if (u) setPhase((p) => (p === 'phone' || p === 'code' ? 'register' : p));
      }),
    [],
  );

  // 端末認証（SMSオフ）のときは匿名認証でサインインし、端末の識別子
  // （uid）を得る。uid は端末側に保持されるため、同じ端末では同じ
  // 来場者として扱われる。電話認証済みのセッションがある場合は
  // そのまま使う（サーバー側も uid から同じ本人を導く）。
  useEffect(() => {
    if (!event || event.smsAuthEnabled === true || user) return;
    signInAnonymously(auth).catch(() => {
      // 失敗しても画面は止めない（登録ボタンの処理でも再試行する）
    });
  }, [event, user]);

  // 登録済みの端末では、開くたびに登録バナー（通知許可の段階）を出さない:
  // 認証とプロジェクトの読み込みが揃ったら登録状態を1回だけ確認し、
  // 登録済みならそのまま利用画面（'done'）へ進める。未登録・確認失敗の
  // ときは何もせず、従来の登録フロー（SMSオンでは電話番号の段階を含む）
  // のままにする。
  // あわせて、通知許可が済んでいる端末では裏側で FCM トークンを
  // 付け直す（登録 API は冪等で、言語トピックの付け替えも行われる）。
  // 許可ダイアログは絶対に出さない: requestPermission は呼ばず、
  // 許可済み（'granted'）のときだけトークン取得を試みる。付け直しに
  // 失敗しても利用画面はそのまま出す。
  useEffect(() => {
    if (!user || !event || event.status !== 'live') return;
    const checkKey = `${eventId}:${user.uid}`;
    if (registrationCheckRef.current === checkKey) return;
    registrationCheckRef.current = checkKey;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const res = await fetch(`/api/events/${eventId}/registration-status`, {
          headers: { Authorization: `Bearer ${idToken}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled || data.registered !== true) return;
        // 登録の段階にいるときだけ利用画面へ進める（電話番号入力中
        // などの段階は邪魔しない）
        setPhase((p) => (p === 'register' ? 'done' : p));
        if (
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          try {
            const fcmToken = await requestFCMToken({ shopName: event.name });
            if (fcmToken && !cancelled) {
              const refreshToken = await user.getIdToken();
              await fetch(`/api/events/${eventId}/register`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${refreshToken}`,
                },
                body: JSON.stringify({ fcmToken, lang: locale }),
              });
            }
          } catch {
            // 付け直しに失敗しても利用画面はそのまま出す
          }
        }
      } catch {
        // 状態が読めなければ従来どおり登録の段階を表示する
      }
    })();
    return () => {
      cancelled = true;
    };
    // locale は確認時点の表示言語を使う（依存に入れると言語切替のたびに
    // 再確認してしまうため、意図的に外している）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, event, eventId]);

  const handleLocaleChange = async (next: Locale) => {
    setLocale(next);
    try {
      window.localStorage.setItem(`event-locale:${eventId}`, next);
    } catch {
      // 保存できなくても画面の切替は有効にする
    }
    // 登録済みなら、購読者の言語（＝プッシュの言語）も付け替える
    if (user) {
      try {
        const idToken = await user.getIdToken();
        await fetch(`/api/events/${eventId}/language`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ lang: next }),
        });
      } catch {
        // 付け替えに失敗しても画面の切替は止めない（次回登録時に反映される）
      }
    }
  };

  const handleSendCode = async () => {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
      setMessage(uiText(locale, 'phoneFormatError'));
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      // SMSカード残高のゲート: 残高が無い契約では SMS 自体を送らない。
      // ゲートを通過した時点で消費1件として数えられる（lib/sms-mirror.ts）。
      const gateRes = await fetch(`/api/events/${eventId}/sms-gate`, {
        method: 'POST',
      });
      if (gateRes.status === 403) {
        setMessage(uiText(locale, 'smsUnavailable'));
        return;
      }
      if (!gateRes.ok) {
        setMessage(uiText(locale, 'sendCodeFailed', { code: 'sms-gate' }));
        return;
      }
      const previousVerifier = (window as unknown as Record<string, unknown>)
        .__phoneRecaptchaVerifier as RecaptchaVerifier | undefined;
      previousVerifier?.clear();
      const verifier = new RecaptchaVerifier(auth, 'recaptcha-container', { size: 'normal' });
      (window as unknown as Record<string, unknown>).__phoneRecaptchaVerifier = verifier;
      const result = await signInWithPhoneNumber(auth, normalized, verifier);
      setConfirmationResult(result);
      setPhase('code');
      setMessage(uiText(locale, 'codeSent'));
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown';
      setMessage(uiText(locale, 'sendCodeFailed', { code }));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmCode = async () => {
    if (!confirmationResult || !verificationCode.trim()) return;
    setBusy(true);
    setMessage('');
    try {
      await confirmationResult.confirm(verificationCode.trim());
      setConfirmationResult(null);
      setPhase('register');
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'unknown';
      setMessage(uiText(locale, 'codeWrong', { code }));
    } finally {
      setBusy(false);
    }
  };

  const handleRegister = async () => {
    if (!event) return;
    let currentUser = user;
    if (!currentUser) {
      // SMSオンでは電話認証が前提。端末認証では匿名サインインが
      // まだなら、ここで端末の識別子を得る。
      if (event.smsAuthEnabled === true) return;
      setBusy(true);
      try {
        const credential = await signInAnonymously(auth);
        currentUser = credential.user;
        setUser(credential.user);
      } catch {
        setMessage(uiText(locale, 'registerRetry'));
        return;
      } finally {
        setBusy(false);
      }
    }
    setBusy(true);
    setMessage('');
    try {
      // iPhone はホーム画面に追加した状態でないと Web Push を受け取れない（本家と同じ案内）
      const isStandalone =
        (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
        window.matchMedia('(display-mode: standalone)').matches;
      const isIos = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
      if (isIos && !isStandalone) {
        setMessage(uiText(locale, 'iosStandalone'));
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setMessage(uiText(locale, 'permissionDenied'));
        return;
      }
      const fcmToken = await requestFCMToken({ shopName: event.name });
      if (!fcmToken) {
        setMessage(uiText(locale, 'tokenFailed'));
        return;
      }

      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          fcmToken,
          lang: locale,
          // 年代・性別は選択したときだけ送る（未選択は保存側で null）
          ...(ageBand ? { ageBand } : {}),
          ...(gender ? { gender } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(data.error ?? uiText(locale, 'registerFailed'));
        return;
      }
      setPhase('done');
    } catch {
      setMessage(uiText(locale, 'registerRetry'));
    } finally {
      setBusy(false);
    }
  };

  // カタログは全件を取得し、絞り込みは画面側（lib/coupon-groups.ts）で行う。
  // 件数は契約枠で最大でも100件程度なので、全件読みでも問題ない。
  const loadCoupons = async (loc: Locale) => {
    try {
      const res = await fetch(`/api/events/${eventId}/coupons/public?lang=${loc}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok) setCoupons(data.coupons ?? []);
    } catch {
      // 一覧取得の失敗は登録フロー自体を止めない
    }
  };

  const loadMyClaims = async (currentUser: User, loc: Locale) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/my-claims?lang=${loc}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setMyClaims(data.claims ?? []);
    } catch {
      // 同上
    }
  };

  // お知らせは登録済みの来場者だけが API から取得できる（未登録は 403 で空のまま）
  const loadNotices = async (currentUser: User, loc: Locale) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/notices?lang=${loc}`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setNotices(data.notices ?? []);
    } catch {
      // 同上
    }
  };

  // スタンプカードは購読者だけが持つ（未登録なら API が card: null を返す）
  const loadMyStamps = async (currentUser: User) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/my-stamps`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setStampCard((data.card as MemberStampCard | null) ?? null);
    } catch {
      // 同上
    }
  };

  // 場所QRで保持したスタンプコードの付与。登録済み（利用画面）になって
  // 初めて呼ぶ。成否にかかわらずコードは消費し、同じ QR で繰り返し
  // 処理しない（通信自体が失敗したときだけ保持して次回に回す）。
  const processPendingPlacedStamp = async (currentUser: User) => {
    if (placedStampBusyRef.current) return;
    let code: string | null = null;
    try {
      code = window.sessionStorage.getItem(`pending-stamp:${eventId}`);
    } catch {
      // 読めなければ何もしない
    }
    if (!code) return;
    placedStampBusyRef.current = true;
    setStampFeedback({ text: uiText(locale, 'stampQrProcessing'), error: false });
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/stamps/placed-qr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ stampCode: code }),
      });
      const data = await res.json().catch(() => ({}));
      try {
        window.sessionStorage.removeItem(`pending-stamp:${eventId}`);
      } catch {
        // 消せなくても二重処理は ref で防いでいる
      }
      if (!res.ok) {
        setStampFeedback({
          text: data.error ?? uiText(locale, 'registerRetry'),
          error: true,
        });
        return;
      }
      setStampFeedback({
        text: uiText(locale, 'stampGrantedMessage', {
          shop: typeof data.exhibitorName === 'string' ? data.exhibitorName : '',
        }),
        error: false,
      });
      await loadMyStamps(currentUser);
    } catch {
      setStampFeedback({ text: uiText(locale, 'registerRetry'), error: true });
    } finally {
      placedStampBusyRef.current = false;
    }
  };

  // 利用画面に入ったら、保持中の場所QRスタンプを処理する
  useEffect(() => {
    if (phase !== 'done' || !user) return;
    void processPendingPlacedStamp(user);
    // processPendingPlacedStamp は表示言語時点の文言を使う（依存に
    // locale を入れると言語切替のたびに走るため意図的に外す）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, user, eventId]);

  // GPS スタンプ: 現在地を取得し、スポットを近い順に並べる
  const handleGpsFind = () => {
    if (!navigator.geolocation) {
      setGpsMessage(uiText(locale, 'stampGpsUnsupported'));
      return;
    }
    setGpsBusy(true);
    setGpsMessage(uiText(locale, 'stampGpsLocating'));
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const here: GeoPoint = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        };
        gpsPositionRef.current = here;
        try {
          const res = await fetch(`/api/events/${eventId}/stamps/spots`);
          const data = await res.json().catch(() => ({}));
          const spots: GpsSpot[] = (
            (data.spots ?? []) as Array<{
              exhibitorId: string;
              name: string;
              location: GeoPoint | null;
            }>
          ).map((spot) => ({
            ...spot,
            distance: spot.location
              ? Math.round(haversineMeters(here, spot.location))
              : null,
          }));
          spots.sort(
            (a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity),
          );
          setGpsSpots(spots);
          setGpsMessage('');
        } catch {
          setGpsMessage(uiText(locale, 'stampGpsFailed'));
        } finally {
          setGpsBusy(false);
        }
      },
      () => {
        setGpsBusy(false);
        setGpsMessage(uiText(locale, 'stampGpsFailed'));
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  };

  // GPS スタンプの付与（座標は判定のためだけに送り、サーバーは保存しない）
  const handleGpsStamp = async (spot: GpsSpot) => {
    if (!user || !gpsPositionRef.current || gpsBusy) return;
    setGpsBusy(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/events/${eventId}/stamps/gps`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          exhibitorId: spot.exhibitorId,
          lat: gpsPositionRef.current.lat,
          lng: gpsPositionRef.current.lng,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStampFeedback({
          text: data.error ?? uiText(locale, 'stampGpsFailed'),
          error: true,
        });
        return;
      }
      setStampFeedback({
        text: uiText(locale, 'stampGrantedMessage', {
          shop:
            typeof data.exhibitorName === 'string'
              ? data.exhibitorName
              : spot.name,
        }),
        error: false,
      });
      await loadMyStamps(user);
    } catch {
      setStampFeedback({ text: uiText(locale, 'stampGpsFailed'), error: true });
    } finally {
      setGpsBusy(false);
    }
  };

  // ログインボーナスも購読者だけが持つ（未登録なら loginBonus: null）
  const loadLoginBonus = async (currentUser: User) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/login-bonus`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setLoginBonus((data.loginBonus as MemberLoginBonus | null) ?? null);
      }
    } catch {
      // 同上
    }
  };

  // 今日のチェックイン。サーバー側で1日1回まで（JST）に数え、達成したら
  // クーポンが発行される。発行されたらスタンプカードを取り直し、
  // セレブレーションの判定に乗せる。
  const handleLoginCheckin = async () => {
    if (!user || loginBusy) return;
    setLoginBusy(true);
    setLoginMessage('');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/events/${eventId}/login-bonus`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginMessage(data.error ?? uiText(locale, 'loginBonusCheckedInToday'));
        return;
      }
      if (data.loginBonus) {
        setLoginBonus(data.loginBonus as MemberLoginBonus);
      }
      if (
        Array.isArray(data.issuedCouponIds) &&
        data.issuedCouponIds.length > 0
      ) {
        setLoginMessage(uiText(locale, 'loginBonusIssued'));
        await loadMyStamps(user);
      }
    } catch {
      // 失敗しても画面はそのまま（次の自動更新で状態が戻る）
    } finally {
      setLoginBusy(false);
    }
  };

  // レビューは、スタンプをもらった店についてだけ書ける（資格判定はAPI側）
  const loadMyReviews = async (currentUser: User) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/my-reviews`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMyReviews((data.reviews as MemberReview[]) ?? []);
        setReviewableShops((data.eligibleShops as ReviewableShop[]) ?? []);
      }
    } catch {
      // 同上
    }
  };

  useEffect(() => {
    if (!user) return;
    void loadCoupons(locale);
    void loadMyClaims(user, locale);
    void loadNotices(user, locale);
    void loadMyStamps(user);
    void loadLoginBonus(user);
    void loadMyReviews(user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, eventId, locale]);

  // 入場用QRの保存状態は、機能がオンのプロジェクトでだけ取得する
  const loadAdmissionQr = async (currentUser: User) => {
    try {
      const idToken = await currentUser.getIdToken();
      const res = await fetch(`/api/events/${eventId}/admission-qr`, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setAdmissionQr({
          stored: data.stored === true,
          content: typeof data.content === 'string' ? data.content : null,
        });
      }
    } catch {
      // 状態が読めなくても他の機能は止めない
    }
  };

  useEffect(() => {
    if (!user || !event?.admissionQrEnabled) return;
    void loadAdmissionQr(user);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, eventId, event?.admissionQrEnabled]);

  const saveAdmissionQrContent = async (content: string) => {
    if (!user) return;
    setQrBusy(true);
    setQrFeedback(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/events/${eventId}/admission-qr`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQrFeedback({
          text: data.error ?? uiText(locale, 'admissionQrSaveFailed'),
          error: true,
        });
        return;
      }
      // サーバー側で前後の空白を取り除いて保存するので表示も合わせる
      setAdmissionQr({ stored: true, content: content.trim() });
      setQrEditing(false);
      setQrExpanded(true);
      setQrManual('');
      setQrFeedback({ text: uiText(locale, 'admissionQrSaved'), error: false });
    } catch {
      setQrFeedback({ text: uiText(locale, 'admissionQrSaveFailed'), error: true });
    } finally {
      setQrBusy(false);
    }
  };

  const handleDeleteAdmissionQr = async () => {
    if (!user) return;
    setQrBusy(true);
    setQrFeedback(null);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/events/${eventId}/admission-qr`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setQrFeedback({
          text: data.error ?? uiText(locale, 'admissionQrDeleteFailed'),
          error: true,
        });
        return;
      }
      setAdmissionQr({ stored: false, content: null });
      setQrExpanded(false);
      setQrFeedback({ text: uiText(locale, 'admissionQrDeleted'), error: false });
    } catch {
      setQrFeedback({ text: uiText(locale, 'admissionQrDeleteFailed'), error: true });
    } finally {
      setQrBusy(false);
    }
  };

  const stopQrCamera = useCallback(async () => {
    const scanner = qrScannerRef.current;
    if (scanner) {
      try {
        if (scanner.isScanning) await scanner.stop();
        scanner.clear();
      } catch {
        // 停止失敗は無視する
      }
      qrScannerRef.current = null;
    }
    setQrScanning(false);
  }, []);

  const startQrCamera = async () => {
    setQrFeedback(null);
    try {
      const scanner = new Html5Qrcode('admission-qr-reader');
      qrScannerRef.current = scanner;
      setQrScanning(true);
      await scanner.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          await stopQrCamera();
          await saveAdmissionQrContent(decodedText);
        },
        () => {},
      );
    } catch (error) {
      setQrScanning(false);
      const err = error as { name?: string; message?: string };
      if (err?.name === 'NotAllowedError' || (err?.message ?? '').includes('Permission')) {
        setQrFeedback({ text: uiText(locale, 'admissionQrCameraDenied'), error: true });
      } else if (err?.name === 'NotFoundError') {
        setQrFeedback({ text: uiText(locale, 'admissionQrCameraNotFound'), error: true });
      } else {
        setQrFeedback({ text: uiText(locale, 'admissionQrCameraFailed'), error: true });
      }
    }
  };

  useEffect(() => {
    return () => {
      void stopQrCamera();
    };
  }, [stopQrCamera]);

  // 登録後は取得状態を自動で追いかける: ブースで消込されたら、
  // 手動リロードなしでカードが「使用済み」に切り替わりQRが閉じる。
  useEffect(() => {
    if (!user || (phase !== 'register' && phase !== 'done')) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void loadMyClaims(user, locale);
        void loadNotices(user, locale);
        void loadMyStamps(user);
        void loadLoginBonus(user);
        void loadMyReviews(user);
      }
    };
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, phase, eventId, locale]);

  // 達成セレブレーションの判定は、スタンプデータが更新されるたびに行う。
  // お店で最後のスタンプが押された達成は、お客さんがカウンターで開いている
  // この画面の次の自動更新（15秒周期・タブ復帰時）で検知され、その場で
  // 花びらが出る（お店の人と一緒に喜べるように）。
  // 1クーポンにつき1回だけ: 表示済みは localStorage に残し、使えない
  // 環境ではセッション内の記録で抑える。表示した時点で記録するため、
  // 開いている間の再更新で重ねて出ることはない。
  useEffect(() => {
    if (!stampCard || celebrationCoupon) return;
    const storage = safeLocalStorage();
    const target = pickCelebrationCoupon(
      stampCard.freeCoupons,
      (id) =>
        celebratedSessionRef.current.has(id) ||
        isCelebratedInStorage(storage, id),
    );
    if (!target) return;
    // 今回の達成より古い未使用分もまとめて表示済みにし、閉じた直後に
    // 過去分のお祝いが続けて出ないようにする
    for (const freeCoupon of stampCard.freeCoupons) {
      if (freeCoupon.status === 'active') {
        celebratedSessionRef.current.add(freeCoupon.id);
        markCelebratedInStorage(storage, freeCoupon.id);
      }
    }
    setCelebrationCoupon(target);
  }, [stampCard, celebrationCoupon]);

  // セレブレーションのボタン: 閉じて、該当クーポンのQRへスクロールし、
  // テーマカラーのリングを光らせて場所を示す。クーポン自体は消込まで
  // 画面に残り続ける（従来どおり）。
  const handleCelebrationReveal = (freeCouponId: string) => {
    setCelebrationCoupon(null);
    window.requestAnimationFrame(() => {
      const el = document.getElementById(`free-coupon-${freeCouponId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const accent = themePalette(event?.themeColor).accent;
      el.animate(
        [
          { boxShadow: '0 0 0 0 rgba(0, 0, 0, 0)' },
          { boxShadow: `0 0 0 4px ${accent}` },
          { boxShadow: '0 0 0 0 rgba(0, 0, 0, 0)' },
        ],
        { duration: 900, iterations: 2 },
      );
    });
  };

  const handleClaim = async (couponId: string) => {
    if (!user) return;
    setBusy(true);
    setCouponMessage('');
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/events/${eventId}/coupons/${couponId}/claim`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setCouponMessage(data.error ?? uiText(locale, 'claimFailed'));
        return;
      }
      setCouponMessage(uiText(locale, 'claimedMessage'));
      await loadMyClaims(user, locale);
    } catch {
      setCouponMessage(uiText(locale, 'claimFailed'));
    } finally {
      setBusy(false);
    }
  };

  const toggleGroup = (exhibitorName: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(exhibitorName)) {
        next.delete(exhibitorName);
      } else {
        next.add(exhibitorName);
      }
      return next;
    });
  };

  if (phase === 'loading') return <main style={containerStyle}>{uiText(locale, 'loading')}</main>;
  if (phase === 'not-found') {
    return (
      <main style={containerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PinLogo />
          <p style={{ fontSize: 19, fontWeight: 900, color: INK, margin: 0 }}>Push-taro.スタンプラリー</p>
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 800, marginTop: 24 }}>{uiText(locale, 'notFoundTitle')}</h1>
        <p style={{ fontSize: 14 }}>{uiText(locale, 'notFoundBody')}</p>
      </main>
    );
  }
  if (!event) return <main style={containerStyle}>{uiText(locale, 'loading')}</main>;

  const searching = couponQuery.trim().length > 0;
  const couponGroups = buildCouponGroups(coupons, couponQuery);
  const firstUnusedClaim = myClaims.find((c) => c.status === 'claimed');
  const effectiveOpenClaimId =
    openClaimId === undefined ? (firstUnusedClaim?.claimId ?? null) : openClaimId;
  // 取得済みカードの対象文はカタログ側の説明文から引く（取得APIは説明を持たない）
  const couponById = new Map(coupons.map((c) => [c.id, c]));
  const totalCompanies = new Set(coupons.map((c) => c.exhibitorName)).size;
  const endDateLabel = event.endDate.replaceAll('-', '.');
  const daysLeft = Math.ceil(
    (new Date(`${event.endDate}T23:59:59`).getTime() - Date.now()) / 86_400_000,
  );

  return (
    <main
      style={
        {
          ...containerStyle,
          // プロジェクトのテーマカラー（未設定なら既定パレットが入る）
          ...themeCssVars(event.themeColor),
          // 登録フェーズでは下部固定バナーに隠れないよう余白を確保する
          paddingBottom: phase === 'register' ? 148 : 32,
        } as React.CSSProperties
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <PinLogo />
          <div>
            <p
              style={{
                fontSize: 20,
                fontWeight: 900,
                color: INK,
                margin: 0,
                letterSpacing: -0.3,
                lineHeight: 1.15,
              }}
            >
              {event.name}
            </p>
            <p style={{ fontSize: 12.5, color: '#475569', margin: '2px 0 0' }}>
              {uiText(locale, 'visitorPageLabel')}
            </p>
          </div>
        </div>
      </div>

      <header
        style={{
          background: HERO_GRADIENT,
          borderRadius: 18,
          padding: '18px 16px',
          marginTop: 14,
          boxShadow: '0 4px 14px rgba(139, 94, 52, 0.18)',
        }}
      >
        <div
          role="group"
          aria-label={uiText(locale, 'language')}
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
        >
          {SUPPORTED_LOCALES.map((l) => {
            const selected = l === locale;
            return (
              <button
                key={l}
                onClick={() => void handleLocaleChange(l)}
                aria-pressed={selected}
                style={{
                  padding: '7px 16px',
                  fontSize: 14,
                  borderRadius: 999,
                  border: selected ? 'none' : '1px solid rgba(76, 29, 149, 0.28)',
                  backgroundColor: selected ? VIOLET : '#ffffff',
                  color: selected ? '#ffffff' : '#2e2a3f',
                  fontWeight: 700,
                  cursor: 'pointer',
                  boxShadow: selected ? 'none' : '0 1px 2px rgba(23, 18, 43, 0.12)',
                }}
              >
                {PILL_LABELS[l]}
              </button>
            );
          })}
        </div>
      </header>

      <section style={{ marginTop: 20 }}>
        <a
          href={specialSiteUrl(eventId)}
          target="_blank"
          rel="noreferrer"
          style={{
            ...cardStyle,
            display: 'block',
            padding: 14,
            fontWeight: 700,
            fontSize: 15,
            color: VIOLET,
            textDecoration: 'none',
          }}
        >
          🌐 {uiText(locale, 'specialSite')}
        </a>
      </section>

      {infoPdfs.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800 }}>{uiText(locale, 'infoTitle')}</h2>
          {infoPdfs.map((pdf) => (
            <a
              key={pdf.id}
              href={pdf.url}
              target="_blank"
              rel="noreferrer"
              style={{
                ...cardStyle,
                display: 'block',
                padding: 14,
                marginTop: 8,
                fontWeight: 700,
                fontSize: 15,
                color: VIOLET,
                textDecoration: 'none',
              }}
            >
              📄 {pdf.title}
            </a>
          ))}
        </section>
      )}

      {event.links && event.links.length > 0 && (
        <section style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, fontWeight: 800 }}>{uiText(locale, 'linksTitle')}</h2>
          {event.links.map((link, index) => (
            <a
              key={`${link.url}-${index}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              style={{
                ...cardStyle,
                display: 'block',
                padding: 14,
                marginTop: 8,
                fontWeight: 700,
                fontSize: 15,
                color: VIOLET,
                textDecoration: 'none',
              }}
            >
              🔗 {link.title}
            </a>
          ))}
        </section>
      )}

      {phase === 'unavailable' && (
        <p style={{ fontSize: 15, marginTop: 24 }}>
          {event.status === 'ended'
            ? uiText(locale, 'endedMessage')
            : uiText(locale, 'notAccepting')}
        </p>
      )}

      {phase === 'phone' && (
        <section style={{ ...cardStyle, marginTop: 20, padding: 16 }}>
          <p style={{ fontSize: 14, margin: 0 }}>{uiText(locale, 'registerIntro')}</p>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginTop: 16 }}>
            {uiText(locale, 'phoneLabel')}
            <input
              style={inputStyle}
              type="tel"
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder="09012345678"
            />
          </label>
          <div id="recaptcha-container" style={{ marginTop: 12 }} />
          <button style={buttonStyle} onClick={handleSendCode} disabled={busy}>
            {uiText(locale, 'sendCode')}
          </button>
          {message && <p style={feedbackStyle}>{message}</p>}
        </section>
      )}

      {phase === 'code' && (
        <section style={{ ...cardStyle, marginTop: 20, padding: 16 }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600 }}>
            {uiText(locale, 'codeLabel')}
            <input
              style={inputStyle}
              type="text"
              inputMode="numeric"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              placeholder={uiText(locale, 'codePlaceholder')}
            />
          </label>
          <button style={buttonStyle} onClick={handleConfirmCode} disabled={busy}>
            {uiText(locale, 'confirmCode')}
          </button>
          {message && <p style={feedbackStyle}>{message}</p>}
        </section>
      )}

      {phase === 'register' && (
        <section style={{ ...cardStyle, marginTop: 20, padding: 16 }}>
          <p style={{ fontSize: 14, margin: 0 }}>{uiText(locale, 'demographicsIntro')}</p>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginTop: 16 }}>
            {uiText(locale, 'ageBandLabel')}
            <select
              style={inputStyle}
              value={ageBand}
              onChange={(e) => setAgeBand(e.target.value as AgeBand | '')}
            >
              <option value="">{uiText(locale, 'demographicsSelect')}</option>
              {AGE_BANDS.map((band) => (
                <option key={band} value={band}>
                  {uiText(locale, AGE_BAND_LABEL_KEYS[band])}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginTop: 16 }}>
            {uiText(locale, 'genderLabel')}
            <select
              style={inputStyle}
              value={gender}
              onChange={(e) => setGender(e.target.value as Gender | '')}
            >
              <option value="">{uiText(locale, 'demographicsSelect')}</option>
              {GENDERS.map((value) => (
                <option key={value} value={value}>
                  {uiText(locale, GENDER_LABEL_KEYS[value])}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}

      {phase === 'done' && (
        <section style={{ ...cardStyle, marginTop: 20, padding: 16 }}>
          <p style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>{uiText(locale, 'doneTitle')}</p>
          <p style={{ fontSize: 14, marginTop: 12 }}>{uiText(locale, 'dailyResetNote')}</p>
          <p style={{ fontSize: 14, marginTop: 8 }}>
            {event.resetMode === 'keep-phones'
              ? uiText(locale, 'keepPhonesNote')
              : uiText(locale, 'fullDailyNote')}
          </p>
        </section>
      )}

      {user && (phase === 'register' || phase === 'done') && (
        <section style={{ marginTop: 28 }}>
          {event.admissionQrEnabled && (
            <div style={{ ...cardStyle, padding: 14, marginBottom: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24">
                  <path
                    d="M4 4h5v5H4zM15 4h5v5h-5zM4 15h5v5H4zM15 15h2v2h-2zM20 15h-1v1h1zM18 18h2v2h-2zM15 18h1v2h-3v-2h2z"
                    style={{ fill: VIOLET }}
                  />
                  <path d="M6.5 6.5h1v1h-1zM17.5 6.5h1v1h-1zM6.5 17.5h1v1h-1z" style={{ fill: VIOLET }} />
                </svg>
                <span style={{ fontWeight: 800, fontSize: 15.5, flex: 1 }}>
                  {uiText(locale, 'admissionQrTitle')}
                </span>
                <span
                  style={{
                    backgroundColor: admissionQr?.stored ? VIOLET : '#e5e7eb',
                    color: admissionQr?.stored ? '#ffffff' : '#4b5563',
                    borderRadius: 999,
                    padding: '3px 11px',
                    fontSize: 12,
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {admissionQr?.stored
                    ? uiText(locale, 'admissionQrStored')
                    : uiText(locale, 'admissionQrNotStored')}
                </span>
                {!admissionQr?.stored && !qrEditing && (
                  <button
                    onClick={() => {
                      setQrFeedback(null);
                      setQrEditing(true);
                    }}
                    style={{
                      padding: '8px 14px',
                      fontWeight: 700,
                      fontSize: 13.5,
                      backgroundColor: VIOLET,
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: 10,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {uiText(locale, 'admissionQrRegisterButton')}
                  </button>
                )}
                {admissionQr?.stored && !qrEditing && (
                  <button
                    onClick={() => setQrExpanded((v) => !v)}
                    aria-expanded={qrExpanded}
                    style={{
                      padding: '8px 14px',
                      fontWeight: 700,
                      fontSize: 13.5,
                      backgroundColor: VIOLET,
                      color: '#ffffff',
                      border: 'none',
                      borderRadius: 10,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {qrExpanded
                      ? uiText(locale, 'admissionQrHideButton')
                      : uiText(locale, 'admissionQrShowButton')}
                  </button>
                )}
              </div>

              {admissionQr?.stored && qrExpanded && !qrEditing && (
                <>
                  <div
                    style={{
                      marginTop: 14,
                      backgroundColor: '#ffffff',
                      border: '1px solid #e2e8f0',
                      borderRadius: 14,
                      padding: 14,
                      display: 'flex',
                      justifyContent: 'center',
                    }}
                  >
                    <QRCodeSVG value={admissionQr.content ?? ''} size={208} />
                  </div>
                  <p
                    style={{
                      fontSize: 14.5,
                      fontWeight: 800,
                      color: VIOLET,
                      textAlign: 'center',
                      margin: '12px 0 0',
                    }}
                  >
                    {uiText(locale, 'admissionQrShowNote')}
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: '#64748b',
                      textAlign: 'center',
                      margin: '6px 0 0',
                      wordBreak: 'break-all',
                    }}
                  >
                    {admissionQr.content}
                  </p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                    <button
                      onClick={() => {
                        setQrFeedback(null);
                        setQrEditing(true);
                      }}
                      disabled={qrBusy}
                      style={{
                        flex: 1,
                        padding: '10px 12px',
                        fontWeight: 700,
                        fontSize: 13.5,
                        backgroundColor: '#ffffff',
                        color: VIOLET,
                        border: `1px solid ${VIOLET}`,
                        borderRadius: 10,
                        cursor: 'pointer',
                      }}
                    >
                      {uiText(locale, 'admissionQrRescanButton')}
                    </button>
                    <button
                      onClick={() => void handleDeleteAdmissionQr()}
                      disabled={qrBusy}
                      style={{
                        padding: '10px 16px',
                        fontWeight: 700,
                        fontSize: 13.5,
                        backgroundColor: '#ffffff',
                        color: '#b91c1c',
                        border: '1px solid #fecaca',
                        borderRadius: 10,
                        cursor: 'pointer',
                      }}
                    >
                      {uiText(locale, 'admissionQrDeleteButton')}
                    </button>
                  </div>
                </>
              )}

              {qrEditing && (
                <>
                  <p style={{ fontSize: 13, color: '#475569', margin: '10px 0 0' }}>
                    {uiText(locale, 'admissionQrIntro')}
                  </p>
                  {!qrScanning && (
                    <div
                      aria-hidden="true"
                      style={{
                        position: 'relative',
                        marginTop: 12,
                        height: 180,
                        borderRadius: 14,
                        backgroundColor: '#101828',
                        backgroundImage:
                          'linear-gradient(rgba(255,255,255,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.055) 1px, transparent 1px)',
                        backgroundSize: '26px 26px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: 84,
                          height: 84,
                          border: '2px dashed rgba(255, 255, 255, 0.5)',
                          borderRadius: 10,
                        }}
                      />
                      <p
                        style={{
                          position: 'absolute',
                          left: 0,
                          right: 0,
                          bottom: 10,
                          fontSize: 12,
                          color: 'rgba(255, 255, 255, 0.8)',
                          textAlign: 'center',
                          margin: 0,
                          padding: '0 16px',
                        }}
                      >
                        {uiText(locale, 'admissionQrScanHint')}
                      </p>
                    </div>
                  )}
                  <div
                    id="admission-qr-reader"
                    style={{
                      width: '100%',
                      marginTop: qrScanning ? 12 : 0,
                      borderRadius: 12,
                      overflow: 'hidden',
                    }}
                  />
                  {!qrScanning ? (
                    <button
                      onClick={() => void startQrCamera()}
                      disabled={qrBusy}
                      style={{ ...buttonStyle, marginTop: 12, opacity: qrBusy ? 0.6 : 1 }}
                    >
                      {uiText(locale, 'admissionQrCameraStart')}
                    </button>
                  ) : (
                    <button
                      onClick={() => void stopQrCamera()}
                      style={{
                        ...buttonStyle,
                        marginTop: 12,
                        backgroundColor: '#ffffff',
                        color: VIOLET,
                        border: `1px solid ${VIOLET}`,
                      }}
                    >
                      {uiText(locale, 'admissionQrCameraStop')}
                    </button>
                  )}
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginTop: 16 }}>
                    {uiText(locale, 'admissionQrManualLabel')}
                    <input
                      style={inputStyle}
                      type="text"
                      value={qrManual}
                      onChange={(e) => setQrManual(e.target.value)}
                      placeholder={uiText(locale, 'admissionQrManualPlaceholder')}
                    />
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                    <button
                      onClick={() => void saveAdmissionQrContent(qrManual)}
                      disabled={qrBusy || !qrManual.trim()}
                      style={{
                        flex: 1,
                        padding: '11px 12px',
                        fontWeight: 700,
                        fontSize: 14,
                        backgroundColor: VIOLET,
                        color: '#ffffff',
                        border: 'none',
                        borderRadius: 10,
                        cursor: 'pointer',
                        opacity: qrBusy || !qrManual.trim() ? 0.6 : 1,
                      }}
                    >
                      {uiText(locale, 'admissionQrSaveButton')}
                    </button>
                    <button
                      onClick={() => {
                        void stopQrCamera();
                        setQrEditing(false);
                        setQrManual('');
                        setQrFeedback(null);
                      }}
                      style={{
                        padding: '11px 14px',
                        fontWeight: 700,
                        fontSize: 14,
                        background: 'none',
                        color: '#475569',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      {uiText(locale, 'admissionQrCancelButton')}
                    </button>
                  </div>
                </>
              )}

              {qrFeedback && (
                <p
                  role="status"
                  style={
                    qrFeedback.error
                      ? feedbackStyle
                      : {
                          marginTop: 12,
                          fontSize: 14,
                          backgroundColor: SOFT_BG,
                          border: `1px solid ${SOFT_BORDER}`,
                          borderRadius: 10,
                          padding: '9px 12px',
                        }
                  }
                >
                  {qrFeedback.text}
                </p>
              )}
            </div>
          )}

          {myClaims.length > 0 && (
            <>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24">
                  <rect x="4" y="3" width="16" height="18" rx="2.5" fill="none" style={{ stroke: VIOLET }} strokeWidth="2" />
                  <path d="M8 8.5h8M8 12.5h8M8 16.5h5" style={{ stroke: VIOLET }} strokeWidth="2" strokeLinecap="round" />
                </svg>
                <span style={{ flex: 1 }}>{uiText(locale, 'myCouponsTitle')}</span>
                <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>
                  {uiText(locale, 'itemsCount', { count: String(myClaims.length) })}
                </span>
              </h2>
              {myClaims.map((claim) => {
                const catalogCoupon = couponById.get(claim.couponId);
                const detailParts = [
                  catalogCoupon?.description,
                  uiText(locale, 'validUntil', { date: endDateLabel }),
                ].filter((part): part is string => Boolean(part));
                return claim.status === 'redeemed' ? (
                  <article
                    key={claim.claimId}
                    style={{
                      backgroundColor: '#e9edf2',
                      borderRadius: 16,
                      padding: 16,
                      marginTop: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                        {uiText(locale, 'usedStamp')}
                      </span>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>
                        🏢 {claim.exhibitorName}
                      </span>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 16, color: '#4b5563', marginTop: 8 }}>
                      {claim.title}
                    </div>
                    <p style={{ fontSize: 13, margin: '6px 0 0', color: '#6b7280' }}>
                      {uiText(locale, 'redeemedNote')}
                    </p>
                  </article>
                ) : (
                  <article
                    key={claim.claimId}
                    style={{
                      background: CARD_GRADIENT,
                      border: `1px solid ${SOFT_BORDER}`,
                      borderRadius: 16,
                      padding: 16,
                      marginTop: 12,
                      boxShadow: '0 2px 8px rgba(139, 94, 52, 0.12)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          backgroundColor: CLAIM_BLUE,
                          color: '#ffffff',
                          borderRadius: 6,
                          padding: '3px 10px',
                          fontWeight: 700,
                          fontSize: 12,
                        }}
                      >
                        {uiText(locale, 'claimedBadge')}
                      </span>
                      <span style={{ fontSize: 13, color: '#475569' }}>
                        🏢 {claim.exhibitorName}
                      </span>
                    </div>
                    <div style={{ fontWeight: 800, fontSize: 17, marginTop: 8 }}>{claim.title}</div>
                    {detailParts.length > 0 && (
                      <p style={{ fontSize: 12.5, color: '#475569', margin: '4px 0 0' }}>
                        {detailParts.join(' / ')}
                      </p>
                    )}
                    {effectiveOpenClaimId === claim.claimId ? (
                      <>
                        <div
                          style={{
                            marginTop: 14,
                            backgroundColor: '#ffffff',
                            borderRadius: 14,
                            padding: 14,
                            display: 'flex',
                            justifyContent: 'center',
                          }}
                        >
                          <QRCodeSVG value={claim.claimId} size={176} />
                        </div>
                        <p
                          style={{
                            fontSize: 14.5,
                            fontWeight: 800,
                            color: VIOLET,
                            textAlign: 'center',
                            margin: '12px 0 0',
                          }}
                        >
                          {uiText(locale, 'showQrNote')}
                        </p>
                        {daysLeft >= 0 && (
                          <p
                            style={{
                              fontSize: 12.5,
                              color: '#475569',
                              textAlign: 'center',
                              margin: '4px 0 0',
                            }}
                          >
                            {uiText(locale, 'daysLeft', { days: String(daysLeft) })}
                          </p>
                        )}
                        <div style={{ textAlign: 'center' }}>
                          <button
                            onClick={() => setOpenClaimId(null)}
                            aria-expanded={true}
                            style={{
                              marginTop: 10,
                              padding: '6px 14px',
                              fontWeight: 700,
                              fontSize: 13,
                              background: 'none',
                              color: VIOLET,
                              border: 'none',
                              cursor: 'pointer',
                              textDecoration: 'underline',
                            }}
                          >
                            {uiText(locale, 'hideQr')}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        onClick={() => setOpenClaimId(claim.claimId)}
                        aria-expanded={false}
                        style={{
                          marginTop: 12,
                          padding: '10px 18px',
                          fontWeight: 700,
                          fontSize: 14,
                          backgroundColor: VIOLET,
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: 10,
                          cursor: 'pointer',
                        }}
                      >
                        {uiText(locale, 'showQr')}
                      </button>
                    )}
                  </article>
                );
              })}
            </>
          )}

          {stampCard && (
            <section style={{ marginTop: 28 }}>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span aria-hidden="true">🔖</span>
                <span style={{ flex: 1 }}>{uiText(locale, 'stampCardTitle')}</span>
                <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>
                  {uiText(locale, 'stampRoundLabel', { round: String(stampCard.round) })}
                </span>
              </h2>
              <div style={{ ...cardStyle, padding: 16, marginTop: 12 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${Math.min(Math.max(stampCard.goalCount, 1), 5)}, 1fr)`,
                    gap: 8,
                  }}
                >
                  {Array.from({ length: stampCard.goalCount }, (_, i) => {
                    const stamp = stampCard.stamps[i];
                    return (
                      <div
                        key={i}
                        style={{
                          border: stamp
                            ? `2px solid ${VIOLET}`
                            : '2px dashed #cbd5e1',
                          backgroundColor: stamp ? SOFT_BG : '#ffffff',
                          borderRadius: 12,
                          minHeight: 62,
                          padding: '8px 6px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          textAlign: 'center',
                          boxSizing: 'border-box',
                        }}
                      >
                        {stamp ? (
                          <span
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              color: VIOLET,
                              wordBreak: 'break-all',
                            }}
                          >
                            {stamp.exhibitorName}
                          </span>
                        ) : (
                          <span style={{ fontSize: 16, color: '#cbd5e1', fontWeight: 800 }}>
                            {i + 1}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    textAlign: 'center',
                    margin: '14px 0 0',
                  }}
                >
                  {stampCard.countInRound} / {stampCard.goalCount}
                </p>
                {stampCard.remaining > 0 && (
                  <p
                    style={{
                      fontSize: 13.5,
                      color: '#475569',
                      textAlign: 'center',
                      margin: '4px 0 0',
                    }}
                  >
                    {stampCard.rewardType === 'benefit'
                      ? uiText(locale, 'stampRemainingBenefit', {
                          count: String(stampCard.remaining),
                          benefit: stampCard.benefitText ?? '',
                        })
                      : uiText(locale, 'stampRemaining', {
                          count: String(stampCard.remaining),
                        })}
                  </p>
                )}
                <div
                  style={{
                    marginTop: 14,
                    backgroundColor: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 14,
                    padding: 14,
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <QRCodeSVG
                    value={buildStampQrPayload(eventId, stampCard.memberId)}
                    size={176}
                  />
                </div>
                <p
                  style={{
                    fontSize: 14.5,
                    fontWeight: 800,
                    color: VIOLET,
                    textAlign: 'center',
                    margin: '12px 0 0',
                  }}
                >
                  {uiText(locale, 'stampShowQrNote')}
                </p>
              </div>

              {stampFeedback && (
                <p
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: stampFeedback.error ? '#b91c1c' : '#15803d',
                    margin: '12px 0 0',
                  }}
                >
                  {stampFeedback.text}
                </p>
              )}

              <div style={{ ...cardStyle, padding: 16, marginTop: 12 }}>
                <p style={{ fontSize: 15, fontWeight: 800, margin: 0 }}>
                  📍 {uiText(locale, 'stampGpsTitle')}
                </p>
                <p style={{ fontSize: 13, color: '#475569', margin: '6px 0 0' }}>
                  {uiText(locale, 'stampGpsNote')}
                </p>
                <button
                  onClick={handleGpsFind}
                  disabled={gpsBusy}
                  style={{
                    marginTop: 12,
                    padding: '10px 18px',
                    fontWeight: 700,
                    fontSize: 14,
                    backgroundColor: VIOLET,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: 10,
                    cursor: 'pointer',
                    opacity: gpsBusy ? 0.6 : 1,
                  }}
                >
                  {uiText(locale, 'stampGpsFindButton')}
                </button>
                {gpsMessage && (
                  <p style={{ fontSize: 13.5, color: '#475569', margin: '10px 0 0' }}>
                    {gpsMessage}
                  </p>
                )}
                {gpsSpots && (
                  <div style={{ marginTop: 12 }}>
                    {gpsSpots.map((spot) => (
                      <div
                        key={spot.exhibitorId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '10px 0',
                          borderTop: '1px solid #e2e8f0',
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ display: 'block', fontSize: 14, fontWeight: 700 }}>
                            {spot.name}
                          </span>
                          <span style={{ display: 'block', fontSize: 12, color: '#64748b' }}>
                            {spot.distance !== null
                              ? uiText(locale, 'stampGpsDistanceLabel', {
                                  distance: String(spot.distance),
                                })
                              : uiText(locale, 'stampGpsNoLocationNote')}
                          </span>
                        </span>
                        <button
                          onClick={() => void handleGpsStamp(spot)}
                          disabled={gpsBusy || !spot.location}
                          style={{
                            padding: '8px 14px',
                            fontWeight: 700,
                            fontSize: 13,
                            backgroundColor: VIOLET,
                            color: '#ffffff',
                            border: 'none',
                            borderRadius: 10,
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                            opacity: gpsBusy || !spot.location ? 0.5 : 1,
                          }}
                        >
                          {uiText(locale, 'stampGpsStampButton')}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {stampCard.freeCoupons.map((freeCoupon) =>
                freeCoupon.status === 'active' ? (
                  <article
                    key={freeCoupon.id}
                    id={`free-coupon-${freeCoupon.id}`}
                    style={{
                      background: CARD_GRADIENT,
                      border: `1px solid ${SOFT_BORDER}`,
                      borderRadius: 16,
                      padding: 16,
                      marginTop: 12,
                      boxShadow: '0 2px 8px rgba(139, 94, 52, 0.12)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span
                        style={{
                          backgroundColor: '#16a34a',
                          color: '#ffffff',
                          borderRadius: 6,
                          padding: '3px 10px',
                          fontWeight: 700,
                          fontSize: 12,
                        }}
                      >
                        {freeCoupon.kind === 'login'
                          ? uiText(locale, 'loginBonusCouponTitle')
                          : freeCoupon.rewardType === 'benefit'
                            ? uiText(locale, 'benefitCouponTitle')
                            : uiText(locale, 'freeCouponTitle')}
                      </span>
                      {freeCoupon.kind !== 'login' && (
                        <span style={{ fontSize: 13, color: '#475569' }}>
                          {uiText(locale, 'stampRoundLabel', {
                            round: String(freeCoupon.round),
                          })}
                        </span>
                      )}
                    </div>
                    {freeCoupon.kind !== 'login' && freeCoupon.rewardType === 'benefit' && freeCoupon.benefitText && (
                      <p
                        style={{
                          fontSize: 15,
                          fontWeight: 800,
                          textAlign: 'center',
                          margin: '12px 0 0',
                        }}
                      >
                        {freeCoupon.benefitText}
                      </p>
                    )}
                    <div
                      style={{
                        marginTop: 14,
                        backgroundColor: '#ffffff',
                        borderRadius: 14,
                        padding: 14,
                        display: 'flex',
                        justifyContent: 'center',
                      }}
                    >
                      <QRCodeSVG
                        value={buildFreeCouponQrPayload(eventId, freeCoupon.id)}
                        size={176}
                      />
                    </div>
                    <p
                      style={{
                        fontSize: 13.5,
                        fontWeight: 700,
                        color: VIOLET,
                        textAlign: 'center',
                        margin: '12px 0 0',
                      }}
                    >
                      {uiText(locale, 'freeCouponNote')}
                    </p>
                  </article>
                ) : (
                  <article
                    key={freeCoupon.id}
                    style={{
                      backgroundColor: '#e9edf2',
                      borderRadius: 16,
                      padding: 16,
                      marginTop: 12,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
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
                        {uiText(locale, 'usedStamp')}
                      </span>
                      <span style={{ fontSize: 13, color: '#6b7280' }}>
                        {freeCoupon.kind === 'login'
                          ? uiText(locale, 'loginBonusCouponTitle')
                          : freeCoupon.rewardType === 'benefit'
                            ? uiText(locale, 'benefitCouponTitle')
                            : uiText(locale, 'freeCouponTitle')}
                      </span>
                    </div>
                    {freeCoupon.kind !== 'login' && freeCoupon.rewardType === 'benefit' && freeCoupon.benefitText && (
                      <p style={{ fontSize: 13, margin: '6px 0 0', color: '#6b7280' }}>
                        {freeCoupon.benefitText}
                      </p>
                    )}
                    <p style={{ fontSize: 13, margin: '6px 0 0', color: '#6b7280' }}>
                      {uiText(locale, 'freeCouponUsed', {
                        shop: freeCoupon.usedExhibitorName ?? '',
                      })}
                    </p>
                  </article>
                ),
              )}
            </section>
          )}

          {loginBonus && loginBonus.enabled && (
            <section style={{ marginTop: 28 }}>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span aria-hidden="true">🎁</span>
                <span style={{ flex: 1 }}>{uiText(locale, 'loginBonusTitle')}</span>
              </h2>
              <div style={{ ...cardStyle, padding: 16, marginTop: 12 }}>
                <p style={{ fontSize: 13.5, color: '#475569', margin: 0, lineHeight: 1.7 }}>
                  {uiText(locale, 'loginBonusNote')}
                </p>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 14,
                  }}
                >
                  {Array.from({ length: loginBonus.goalDays }, (_, i) => (
                    <span
                      key={i}
                      aria-hidden="true"
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        border: `2px solid ${VIOLET}`,
                        backgroundColor:
                          i < loginBonus.countInCycle ? VIOLET : '#ffffff',
                        boxSizing: 'border-box',
                      }}
                    />
                  ))}
                </div>
                <p
                  style={{
                    fontSize: 15,
                    fontWeight: 800,
                    textAlign: 'center',
                    margin: '12px 0 0',
                  }}
                >
                  {uiText(locale, 'loginBonusProgress', {
                    count: String(loginBonus.countInCycle),
                    goal: String(loginBonus.goalDays),
                  })}
                </p>
                {loginBonus.remaining > 0 && (
                  <p
                    style={{
                      fontSize: 13.5,
                      color: '#475569',
                      textAlign: 'center',
                      margin: '4px 0 0',
                    }}
                  >
                    {uiText(locale, 'loginBonusRemaining', {
                      count: String(loginBonus.remaining),
                    })}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => void handleLoginCheckin()}
                  disabled={loginBusy || loginBonus.checkedInToday}
                  style={{
                    width: '100%',
                    marginTop: 14,
                    padding: '13px 12px',
                    borderRadius: 12,
                    border: 'none',
                    background:
                      'linear-gradient(90deg, var(--theme-accent, #8B5E34), var(--theme-accent-bright, #B07B45))',
                    color: '#ffffff',
                    fontWeight: 800,
                    fontSize: 15,
                    cursor:
                      loginBusy || loginBonus.checkedInToday
                        ? 'default'
                        : 'pointer',
                    opacity:
                      loginBusy || loginBonus.checkedInToday ? 0.55 : 1,
                  }}
                >
                  {loginBonus.checkedInToday
                    ? uiText(locale, 'loginBonusCheckedInToday')
                    : uiText(locale, 'loginBonusCheckinButton')}
                </button>
                {loginMessage && (
                  <p
                    style={{
                      fontSize: 13.5,
                      fontWeight: 700,
                      color: VIOLET,
                      textAlign: 'center',
                      margin: '10px 0 0',
                    }}
                  >
                    {loginMessage}
                  </p>
                )}
              </div>
            </section>
          )}

          {user && reviewableShops.length > 0 && (
            <section style={{ marginTop: 28 }}>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span aria-hidden="true">✍️</span>
                <span style={{ flex: 1 }}>{uiText(locale, 'reviewSectionTitle')}</span>
              </h2>
              {reviewableShops.map((shop) => (
                <ReviewShopCard
                  key={shop.exhibitorId}
                  eventId={eventId}
                  locale={locale}
                  reviewCategories={
                    event?.reviewCategories &&
                    event.reviewCategories.length > 0
                      ? event.reviewCategories
                      : DEFAULT_REVIEW_CATEGORIES
                  }
                  shop={shop}
                  review={
                    myReviews.find((r) => r.exhibitorId === shop.exhibitorId) ??
                    null
                  }
                  user={user}
                  onSaved={() => void loadMyReviews(user)}
                />
              ))}
            </section>
          )}

          {notices.length > 0 && (
            <section style={{ marginTop: 24 }}>
              <h2
                style={{
                  fontSize: 17,
                  fontWeight: 800,
                  margin: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <span aria-hidden="true">🔔</span>
                <span style={{ flex: 1 }}>{uiText(locale, 'noticesTitle')}</span>
                <span style={{ fontSize: 13, color: '#64748b', fontWeight: 600 }}>
                  {uiText(locale, 'itemsCount', { count: String(notices.length) })}
                </span>
              </h2>
              {notices.map((notice) => {
                const sentDate = notice.sentAt ? new Date(notice.sentAt) : null;
                const sentLabel =
                  sentDate && !Number.isNaN(sentDate.getTime())
                    ? sentDate.toLocaleString(locale, {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })
                    : '';
                return (
                  <article
                    key={notice.id}
                    style={{ ...cardStyle, padding: 14, marginTop: 10 }}
                  >
                    <div style={{ fontWeight: 800, fontSize: 15.5 }}>{notice.title}</div>
                    {sentLabel && (
                      <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                        {sentLabel}
                      </div>
                    )}
                    <p style={{ fontSize: 13.5, margin: '6px 0 0', whiteSpace: 'pre-wrap' }}>
                      {notice.body}
                    </p>
                    {notice.attachment?.type === 'image' && (
                      <a
                        href={notice.attachment.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ display: 'block', marginTop: 10 }}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={notice.attachment.url}
                          alt={notice.title}
                          style={{
                            display: 'block',
                            width: '100%',
                            borderRadius: 12,
                            border: '1px solid #e2e8f0',
                          }}
                        />
                      </a>
                    )}
                    {notice.attachment?.type === 'pdf' && (
                      <a
                        href={notice.attachment.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{
                          display: 'block',
                          marginTop: 10,
                          padding: '11px 12px',
                          borderRadius: 12,
                          border: `1px solid ${SOFT_BORDER}`,
                          backgroundColor: SOFT_BG,
                          fontWeight: 700,
                          fontSize: 14,
                          color: VIOLET,
                          textDecoration: 'none',
                        }}
                      >
                        📄 {uiText(locale, 'noticePdfLabel')}
                      </a>
                    )}
                  </article>
                );
              })}
            </section>
          )}

          <div style={{ position: 'relative', marginTop: 22 }}>
            <span
              aria-hidden="true"
              style={{
                position: 'absolute',
                left: 14,
                top: '50%',
                transform: 'translateY(-50%)',
                fontSize: 15,
                color: '#64748b',
                pointerEvents: 'none',
              }}
            >
              🔍
            </span>
            <input
              style={{
                display: 'block',
                width: '100%',
                padding: '12px 14px 12px 40px',
                border: 'none',
                borderRadius: 999,
                fontSize: 15,
                backgroundColor: '#edf0f4',
                boxSizing: 'border-box',
                color: '#0f172a',
              }}
              type="search"
              value={couponQuery}
              onChange={(e) => setCouponQuery(e.target.value)}
              placeholder={uiText(locale, 'searchPlaceholder')}
              aria-label={uiText(locale, 'searchPlaceholder')}
            />
          </div>

          <h3
            style={{
              fontSize: 17,
              fontWeight: 800,
              marginTop: 22,
              display: 'flex',
              alignItems: 'baseline',
              gap: 8,
            }}
          >
            <span aria-hidden="true" style={{ color: VIOLET, fontSize: 15 }}>
              ▾
            </span>
            <span style={{ flex: 1 }}>{uiText(locale, 'catalogTitle')}</span>
            {coupons.length > 0 && (
              <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                {uiText(locale, 'catalogSummary', {
                  companies: String(totalCompanies),
                  count: String(coupons.length),
                })}
              </span>
            )}
          </h3>
          {couponMessage && (
            <p
              role="status"
              style={{
                marginTop: 10,
                fontSize: 14,
                backgroundColor: SOFT_BG,
                border: `1px solid ${SOFT_BORDER}`,
                borderRadius: 10,
                padding: '9px 12px',
              }}
            >
              {couponMessage}
            </p>
          )}
          {couponGroups.length === 0 && (
            <p style={{ fontSize: 13, color: '#64748b', marginTop: 12 }}>
              {uiText(locale, 'noCoupons')}
            </p>
          )}
          {couponGroups.map((group) => {
            const open = searching || openGroups.has(group.exhibitorName);
            return (
              <div key={group.exhibitorName} style={{ ...cardStyle, marginTop: 12, overflow: 'hidden' }}>
                <button
                  onClick={() => toggleGroup(group.exhibitorName)}
                  aria-expanded={open}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '15px 14px',
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    boxSizing: 'border-box',
                  }}
                >
                  <span style={{ fontWeight: 800, fontSize: 16, flex: 1 }}>
                    {group.exhibitorName}
                  </span>
                  <span
                    style={{
                      backgroundColor: open ? VIOLET : '#e5e7eb',
                      color: open ? '#ffffff' : '#4b5563',
                      borderRadius: 999,
                      padding: '3px 11px',
                      fontSize: 12,
                      fontWeight: 700,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {uiText(locale, 'couponCount', { count: String(group.coupons.length) })}
                  </span>
                  <span
                    aria-hidden="true"
                    style={{
                      color: open ? VIOLET : '#9ca3af',
                      fontWeight: 800,
                      fontSize: open ? 15 : 20,
                      lineHeight: 1,
                    }}
                  >
                    {open ? '▾' : '›'}
                  </span>
                </button>
                {open &&
                  group.coupons.map((coupon) => {
                    const claim = myClaims.find((c) => c.couponId === coupon.id);
                    return (
                      <div
                        key={coupon.id}
                        style={{ padding: '13px 14px 15px', borderTop: '1px solid #f1f5f9' }}
                      >
                        {coupon.keywords[0] && (
                          <span
                            style={{
                              display: 'inline-block',
                              backgroundColor: VIOLET_BRIGHT,
                              color: '#ffffff',
                              borderRadius: 6,
                              padding: '3px 10px',
                              fontWeight: 700,
                              fontSize: 12,
                            }}
                          >
                            {coupon.keywords[0]}
                          </span>
                        )}
                        <div style={{ fontWeight: 800, fontSize: 16, marginTop: coupon.keywords[0] ? 7 : 0 }}>
                          {coupon.title}
                        </div>
                        {coupon.description && (
                          <p style={{ fontSize: 13, color: '#475569', marginTop: 4 }}>
                            {coupon.description}
                          </p>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                          <button
                            onClick={() => void handleClaim(coupon.id)}
                            disabled={busy || claim !== undefined}
                            style={{
                              padding: '10px 22px',
                              fontWeight: 700,
                              fontSize: 15,
                              borderRadius: 10,
                              border: 'none',
                              backgroundColor: claim ? '#e2e8f0' : CLAIM_BLUE,
                              color: claim ? '#64748b' : '#ffffff',
                              cursor: claim ? 'default' : 'pointer',
                            }}
                          >
                            {claim
                              ? claim.status === 'redeemed'
                                ? uiText(locale, 'redeemedButton')
                                : uiText(locale, 'claimedButton')
                              : uiText(locale, 'claimButton')}
                          </button>
                        </div>
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </section>
      )}

      {phase === 'register' && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 20,
          }}
        >
          <div style={{ maxWidth: 480, margin: '0 auto', padding: '0 16px 14px' }}>
            {message && (
              <p
                style={{
                  ...feedbackStyle,
                  marginTop: 0,
                  marginBottom: 10,
                  backgroundColor: '#ffffff',
                  border: '1px solid #fecaca',
                  borderRadius: 10,
                  padding: '9px 12px',
                }}
              >
                {message}
              </p>
            )}
            <div
              style={{
                background: HERO_GRADIENT,
                borderRadius: 18,
                padding: '14px 16px',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                boxShadow: '0 8px 22px rgba(139, 94, 52, 0.28)',
              }}
            >
              <div
                aria-hidden="true"
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: '50%',
                  border: `2px solid ${VIOLET}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  backgroundColor: 'rgba(255, 255, 255, 0.55)',
                }}
              >
                <svg width="23" height="23" viewBox="0 0 24 24">
                  <path
                    d="M18 9.2a6 6 0 1 0-12 0c0 5.4-2.3 6.8-2.3 6.8h16.6S18 14.6 18 9.2Z"
                    style={{ fill: VIOLET }}
                  />
                  <path d="M10.1 19.4a2 2 0 0 0 3.8 0" style={{ fill: VIOLET }} />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: 15.5, fontWeight: 800, color: INK, margin: 0 }}>
                  {uiText(locale, 'pushBannerTitle')}
                </p>
                <p style={{ fontSize: 12, color: '#4b4560', margin: '3px 0 0' }}>
                  {uiText(locale, 'pushBannerBody')}
                </p>
              </div>
              <button
                onClick={handleRegister}
                disabled={busy}
                style={{
                  padding: '12px 16px',
                  fontWeight: 800,
                  fontSize: 15,
                  backgroundColor: VIOLET,
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: 12,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {uiText(locale, 'pushBannerButton')}
              </button>
            </div>
          </div>
        </div>
      )}
      {celebrationCoupon && (
        <StampCelebration
          locale={locale}
          coupon={celebrationCoupon}
          onReveal={handleCelebrationReveal}
          onClose={() => setCelebrationCoupon(null)}
        />
      )}
      <PoweredByFooter />
    </main>
  );
}
