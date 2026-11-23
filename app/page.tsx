// app/page.tsx
// スタンプラリー専用デプロイのルート。公開向けの紹介ページは push-taro.com/stamprally に集約し、
// ここはアプリの入口としての最小限の案内だけを置く。
import type { Metadata } from 'next';
import Link from 'next/link';
import BrandLogo from '@/components/BrandLogo';

export const metadata: Metadata = {
  title: 'Push-taro.スタンプラリー｜デジタルスタンプラリー',
  description:
    'Push-taro.スタンプラリー は、ご当地グルメのスタンプラリー基盤です。お客さんの方は参加店のQRコードからアクセスしてください。',
  robots: { index: false, follow: false },
};

export default function HomePage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
        background: '#f8fafc',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        textAlign: 'center',
      }}
    >
      <BrandLogo />
      <h1 style={{ fontSize: '28px', fontWeight: 900, color: '#0f172a', margin: '24px 0 12px' }}>
        Push-taro.スタンプラリー
      </h1>
      <p style={{ fontSize: '15px', color: '#64748b', lineHeight: 1.9, maxWidth: '520px', marginBottom: '32px' }}>
        このドメインは、ご当地グルメ・スタンプラリーアプリ「Push-taro.スタンプラリー」専用です。
        <br />
        お客さんの方は、参加店に掲示されたQRコードからアクセスしてください。
        <br />
        サービスの紹介は Push-taro.com に掲載しています。
      </p>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link
          href="/event-admin"
          style={{
            display: 'inline-block',
            padding: '14px 28px',
            background: 'linear-gradient(135deg, #ff4500, #f97316)',
            color: '#fff',
            borderRadius: '10px',
            fontWeight: 800,
            fontSize: '15px',
            textDecoration: 'none',
            boxShadow: '0 6px 20px rgba(255,69,0,0.3)',
          }}
        >
          主催者ログイン（管理画面）
        </Link>
        <a
          href="https://push-taro.com/stamprally"
          style={{
            display: 'inline-block',
            padding: '14px 28px',
            background: '#fff',
            color: '#0f172a',
            borderRadius: '10px',
            fontWeight: 800,
            fontSize: '15px',
            textDecoration: 'none',
            border: '2px solid #e2e8f0',
          }}
        >
          サービスの紹介を見る
        </a>
      </div>
    </main>
  );
}
