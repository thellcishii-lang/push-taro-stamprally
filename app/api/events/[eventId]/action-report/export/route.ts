// app/api/events/[eventId]/action-report/export/route.ts
// 行動レポートの CSV ダウンロード（主催者）。画面と同じフィルターを
// クエリで受け、同じ集計を CSV で返す（自治体・助成事業への提出用）。
// 整形は lib/action-report.ts の buildActionReportCsv。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import {
  buildActionReportCsv,
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

  const { records, sponsors } = await loadActionReportInputs(eventId);
  const filters = parseActionReportFilters(new URL(request.url).searchParams);
  const csv = buildActionReportCsv(
    summarizeActionReport(records, sponsors, filters),
  );

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="action-report-${eventId}.csv"`,
    },
  });
}
