// app/api/events/[eventId]/site-settings/route.ts
// 特設サイト（本家上の公開ページ）の表示内容の取得・保存（主催者本人だけ）。
// 保存先はプロジェクトドキュメントのトップレベル項目
// （siteDescription / gourmetDefinition / heroImageUrl / siteIconUrl /
// themeColor / siteNotes / topPlacementEnabled / topPlacementPrice /
// adsEnabled / adsSlots / adsPrice / couponIssuePrice / pushPrice /
// shopMonthlyPrice）。
// 検証・正規化は lib/event-site.ts と lib/event.ts の純粋関数に寄せ、
// updateEvent 経由で保存する（リンク等の既存項目と同じ経路）。
import { NextResponse } from 'next/server';
import { requireEventOwner } from '@/lib/event-auth';
import { updateEvent } from '@/lib/event-store';
import { isAdsActionAllowed, resolveAdsOptionEnabled } from '@/lib/event-ads';
import {
  normalizeGourmetDefinition,
  normalizeHeroImageUrl,
  normalizeSiteDescription,
  normalizeSiteIconUrl,
  normalizeSiteNotes,
  normalizeThemeColor,
  type SiteSettings,
} from '@/lib/event-site';
import {
  normalizeAdsEnabled,
  normalizeAdsPrice,
  normalizeAdsSlots,
  normalizeCouponIssuePrice,
  normalizePushPrice,
  normalizeShopMonthlyPrice,
  normalizeTopPlacementEnabled,
  normalizeTopPlacementPrice,
} from '@/lib/event';

export const dynamic = 'force-dynamic';

/** 特設サイト設定一式（表示内容＋トップ掲載設定＋広告設定）。 */
interface SiteSettingsResponse extends SiteSettings {
  /** トップ掲載（先頭5枠）課金の ON/OFF */
  topPlacementEnabled: boolean;
  /** トップ掲載の月額料金（円）。未設定は null。0 は無料 */
  topPlacementPrice: number | null;
  /** 広告ページの ON/OFF */
  adsEnabled: boolean;
  /** 広告の掲載枠数 */
  adsSlots: number;
  /** 広告の月額料金（円）。未設定は null。0 は無料 */
  adsPrice: number | null;
  /** クーポン発行手数料（1件あたり・円）。未設定は null（無料扱い）。0 も無料 */
  couponIssuePrice: number | null;
  /** プッシュ配信手数料（1回あたり・円）。未設定は null（無料扱い）。0 も無料 */
  pushPrice: number | null;
  /** 参加店の自己登録の月額料金（円）。未設定は null（自己登録を受け付けない）。0 は無料 */
  shopMonthlyPrice: number | null;
  /**
   * 広告オプション（本家との別料金契約）が有効かどうか（読み取り専用）。
   * プロジェクト設定ではなく契約者レコードの値。無効な間は広告を
   * 有効にできず、既存の adsEnabled も効かない（表示・申請・掲載が止まる）。
   */
  adsOptionEnabled: boolean;
}

function currentSettings(event: {
  siteDescription: string;
  gourmetDefinition: string;
  heroImageUrl: string | null;
  siteIconUrl: string | null;
  themeColor: string | null;
  siteNotes: SiteSettings['siteNotes'];
  topPlacementEnabled: boolean;
  topPlacementPrice: number | null;
  adsEnabled: boolean;
  adsSlots: number;
  adsPrice: number | null;
  couponIssuePrice: number | null;
  pushPrice: number | null;
  shopMonthlyPrice: number | null;
}): Omit<SiteSettingsResponse, 'adsOptionEnabled'> {
  return {
    siteDescription: event.siteDescription,
    gourmetDefinition: event.gourmetDefinition,
    heroImageUrl: event.heroImageUrl,
    siteIconUrl: event.siteIconUrl,
    themeColor: event.themeColor,
    siteNotes: event.siteNotes,
    topPlacementEnabled: event.topPlacementEnabled,
    topPlacementPrice: event.topPlacementPrice,
    adsEnabled: event.adsEnabled,
    adsSlots: event.adsSlots,
    adsPrice: event.adsPrice,
    couponIssuePrice: event.couponIssuePrice,
    pushPrice: event.pushPrice,
    shopMonthlyPrice: event.shopMonthlyPrice,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;
  const adsOptionEnabled = await resolveAdsOptionEnabled(guard.event.ownerUid);
  return NextResponse.json({ ...currentSettings(guard.event), adsOptionEnabled });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const { eventId } = await params;
  const guard = await requireEventOwner(request, eventId);
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: 'リクエスト形式が不正です' },
      { status: 400 },
    );
  }

  const adsOptionEnabled = await resolveAdsOptionEnabled(guard.event.ownerUid);

  let settings: Omit<SiteSettingsResponse, 'adsOptionEnabled'>;
  try {
    settings = {
      siteDescription: normalizeSiteDescription(body.siteDescription),
      gourmetDefinition: normalizeGourmetDefinition(body.gourmetDefinition),
      heroImageUrl: normalizeHeroImageUrl(body.heroImageUrl),
      siteIconUrl: normalizeSiteIconUrl(body.siteIconUrl),
      themeColor: normalizeThemeColor(body.themeColor),
      siteNotes: normalizeSiteNotes(body.siteNotes),
      topPlacementEnabled: normalizeTopPlacementEnabled(
        body.topPlacementEnabled,
      ),
      topPlacementPrice: normalizeTopPlacementPrice(body.topPlacementPrice),
      adsEnabled: normalizeAdsEnabled(body.adsEnabled),
      adsSlots: normalizeAdsSlots(body.adsSlots),
      adsPrice: normalizeAdsPrice(body.adsPrice),
      couponIssuePrice: normalizeCouponIssuePrice(body.couponIssuePrice),
      pushPrice: normalizePushPrice(body.pushPrice),
      shopMonthlyPrice: normalizeShopMonthlyPrice(body.shopMonthlyPrice),
    };
    // トップ掲載を有効にするなら料金が必須（料金なしでは店が買えない）。
    // 0（無料）は料金として有効（参加表明で掲載される）。
    if (settings.topPlacementEnabled && settings.topPlacementPrice === null) {
      throw new Error('トップ掲載を有効にする場合は、掲載料金を設定してください');
    }
    // 広告を有効にするなら料金が必須（0=無料も料金として有効）。
    if (settings.adsEnabled && settings.adsPrice === null) {
      throw new Error('広告を有効にする場合は、広告料金を設定してください');
    }
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : '入力内容が不正です',
      },
      { status: 400 },
    );
  }

  // 広告オプション（契約）が無効な間は、広告を新たに有効にできない。
  // 既に有効な設定はそのまま保持する（オプションが戻れば再び効くが、
  // 無効な間は表示・申請・掲載のすべてが止まる）。
  if (
    settings.adsEnabled &&
    !guard.event.adsEnabled &&
    !isAdsActionAllowed('enable-setting', {
      adsOptionEnabled,
      adsEnabled: guard.event.adsEnabled,
    })
  ) {
    return NextResponse.json(
      { error: '広告を有効にするには、広告オプションの契約が必要です' },
      { status: 403 },
    );
  }

  try {
    await updateEvent(eventId, settings);
  } catch (error) {
    console.error('[site-settings] 保存に失敗:', error);
    return NextResponse.json(
      { error: '特設サイト設定の保存に失敗しました' },
      { status: 500 },
    );
  }
  return NextResponse.json({ ...settings, adsOptionEnabled });
}
