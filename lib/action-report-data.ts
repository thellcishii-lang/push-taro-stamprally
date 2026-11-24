// lib/action-report-data.ts
// 行動レポートの入力データを Firestore から読み込む（サーバー専用）。
// 集計そのものは lib/action-report.ts の純粋関数が担う。
// 読むのは消込済みクーポン（claims）、クーポン台帳、登録者の年代・性別
// （members）、参加店・協賛（exhibitors）、広告枠（adPlacements）と
// 店舗広告だけ。電話番号などの個人情報は読み出さない。
import { db } from './firebase-admin';
import { EVENT_SUBCOLLECTIONS } from './event';
import {
  EVENT_COUPONS_COLLECTION,
  listExhibitors,
} from './event-coupon';
import {
  AD_PLACEMENTS_COLLECTION,
  isAdSubscribedForStatus,
  listAdsForAdmin,
  parseAdPlacementStatus,
} from './event-ads';
import { normalizeAgeBand, normalizeGender } from './member-demographics';
import type {
  ActionReportSponsors,
  ActionReportUsageRecord,
} from './action-report';

export interface ActionReportInputs {
  records: ActionReportUsageRecord[];
  sponsors: ActionReportSponsors;
  /** フィルターの店舗セレクター用（参加店のみ）。 */
  shops: { exhibitorId: string; exhibitorName: string }[];
}

/** Firestore の Timestamp / 文字列などを ISO 文字列に寄せる。 */
function toIsoString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (
    value &&
    typeof value === 'object' &&
    'toDate' in value &&
    typeof (value as { toDate: unknown }).toDate === 'function'
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  if (
    value &&
    typeof value === 'object' &&
    '_seconds' in value &&
    typeof (value as { _seconds: unknown })._seconds === 'number'
  ) {
    return new Date(
      (value as { _seconds: number })._seconds * 1000,
    ).toISOString();
  }
  return '';
}

export async function loadActionReportInputs(
  eventId: string,
): Promise<ActionReportInputs> {
  const eventRef = db.collection('events').doc(eventId);
  const [claimsSnap, couponsSnap, membersSnap, exhibitors, placementsSnap, shopAds] =
    await Promise.all([
      eventRef
        .collection(EVENT_SUBCOLLECTIONS.claims)
        .where('status', '==', 'redeemed')
        .get(),
      eventRef.collection(EVENT_COUPONS_COLLECTION).get(),
      eventRef.collection(EVENT_SUBCOLLECTIONS.members).get(),
      listExhibitors(eventId),
      eventRef.collection(AD_PLACEMENTS_COLLECTION).get(),
      listAdsForAdmin(db, eventId),
    ]);

  const couponById = new Map<
    string,
    { title: string; exhibitorId: string; exhibitorName: string }
  >();
  for (const doc of couponsSnap.docs) {
    const data = doc.data();
    couponById.set(doc.id, {
      title: String(data.title ?? ''),
      exhibitorId: String(data.exhibitorId ?? ''),
      exhibitorName: String(data.exhibitorName ?? ''),
    });
  }

  const memberById = new Map<
    string,
    { ageBand: ReturnType<typeof normalizeAgeBand>; gender: ReturnType<typeof normalizeGender> }
  >();
  for (const doc of membersSnap.docs) {
    const data = doc.data();
    memberById.set(doc.id, {
      ageBand: normalizeAgeBand(data.ageBand),
      gender: normalizeGender(data.gender),
    });
  }

  const records: ActionReportUsageRecord[] = [];
  for (const doc of claimsSnap.docs) {
    const data = doc.data();
    const couponId = String(data.couponId ?? '');
    const coupon = couponById.get(couponId);
    const memberId = String(data.memberId ?? '');
    const member = memberById.get(memberId);
    records.push({
      claimId: doc.id,
      couponId,
      couponTitle: coupon?.title || '（削除されたクーポン）',
      exhibitorId: coupon?.exhibitorId ?? '',
      exhibitorName: coupon?.exhibitorName ?? '',
      memberId,
      redeemedAt: toIsoString(data.redeemedAt),
      ageBand: member?.ageBand ?? null,
      gender: member?.gender ?? null,
    });
  }

  let adSlotLiveCount = 0;
  for (const doc of placementsSnap.docs) {
    if (isAdSubscribedForStatus(parseAdPlacementStatus(doc.data().status))) {
      adSlotLiveCount += 1;
    }
  }

  const sponsors: ActionReportSponsors = {
    sponsorCount: exhibitors.filter((e) => e.kind === 'advertiser').length,
    shopCount: exhibitors.filter((e) => e.kind === 'shop').length,
    adSlotLiveCount,
    adSlotTotalCount: placementsSnap.size,
    liveShopAdCount: shopAds.filter((entry) => entry.ad.live).length,
  };

  const shops = exhibitors
    .filter((e) => e.kind === 'shop')
    .map((e) => ({ exhibitorId: e.id, exhibitorName: e.name }))
    .sort((a, b) => a.exhibitorName.localeCompare(b.exhibitorName, 'ja'));

  return { records, sponsors, shops };
}
