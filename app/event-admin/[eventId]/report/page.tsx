'use client';

// app/event-admin/[eventId]/report/page.tsx
// Push-taro.スタンプラリー 主催者向けの行動レポート画面。
// 報告書として出す3点 — 協賛・広告の数、クーポン使用履歴、
// クーポン使用の年代別・性別統計 — を、期間・店舗・年代・性別で
// 絞って表示し、印刷（PDF保存）と CSV で提出用に出せる。
// 集計は API（lib/action-report.ts の summarizeActionReport）が担う。
// 電話番号などの個人情報は表示しない。
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { User, onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase-client';
import { AdminLanguageSelect, useAdminLocale } from '@/components/AdminLocale';
import {
  ADMIN_CARD_BORDER,
  ADMIN_CARD_SHADOW,
  ADMIN_PAGE_BG,
  adminPageTitleStyle,
} from '@/components/AdminBrand';
import { adminText, uiText } from '@/lib/ui-text';
import { AdminShell } from '@/components/AdminShell';
import { AdminNav } from '../AdminNav';
import { AGE_BANDS, GENDERS } from '@/lib/member-demographics';

interface CountRow<K extends string = string> {
  key: K;
  count: number;
}

interface UsageRecord {
  claimId: string;
  couponId: string;
  couponTitle: string;
  exhibitorId: string;
  exhibitorName: string;
  redeemedAt: string;
  ageBand: string | null;
  gender: string | null;
}

interface ReportSummary {
  sponsors: {
    sponsorCount: number;
    shopCount: number;
    adSlotLiveCount: number;
    adSlotTotalCount: number;
    liveShopAdCount: number;
  };
  totalUsed: number;
  usage: UsageRecord[];
  byCoupon: {
    couponId: string;
    couponTitle: string;
    exhibitorId: string;
    exhibitorName: string;
    count: number;
  }[];
  byShop: { exhibitorId: string; exhibitorName: string; count: number }[];
  byAgeBand: CountRow[];
  byGender: CountRow[];
  daily: { period: string; count: number }[];
  monthly: { period: string; count: number }[];
}

const AGE_BAND_TEXT_KEYS = {
  'under-10': 'ageBandUnder10',
  '10s': 'ageBand10s',
  '20s': 'ageBand20s',
  '30s': 'ageBand30s',
  '40s': 'ageBand40s',
  '50s': 'ageBand50s',
  '60s': 'ageBand60s',
  '70-plus': 'ageBand70Plus',
  'no-answer': 'noAnswer',
} as const;

const GENDER_TEXT_KEYS = {
  male: 'genderMale',
  female: 'genderFemale',
  other: 'genderOther',
  'no-answer': 'noAnswer',
} as const;

const containerStyle: React.CSSProperties = {
  padding: '20px 16px 48px',
  maxWidth: 880,
  margin: '0 auto',
  fontFamily: 'sans-serif',
  backgroundColor: ADMIN_PAGE_BG,
  minHeight: '100vh',
  boxSizing: 'border-box',
  color: '#0f172a',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: `1px solid ${ADMIN_CARD_BORDER}`,
  borderRadius: 18,
  boxShadow: ADMIN_CARD_SHADOW,
  padding: 20,
};

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 14,
  marginTop: 10,
};

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  borderBottom: '2px solid #E8DCC4',
  padding: '8px 10px',
  fontSize: 12.5,
  color: '#64748b',
};

const tdStyle: React.CSSProperties = {
  borderBottom: '1px solid #f1f5f9',
  padding: '8px 10px',
};

const tdNumStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

const thNumStyle: React.CSSProperties = { ...thStyle, textAlign: 'right' };

const selectStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderRadius: 10,
  border: '1px solid #E8DCC4',
  fontSize: 13,
  backgroundColor: '#ffffff',
};

const buttonStyle: React.CSSProperties = {
  padding: '9px 18px',
  borderRadius: 999,
  border: '1px solid #E8DCC4',
  backgroundColor: '#ffffff',
  fontSize: 13,
  fontWeight: 700,
  cursor: 'pointer',
};

export default function ActionReportPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [eventName, setEventName] = useState('');
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [shops, setShops] = useState<
    { exhibitorId: string; exhibitorName: string }[]
  >([]);
  const [months, setMonths] = useState<string[]>([]);
  const [generatedAt, setGeneratedAt] = useState('');
  const [message, setMessage] = useState('');
  const [month, setMonth] = useState('');
  const [shopId, setShopId] = useState('');
  const [ageBand, setAgeBand] = useState('');
  const [gender, setGender] = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

  const filterQuery = useCallback(() => {
    const q = new URLSearchParams();
    if (month) q.set('month', month);
    if (shopId) q.set('exhibitorId', shopId);
    if (ageBand) q.set('ageBand', ageBand);
    if (gender) q.set('gender', gender);
    const s = q.toString();
    return s ? `?${s}` : '';
  }, [month, shopId, ageBand, gender]);

  const callApi = useCallback(
    async (path: string) => {
      if (!user) throw new Error(adminText(locale, 'loginRequired'));
      const idToken = await user.getIdToken();
      const res = await fetch(path, {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          data.error ??
            adminText(locale, 'apiError', { status: String(res.status) }),
        );
      }
      return data;
    },
    [user, locale],
  );

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [eventData, reportData] = await Promise.all([
        callApi(`/api/events/${eventId}`).catch(() => null),
        callApi(`/api/events/${eventId}/action-report${filterQuery()}`),
      ]);
      if (typeof eventData?.event?.name === 'string') {
        setEventName(eventData.event.name);
      }
      const next = reportData.summary as ReportSummary;
      setSummary(next);
      setShops(
        Array.isArray(reportData.shops) ? reportData.shops : [],
      );
      setMonths((prev) =>
        prev.length > 0
          ? prev
          : next.monthly.map((row) => row.period).sort().reverse(),
      );
      setGeneratedAt(
        typeof reportData.generatedAt === 'string'
          ? reportData.generatedAt
          : '',
      );
      setMessage('');
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : adminText(locale, 'actionReportLoadFailed'),
      );
    }
  }, [user, eventId, callApi, locale, filterQuery]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  const downloadCsv = useCallback(async () => {
    if (!user) return;
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(
        `/api/events/${eventId}/action-report/export${filterQuery()}`,
        { headers: { Authorization: `Bearer ${idToken}` } },
      );
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `action-report-${eventId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setMessage(adminText(locale, 'actionReportLoadFailed'));
    }
  }, [user, eventId, filterQuery, locale]);

  if (!authReady) return null;

  if (!user) {
    return (
      <main style={containerStyle}>
        <p style={{ fontSize: 14 }}>{adminText(locale, 'loginRequired')}</p>
        <p style={{ marginTop: 12 }}>
          <Link href={`/event-admin/${eventId}`}>
            {adminText(locale, 'navDashboard')}
          </Link>
        </p>
      </main>
    );
  }

  const ageLabel = (key: string | null): string => {
    if (key === null || key === 'unanswered') {
      return adminText(locale, 'actionReportUnanswered');
    }
    const textKey =
      AGE_BAND_TEXT_KEYS[key as keyof typeof AGE_BAND_TEXT_KEYS];
    return textKey ? uiText(locale, textKey) : key;
  };
  const genderLabel = (key: string | null): string => {
    if (key === null || key === 'unanswered') {
      return adminText(locale, 'actionReportUnanswered');
    }
    const textKey = GENDER_TEXT_KEYS[key as keyof typeof GENDER_TEXT_KEYS];
    return textKey ? uiText(locale, textKey) : key;
  };

  const countTable = (
    titleKey: Parameters<typeof adminText>[1],
    firstHeaderKey: Parameters<typeof adminText>[1],
    rows: { label: string; count: number }[],
  ) => (
    <section style={{ ...cardStyle, marginTop: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
        {adminText(locale, titleKey)}
      </h2>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{adminText(locale, firstHeaderKey)}</th>
            <th style={thNumStyle}>{adminText(locale, 'actionReportCount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <td style={tdStyle}>{row.label}</td>
              <td style={tdNumStyle}>{row.count}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <AdminShell
      locale={locale}
      email={user.email}
      onLogout={() => void signOut(auth)}
      languageSelect={<AdminLanguageSelect locale={locale} onChange={setLocale} />}
      nav={<AdminNav eventId={eventId} eventName={eventName} current="⑪" locale={locale} />}
    >
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #action-report, #action-report * { visibility: visible; }
          #action-report { position: absolute; inset: 0; padding: 0; }
          #action-report select { display: none; }
        }
      `}</style>
      <div style={containerStyle}>
        <div
          className="no-print"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <Link
            href={`/event-admin/${eventId}`}
            style={{ fontSize: 13, color: '#64748b' }}
          >
            ← {adminText(locale, 'navDashboard')}
          </Link>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => void downloadCsv()} style={buttonStyle}>
              {adminText(locale, 'actionReportCsv')}
            </button>
            <button onClick={() => window.print()} style={buttonStyle}>
              {adminText(locale, 'actionReportPrint')}
            </button>
          </div>
        </div>

        <div id="action-report">
          <h1 style={{ ...adminPageTitleStyle, marginTop: 16 }}>
            {adminText(locale, 'actionReportTitle')}
          </h1>
          {eventName && (
            <p style={{ fontSize: 14, marginTop: 6, fontWeight: 700 }}>{eventName}</p>
          )}
          {generatedAt && (
            <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
              {adminText(locale, 'actionReportGeneratedAt', {
                date: new Date(generatedAt).toLocaleString('ja-JP', {
                  timeZone: 'Asia/Tokyo',
                }),
              })}
            </p>
          )}
          {message && (
            <p style={{ fontSize: 14, color: '#b91c1c', marginTop: 12 }}>{message}</p>
          )}

          <section
            className="no-print"
            style={{ ...cardStyle, marginTop: 20 }}
          >
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <label style={{ fontSize: 12.5, color: '#64748b' }}>
                {adminText(locale, 'actionReportMonth')}
                <br />
                <select
                  value={month}
                  onChange={(e) => setMonth(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">{adminText(locale, 'actionReportAll')}</option>
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12.5, color: '#64748b' }}>
                {adminText(locale, 'actionReportShop')}
                <br />
                <select
                  value={shopId}
                  onChange={(e) => setShopId(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">{adminText(locale, 'actionReportAll')}</option>
                  {shops.map((shop) => (
                    <option key={shop.exhibitorId} value={shop.exhibitorId}>
                      {shop.exhibitorName}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12.5, color: '#64748b' }}>
                {adminText(locale, 'actionReportAgeBand')}
                <br />
                <select
                  value={ageBand}
                  onChange={(e) => setAgeBand(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">{adminText(locale, 'actionReportAll')}</option>
                  {AGE_BANDS.map((band) => (
                    <option key={band} value={band}>
                      {ageLabel(band)}
                    </option>
                  ))}
                  <option value="unanswered">
                    {adminText(locale, 'actionReportUnanswered')}
                  </option>
                </select>
              </label>
              <label style={{ fontSize: 12.5, color: '#64748b' }}>
                {adminText(locale, 'actionReportGender')}
                <br />
                <select
                  value={gender}
                  onChange={(e) => setGender(e.target.value)}
                  style={selectStyle}
                >
                  <option value="">{adminText(locale, 'actionReportAll')}</option>
                  {GENDERS.map((g) => (
                    <option key={g} value={g}>
                      {genderLabel(g)}
                    </option>
                  ))}
                  <option value="unanswered">
                    {adminText(locale, 'actionReportUnanswered')}
                  </option>
                </select>
              </label>
            </div>
          </section>

          {summary ? (
            <>
              <section style={{ ...cardStyle, marginTop: 20 }}>
                <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                  {adminText(locale, 'actionReportSponsors')}
                </h2>
                <div
                  style={{
                    display: 'flex',
                    gap: 28,
                    flexWrap: 'wrap',
                    marginTop: 12,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'actionReportSponsorCount')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.sponsors.sponsorCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'actionReportShopCount')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.sponsors.shopCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'actionReportAdSlots')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.sponsors.adSlotLiveCount} /{' '}
                      {summary.sponsors.adSlotTotalCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'actionReportLiveAds')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.sponsors.liveShopAdCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'actionReportTotalUsed')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.totalUsed}
                    </div>
                  </div>
                </div>
              </section>

              {summary.totalUsed === 0 ? (
                <p style={{ fontSize: 14, color: '#64748b', marginTop: 16 }}>
                  {adminText(locale, 'actionReportEmpty')}
                </p>
              ) : (
                <>
                  {countTable(
                    'actionReportByCoupon',
                    'actionReportCoupon',
                    summary.byCoupon.map((row) => ({
                      label: `${row.couponTitle}（${row.exhibitorName}）`,
                      count: row.count,
                    })),
                  )}
                  {countTable(
                    'actionReportByShop',
                    'actionReportShop',
                    summary.byShop.map((row) => ({
                      label: row.exhibitorName,
                      count: row.count,
                    })),
                  )}
                  {countTable(
                    'actionReportByAgeBand',
                    'actionReportAgeBand',
                    summary.byAgeBand.map((row) => ({
                      label: ageLabel(row.key),
                      count: row.count,
                    })),
                  )}
                  {countTable(
                    'actionReportByGender',
                    'actionReportGender',
                    summary.byGender.map((row) => ({
                      label: genderLabel(row.key),
                      count: row.count,
                    })),
                  )}
                  {countTable(
                    'actionReportDaily',
                    'actionReportDateTime',
                    summary.daily.map((row) => ({
                      label: row.period,
                      count: row.count,
                    })),
                  )}
                  {countTable(
                    'actionReportMonthly',
                    'actionReportMonth',
                    summary.monthly.map((row) => ({
                      label: row.period,
                      count: row.count,
                    })),
                  )}

                  <section style={{ ...cardStyle, marginTop: 20 }}>
                    <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                      {adminText(locale, 'actionReportHistory')}
                    </h2>
                    <table style={tableStyle}>
                      <thead>
                        <tr>
                          <th style={thStyle}>
                            {adminText(locale, 'actionReportDateTime')}
                          </th>
                          <th style={thStyle}>
                            {adminText(locale, 'actionReportCoupon')}
                          </th>
                          <th style={thStyle}>
                            {adminText(locale, 'actionReportShop')}
                          </th>
                          <th style={thStyle}>
                            {adminText(locale, 'actionReportAgeBand')}
                          </th>
                          <th style={thStyle}>
                            {adminText(locale, 'actionReportGender')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.usage.map((record) => (
                          <tr key={record.claimId}>
                            <td style={tdStyle}>
                              {new Date(record.redeemedAt).toLocaleString(
                                'ja-JP',
                                { timeZone: 'Asia/Tokyo' },
                              )}
                            </td>
                            <td style={tdStyle}>{record.couponTitle}</td>
                            <td style={tdStyle}>{record.exhibitorName}</td>
                            <td style={tdStyle}>{ageLabel(record.ageBand)}</td>
                            <td style={tdStyle}>{genderLabel(record.gender)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                </>
              )}
            </>
          ) : null}
        </div>
      </div>
    </AdminShell>
  );
}
