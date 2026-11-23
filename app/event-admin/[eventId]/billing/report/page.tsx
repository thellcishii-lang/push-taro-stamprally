'use client';

// app/event-admin/[eventId]/billing/report/page.tsx
// Push-taro.スタンプラリー 主催者向けの集計レポート画面。
// 明細CSV（他のソフトへ読み込ませる生データ）とは別に、集計ソフトの
// レポートのように期間で畳んだ表で見せる画面。日次・月次・年次・
// 店舗別月次と総合計を出し、印刷（PDF保存）もできる。
// 集計は API（lib/event-billing.ts の summarizeBillingPayments）が担う。
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
import { adminText } from '@/lib/ui-text';
import { AdminShell } from '@/components/AdminShell';
import { AdminNav } from '../../AdminNav';

interface SummaryBucket {
  period: string;
  paidCount: number;
  paidAmount: number;
  failedCount: number;
}

interface ShopMonthlyBucket {
  month: string;
  exhibitorId: string;
  shopName: string;
  paidCount: number;
  paidAmount: number;
  failedCount: number;
}

interface SummaryData {
  daily: SummaryBucket[];
  monthly: SummaryBucket[];
  yearly: SummaryBucket[];
  shopMonthly: ShopMonthlyBucket[];
  totalPaidCount: number;
  totalPaidAmount: number;
  totalFailedCount: number;
}

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

function yen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`;
}

export default function BillingReportPage() {
  const params = useParams<{ eventId: string }>();
  const eventId = params.eventId;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [locale, setLocale] = useAdminLocale();
  const [eventName, setEventName] = useState('');
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [generatedAt, setGeneratedAt] = useState('');
  const [message, setMessage] = useState('');
  // 期間の絞り込み（'' = すべて）。月次は年で、日次と店舗別月次は月で分ける。
  const [monthlyYear, setMonthlyYear] = useState('');
  const [dailyMonth, setDailyMonth] = useState('');
  const [shopMonth, setShopMonth] = useState('');

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthReady(true);
    });
    return unsub;
  }, []);

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
      const [eventData, summaryData] = await Promise.all([
        callApi(`/api/events/${eventId}`).catch(() => null),
        callApi(`/api/events/${eventId}/shop-billings/summary`),
      ]);
      if (typeof eventData?.event?.name === 'string') {
        setEventName(eventData.event.name);
      }
      setSummary(summaryData.summary as SummaryData);
      setGeneratedAt(
        typeof summaryData.generatedAt === 'string'
          ? summaryData.generatedAt
          : '',
      );
      setMessage('');
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : adminText(locale, 'billingReportLoadFailed'),
      );
    }
  }, [user, eventId, callApi, locale]);

  useEffect(() => {
    if (user) void load();
  }, [user, load]);

  if (!authReady) return null;

  if (!user) {
    return (
      <main style={containerStyle}>
        <p style={{ fontSize: 14 }}>{adminText(locale, 'loginRequired')}</p>
        <p style={{ marginTop: 12 }}>
          <Link href={`/event-admin/${eventId}/billing`}>
            {adminText(locale, 'billingReportBack')}
          </Link>
        </p>
      </main>
    );
  }

  const periodSelect = (
    value: string,
    onChange: (next: string) => void,
    options: string[],
  ) => (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '7px 10px',
        borderRadius: 10,
        border: '1px solid #E8DCC4',
        fontSize: 13,
        backgroundColor: '#ffffff',
      }}
    >
      <option value="">{adminText(locale, 'billingReportAllPeriods')}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );

  const bucketTable = (
    titleKey: Parameters<typeof adminText>[1],
    rows: SummaryBucket[],
    control?: React.ReactNode,
  ) => (
    <section style={{ ...cardStyle, marginTop: 20 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
          {adminText(locale, titleKey)}
        </h2>
        {control}
      </div>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>{adminText(locale, 'billingReportPeriod')}</th>
            <th style={thNumStyle}>{adminText(locale, 'billingReportPaidCount')}</th>
            <th style={thNumStyle}>{adminText(locale, 'billingReportPaidAmount')}</th>
            <th style={thNumStyle}>{adminText(locale, 'billingReportFailedCount')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.period}>
              <td style={tdStyle}>{row.period}</td>
              <td style={tdNumStyle}>{row.paidCount}</td>
              <td style={tdNumStyle}>{yen(row.paidAmount)}</td>
              <td style={tdNumStyle}>{row.failedCount}</td>
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
      nav={<AdminNav eventId={eventId} eventName={eventName} current="⑦" locale={locale} />}
    >
      <style>{`
        @media print {
          body * { visibility: hidden; }
          #billing-report, #billing-report * { visibility: visible; }
          #billing-report { position: absolute; inset: 0; padding: 0; }
          #billing-report select { display: none; }
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
            href={`/event-admin/${eventId}/billing`}
            style={{ fontSize: 13, color: '#64748b' }}
          >
            ← {adminText(locale, 'billingReportBack')}
          </Link>
          <button
            onClick={() => window.print()}
            style={{
              padding: '9px 18px',
              borderRadius: 999,
              border: '1px solid #E8DCC4',
              backgroundColor: '#ffffff',
              fontSize: 13,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {adminText(locale, 'billingReportPrint')}
          </button>
        </div>

        <div id="billing-report">
          <h1 style={{ ...adminPageTitleStyle, marginTop: 16 }}>
            {adminText(locale, 'billingReportTitle')}
          </h1>
          {eventName && (
            <p style={{ fontSize: 14, marginTop: 6, fontWeight: 700 }}>{eventName}</p>
          )}
          {generatedAt && (
            <p style={{ fontSize: 12.5, color: '#64748b', marginTop: 4 }}>
              {adminText(locale, 'billingReportGeneratedAt', {
                date: new Date(generatedAt).toLocaleString('ja-JP', {
                  timeZone: 'Asia/Tokyo',
                }),
              })}
            </p>
          )}
          {message && (
            <p style={{ fontSize: 14, color: '#b91c1c', marginTop: 12 }}>{message}</p>
          )}

          {summary && summary.totalPaidCount === 0 && summary.totalFailedCount === 0 ? (
            <p style={{ fontSize: 14, color: '#64748b', marginTop: 16 }}>
              {adminText(locale, 'billingReportEmpty')}
            </p>
          ) : summary ? (
            <>
              <section style={{ ...cardStyle, marginTop: 20 }}>
                <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                  {adminText(locale, 'billingReportTotal')}
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
                      {adminText(locale, 'billingReportPaidAmount')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {yen(summary.totalPaidAmount)}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'billingReportPaidCount')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.totalPaidCount}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>
                      {adminText(locale, 'billingReportFailedCount')}
                    </div>
                    <div style={{ fontSize: 26, fontWeight: 900 }}>
                      {summary.totalFailedCount}
                    </div>
                  </div>
                </div>
              </section>

              {bucketTable(
                'billingReportMonthly',
                monthlyYear
                  ? summary.monthly.filter((row) =>
                      row.period.startsWith(monthlyYear),
                    )
                  : summary.monthly,
                periodSelect(
                  monthlyYear,
                  setMonthlyYear,
                  summary.yearly.map((row) => row.period),
                ),
              )}
              {bucketTable('billingReportYearly', summary.yearly)}
              {bucketTable(
                'billingReportDaily',
                dailyMonth
                  ? summary.daily.filter((row) =>
                      row.period.startsWith(dailyMonth),
                    )
                  : summary.daily,
                periodSelect(
                  dailyMonth,
                  setDailyMonth,
                  summary.monthly.map((row) => row.period),
                ),
              )}

              <section style={{ ...cardStyle, marginTop: 20 }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0 }}>
                    {adminText(locale, 'billingReportShopMonthly')}
                  </h2>
                  {periodSelect(
                    shopMonth,
                    setShopMonth,
                    summary.monthly.map((row) => row.period),
                  )}
                </div>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={thStyle}>{adminText(locale, 'billingReportMonth')}</th>
                      <th style={thStyle}>{adminText(locale, 'billingReportShop')}</th>
                      <th style={thNumStyle}>{adminText(locale, 'billingReportPaidCount')}</th>
                      <th style={thNumStyle}>{adminText(locale, 'billingReportPaidAmount')}</th>
                      <th style={thNumStyle}>{adminText(locale, 'billingReportFailedCount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(shopMonth
                      ? summary.shopMonthly.filter(
                          (row) => row.month === shopMonth,
                        )
                      : summary.shopMonthly
                    ).map((row) => (
                      <tr key={`${row.month}|${row.exhibitorId}`}>
                        <td style={tdStyle}>{row.month}</td>
                        <td style={tdStyle}>{row.shopName}</td>
                        <td style={tdNumStyle}>{row.paidCount}</td>
                        <td style={tdNumStyle}>{yen(row.paidAmount)}</td>
                        <td style={tdNumStyle}>{row.failedCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </AdminShell>
  );
}
