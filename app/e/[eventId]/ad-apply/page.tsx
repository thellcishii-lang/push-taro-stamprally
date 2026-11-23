'use client';

// app/e/[eventId]/ad-apply/page.tsx
// Push-taro.スタンプラリー の広告 自己申込ページ（公開）。
// 外部の事業者が自分で申し込み、プロジェクトの広告料金を主催者
// 自身の Stripe で払うと、広告編集画面へのログイン情報がメールで
// 届く。広告の掲載は、ログイン後に内容を申請し主催者の承認を経る。
// 実体は components/ApplicationForm.tsx（参加店登録と共通）。
import { useParams } from 'next/navigation';
import ApplicationForm from '@/components/ApplicationForm';

export default function AdApplyPage() {
  const params = useParams<{ eventId: string }>();
  return <ApplicationForm eventId={params.eventId} flow="ad" />;
}
