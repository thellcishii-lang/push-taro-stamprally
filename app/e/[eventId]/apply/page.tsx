'use client';

// app/e/[eventId]/apply/page.tsx
// Push-taro.スタンプラリー の参加店 自己登録ページ（公開）。
// 店が自分で申し込み、プロジェクトの月額を主催者自身の Stripe で
// 払うと、ログイン用のパスワードがメールで届く（Push-taro 自身の
// 申込と同じ形）。主催者発行の登録と併存する。
// 実体は components/ApplicationForm.tsx（広告申込と共通）。
import { useParams } from 'next/navigation';
import ApplicationForm from '@/components/ApplicationForm';

export default function ShopApplyPage() {
  const params = useParams<{ eventId: string }>();
  return <ApplicationForm eventId={params.eventId} flow="shop" />;
}
