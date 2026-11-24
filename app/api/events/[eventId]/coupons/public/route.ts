// app/api/events/[eventId]/coupons/public/route.ts
// 来場者向けのクーポン一覧・検索。認証なしで閲覧できるが、
// 返すのは有効なクーポンの表示用項目だけ。?q= で会社名・キーワード検索。
// ?lang= があれば、タイトル・説明文をその言語で返す（作成時の自動翻訳を使用）。
// 店舗課金で掲載停止中の店のクーポンは出さない（店舗一覧の公開判定と揃える）。
// ただし、来場者が取得済みのクーポンの消し込み可否には影響しない
// （消し込み側のルートは変更しない）。
import { NextResponse } from 'next/server';
import { db } from '@/lib/firebase-admin';
import {
  couponClaimState,
  filterCoupons,
  jstTodayString,
  listCoupons,
} from '@/lib/event-coupon';
import { getEvent } from '@/lib/event-store';
import { listBillingSuspendedExhibitorIds } from '@/lib/event-shop';
import { normalizeLocale, pickLocalizedText } from '@/lib/i18n';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') ?? '';
  const event = await getEvent(eventId);
  const locale = normalizeLocale(searchParams.get('lang'), event?.defaultLocale);
  const suspended = await listBillingSuspendedExhibitorIds(db, eventId);
  const active = (await listCoupons(eventId)).filter(
    (coupon) => coupon.active && !suspended.has(coupon.exhibitorId),
  );
  const today = jstTodayString();
  const coupons = filterCoupons(active, query).map((coupon) => ({
    id: coupon.id,
    title:
      pickLocalizedText(coupon.titleI18n, locale, event?.defaultLocale) ||
      coupon.title,
    description:
      pickLocalizedText(coupon.descriptionI18n, locale, event?.defaultLocale) ||
      coupon.description,
    exhibitorId: coupon.exhibitorId,
    exhibitorName: coupon.exhibitorName,
    keywords: coupon.keywords,
    // 取得・使用期間（告知中の先行取得では、開始前・終了後も見せて
    // claimState で出し分ける）
    claimFrom: coupon.claimFrom,
    claimUntil: coupon.claimUntil,
    useFrom: coupon.useFrom,
    useUntil: coupon.useUntil,
    claimState: couponClaimState(coupon, today),
  }));
  return NextResponse.json({ coupons });
}
