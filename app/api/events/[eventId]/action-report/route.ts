// app/api/events/[eventId]/action-report/route.ts
// 行動レポート（主催者）: 協賛・広告の数、クーポン使用履歴、
// クーポン使用の年代別・性別統計を返す。集計は lib/action-report.ts、
// 読み込みは lib/action-report-data.ts。フィルターはクエリで受ける
// （month / exhibitorId / ageBand / gender）。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import {
  parseActionReportFilters,
  summarizeActionReport,
} from '@/lib/action-report';
import { loadActionReportInputs } from '@/lib/action-report-data';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  const { records, sponsors, shops } = await loadActionReportInputs(eventId);
  const filters = parseActionReportFilters(new URL(request.url).searchParams);
  const summary = summarizeActionReport(records, sponsors, filters);

  return NextResponse.json({
    summary,
    shops,
    generatedAt: new Date().toISOString(),
  });
}
