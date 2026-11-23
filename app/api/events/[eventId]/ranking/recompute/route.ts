// app/api/events/[eventId]/ranking/recompute/route.ts
// 週次ランキングの手動再計算（主催者だけ）。tick の自動補完を待たずに
// 特定の週を計算し直すための運用 API。
// body の weekStart（'YYYY-MM-DD'）があれば、その日を含む週を対象に
// する。無ければ「直近で完了した週」（先週）を対象にする。
// 再計算は冪等（同じ週は同じ内容で上書き）。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { db } from '@/lib/firebase-admin';
import {
  computeWeeklyRanking,
  previousWeekPeriodJst,
  weekPeriodJst,
  type WeekPeriod,
} from '@/lib/event-ranking';

export const dynamic = 'force-dynamic';

function resolvePeriod(body: Record<string, unknown>): WeekPeriod | null {
  const weekStart = body.weekStart;
  if (weekStart === undefined || weekStart === null || weekStart === '') {
    return previousWeekPeriodJst(new Date());
  }
  if (typeof weekStart !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return null;
  }
  const date = new Date(`${weekStart}T00:00:00+09:00`);
  if (Number.isNaN(date.getTime())) return null;
  return weekPeriodJst(date);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown> = {};
  try {
    const parsed = await request.json();
    if (typeof parsed === 'object' && parsed !== null) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // body 無し（空）は「先週」で扱う
  }

  const period = resolvePeriod(body);
  if (!period) {
    return NextResponse.json(
      { error: 'weekStart の形式が不正です（YYYY-MM-DD）' },
      { status: 400 },
    );
  }

  const ranking = await computeWeeklyRanking(
    db,
    eventId,
    period,
    guard.event.rankingMinReviews,
  );
  return NextResponse.json({ ranking });
}
