'use client';

// components/StampCelebration.tsx
// スタンプ達成セレブレーション（来場者画面）。
//
// お店で最後のスタンプが押されて達成した瞬間に、花びらが舞い
// 「やったーミッション達成！」が出る。お客さんとお店の人が一緒に
// 喜ぶための演出で、本家の登録画面の CelebrationModal と同じ構成
// （全面オーバーレイ＋中央カード＋ボタン1つ）に、花びらの舞いを
// CSS アニメーションで付けたもの（依存追加なし）。
//
// 花びらは数秒で止まる（カードはボタンか×で閉じるまで残る）。
// prefers-reduced-motion の端末では花びらを出さずカードだけ出す。
// 色はプロジェクトのテーマカラー（--theme-*、来場者ページのルートで
// 設定済み）に追随し、未設定ならスタンプラリーの既定パレットに倒れる。
import { useEffect, useMemo, useState } from 'react';
import type { Locale } from '@/lib/i18n';
import { uiText } from '@/lib/ui-text';
import {
  celebrationCouponKind,
  celebrationRewardKind,
  type CelebrationCouponLike,
} from '@/lib/stamp-celebration';

interface StampCelebrationProps {
  locale: Locale;
  coupon: CelebrationCouponLike;
  /** 「特典QRを表示する」: 閉じて該当クーポンのQRへスクロールする */
  onReveal: (freeCouponId: string) => void;
  /** × で閉じる */
  onClose: () => void;
}

interface PetalSpec {
  left: string;
  size: number;
  duration: string;
  delay: string;
  color: string;
  drift: string;
}

const PETAL_COLORS = [
  '#f9a8d4',
  '#fbcfe8',
  '#f472b6',
  'var(--theme-accent-bright, #B07B45)',
  'var(--theme-hero-to, #E7D3AC)',
];

function buildPetals(count: number): PetalSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    left: `${Math.random() * 100}%`,
    size: 9 + Math.random() * 9,
    duration: `${2.6 + Math.random() * 2}s`,
    delay: `${Math.random() * 1.4}s`,
    color: PETAL_COLORS[i % PETAL_COLORS.length],
    drift: `${(Math.random() - 0.5) * 14}vw`,
  }));
}

export default function StampCelebration({
  locale,
  coupon,
  onReveal,
  onClose,
}: StampCelebrationProps) {
  const kind = celebrationRewardKind(coupon);
  // ログインボーナスのクーポンは、特典種別ではなく発行元で文面を決める
  const isLoginCoupon = celebrationCouponKind(coupon) === 'login';
  const [reducedMotion, setReducedMotion] = useState(false);
  // 花びらは時間で止める（カード自体は閉じるまで残す）
  const [petalsVisible, setPetalsVisible] = useState(true);
  const petals = useMemo(() => buildPetals(26), []);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) =>
      setReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setPetalsVisible(false), 4600);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(46, 32, 21, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        animation: 'stampCelebFadeIn .25s ease',
      }}
    >
      {petalsVisible && !reducedMotion && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          {petals.map((petal, i) => (
            <span
              key={i}
              style={
                {
                  position: 'absolute',
                  top: -24,
                  left: petal.left,
                  width: petal.size,
                  height: petal.size * 0.82,
                  backgroundColor: petal.color,
                  // 花びらの形（対角だけ丸くする）
                  borderRadius: '90% 0 90% 0',
                  opacity: 0,
                  '--petal-drift': petal.drift,
                  animation: `stampPetalFall ${petal.duration} linear ${petal.delay} forwards`,
                } as React.CSSProperties
              }
            />
          ))}
        </div>
      )}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={uiText(locale, 'celebrationTitle')}
        style={{
          position: 'relative',
          background:
            'linear-gradient(180deg, var(--theme-card-from, #FBF6EA), var(--theme-card-to, #F3E8D2))',
          borderRadius: 24,
          padding: '30px 24px 24px',
          maxWidth: 340,
          width: '90%',
          textAlign: 'center',
          boxShadow: '0 18px 48px rgba(46, 32, 21, 0.35)',
          animation: 'stampCelebPop .35s cubic-bezier(.34,1.56,.64,1)',
          boxSizing: 'border-box',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={uiText(locale, 'celebrationClose')}
          style={{
            position: 'absolute',
            top: 8,
            right: 10,
            background: 'transparent',
            border: 'none',
            fontSize: 22,
            lineHeight: 1,
            color: '#97826A',
            cursor: 'pointer',
            padding: 6,
          }}
        >
          ×
        </button>
        <div style={{ fontSize: 52, lineHeight: 1.1 }} aria-hidden="true">
          🌸
        </div>
        <h2
          style={{
            fontSize: 22,
            fontWeight: 900,
            color: 'var(--theme-accent-dark, #75502C)',
            margin: '10px 0 0',
          }}
        >
          {uiText(locale, 'celebrationTitle')}
        </h2>
        {!isLoginCoupon && kind === 'benefit' && coupon.benefitText ? (
          <p
            style={{
              fontSize: 17,
              fontWeight: 800,
              margin: '12px 0 0',
              wordBreak: 'break-all',
            }}
          >
            {coupon.benefitText}
          </p>
        ) : null}
        <p
          style={{
            fontSize: 14.5,
            color: '#475569',
            lineHeight: 1.7,
            margin: '10px 0 0',
          }}
        >
          {isLoginCoupon
            ? uiText(locale, 'celebrationLoginMessage')
            : kind === 'benefit'
              ? uiText(locale, 'celebrationBenefitMessage')
              : uiText(locale, 'celebrationFreeDishMessage')}
        </p>
        <button
          type="button"
          onClick={() => onReveal(coupon.id)}
          style={{
            width: '100%',
            marginTop: 20,
            padding: '14px 12px',
            borderRadius: 12,
            border: 'none',
            background:
              'linear-gradient(90deg, var(--theme-accent, #8B5E34), var(--theme-accent-bright, #B07B45))',
            color: '#ffffff',
            fontWeight: 800,
            fontSize: 15.5,
            cursor: 'pointer',
          }}
        >
          {uiText(locale, 'celebrationShowQrButton')}
        </button>
      </div>
      <style>{`
        @keyframes stampCelebFadeIn { from { opacity: 0 } to { opacity: 1 } }
        @keyframes stampCelebPop { from { transform: scale(.8); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        @keyframes stampPetalFall {
          0% { transform: translate3d(0, -5vh, 0) rotate(0deg); opacity: 0 }
          8% { opacity: 1 }
          25% { transform: translate3d(calc(var(--petal-drift) * 0.4), 25vh, 0) rotate(140deg) }
          50% { transform: translate3d(calc(var(--petal-drift) * -0.3), 52vh, 0) rotate(300deg) }
          75% { transform: translate3d(calc(var(--petal-drift) * 0.5), 78vh, 0) rotate(470deg) }
          100% { transform: translate3d(var(--petal-drift), 106vh, 0) rotate(640deg); opacity: .9 }
        }
      `}</style>
    </div>
  );
}
