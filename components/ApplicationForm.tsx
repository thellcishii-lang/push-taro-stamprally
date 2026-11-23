'use client';

// components/ApplicationForm.tsx
// 自己申込ページ（参加店登録 /e/[eventId]/apply・広告申込
// /e/[eventId]/ad-apply）の共通フォーム。
// 名前＋メールを送ると、有料なら主催者自身の Stripe の支払いページへ
// 進み、無料ならその場で登録が完了する。支払い後は戻り先でサーバーに
// 照会して登録を確定させる（Webhook でも同じ確定が冪等に行われる）。
// 画面の固定文は4言語辞書（lib/ui-text.ts）。言語はプロジェクトの
// 既定言語に合わせる（申込者はまだレコードを持たないため個人設定がない）。
import { useEffect, useState } from 'react';
import { uiText } from '@/lib/ui-text';
import { themeCssVars } from '@/lib/theme-color';
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from '@/lib/i18n';
import PoweredByFooter from '@/components/PoweredByFooter';

const ACCENT = 'var(--theme-accent, #8B5E34)';

const containerStyle: React.CSSProperties = {
  padding: '16px 16px 32px',
  maxWidth: 480,
  margin: '0 auto',
  fontFamily: 'sans-serif',
  backgroundColor: '#f8fafc',
  minHeight: '100vh',
  boxSizing: 'border-box',
  color: '#0f172a',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 18,
  boxShadow: '0 1px 3px rgba(15, 23, 42, 0.08)',
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '12px 12px',
  marginTop: 6,
  border: '1px solid #cbd5e1',
  borderRadius: 10,
  fontSize: 16,
  backgroundColor: '#ffffff',
  boxSizing: 'border-box',
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 14,
  fontWeight: 700,
  marginTop: 16,
};

const primaryButtonStyle: React.CSSProperties = {
  width: '100%',
  padding: '14px 20px',
  fontWeight: 700,
  fontSize: 16,
  backgroundColor: ACCENT,
  color: '#ffffff',
  border: 'none',
  borderRadius: 12,
  cursor: 'pointer',
};

interface ApplyInfo {
  eventName: string;
  defaultLocale: string;
  shop: {
    available: boolean;
    fee: number | null;
    /** 店舗課金オプション ON のとき住所が必須（サーバー側でも検証する） */
    billingAddressRequired: boolean;
  };
  ad: { available: boolean; fee: number | null };
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'form' }
  | { kind: 'verifying' }
  | { kind: 'completed' }
  | { kind: 'unavailable' };

export default function ApplicationForm({
  eventId,
  flow,
}: {
  eventId: string;
  flow: 'shop' | 'ad';
}) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [themeColor, setThemeColor] = useState<string | null>(null);
  const [info, setInfo] = useState<ApplyInfo | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const flowInfo = info ? (flow === 'shop' ? info.shop : info.ad) : null;

  // 申込可否・料金とテーマカラーを読む。Checkout からの戻り
  // （?apply=success&session_id=...）なら、先に支払いを照会して
  // 登録を確定させる。
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [infoRes, publicRes] = await Promise.all([
          fetch(`/api/events/${eventId}/apply`),
          fetch(`/api/events/${eventId}/public`),
        ]);
        const infoData = (await infoRes.json().catch(() => ({}))) as ApplyInfo;
        if (infoRes.ok && active) {
          setInfo(infoData);
          setLocale(normalizeLocale(infoData.defaultLocale));
        }
        if (publicRes.ok && active) {
          const publicData = await publicRes.json().catch(() => ({}));
          if (typeof publicData.event?.themeColor === 'string') {
            setThemeColor(publicData.event.themeColor);
          }
        }
        if (!active) return;

        const params = new URLSearchParams(window.location.search);
        const applyState = params.get('apply');
        const sessionId = params.get('session_id');
        if (applyState === 'success' && sessionId) {
          setPhase({ kind: 'verifying' });
          const verifyRes = await fetch(
            `/api/events/${eventId}/apply/verify`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId }),
            },
          );
          const verifyData = await verifyRes.json().catch(() => ({}));
          if (!active) return;
          if (verifyRes.ok) {
            setPhase({ kind: 'completed' });
          } else {
            setMessage(
              typeof verifyData.error === 'string'
                ? verifyData.error
                : uiText(normalizeLocale(infoData?.defaultLocale), 'applyFailed'),
            );
            setPhase({ kind: 'form' });
          }
          return;
        }
        if (applyState === 'canceled') {
          setMessage(
            uiText(normalizeLocale(infoData?.defaultLocale), 'applyCanceled'),
          );
        }
        const available =
          infoRes.ok &&
          (flow === 'shop' ? infoData.shop?.available : infoData.ad?.available);
        setPhase({ kind: available ? 'form' : 'unavailable' });
      } catch {
        if (active) setPhase({ kind: 'unavailable' });
      }
    })();
    return () => {
      active = false;
    };
  }, [eventId, flow]);

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch(
        `/api/events/${eventId}/apply/${flow === 'shop' ? 'shop' : 'ad'}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            flow === 'shop' ? { name, email, address } : { name, email },
          ),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(
          typeof data.error === 'string'
            ? data.error
            : uiText(locale, 'applyFailed'),
        );
        return;
      }
      if (typeof data.checkoutUrl === 'string' && data.checkoutUrl) {
        window.location.href = data.checkoutUrl;
        return;
      }
      setPhase({ kind: 'completed' });
    } catch {
      setMessage(uiText(locale, 'applyFailed'));
    } finally {
      setBusy(false);
    }
  };

  // 住所欄は参加店登録で、店舗課金オプションが有効なプロジェクトの
  // ときだけ出す（必須）。広告申込では出さない。
  const addressRequired =
    flow === 'shop' && info?.shop.billingAddressRequired === true;

  const title = uiText(locale, flow === 'shop' ? 'applyShopTitle' : 'applyAdTitle');
  const lead = uiText(locale, flow === 'shop' ? 'applyShopLead' : 'applyAdLead', {
    eventName: info?.eventName ?? '',
  });
  const fee = flowInfo?.fee ?? null;

  return (
    <main
      style={{ ...containerStyle, ...themeCssVars(themeColor) } as React.CSSProperties}
    >
      <h1 style={{ fontSize: 20, fontWeight: 800, margin: '8px 0 0' }}>
        {info?.eventName ?? ''}
      </h1>
      <section style={{ ...cardStyle, padding: 20, marginTop: 16 }}>
        <h2 style={{ fontSize: 17, fontWeight: 800, margin: 0 }}>{title}</h2>
        {phase.kind === 'loading' && (
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 12 }}>
            {uiText(locale, 'loading')}
          </p>
        )}
        {phase.kind === 'verifying' && (
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 12 }}>
            {uiText(locale, 'applyVerifying')}
          </p>
        )}
        {phase.kind === 'unavailable' && (
          <p style={{ fontSize: 14, color: '#64748b', marginTop: 12 }}>
            {uiText(locale, 'applyNotAvailable')}
          </p>
        )}
        {phase.kind === 'completed' && (
          <>
            <p style={{ fontSize: 15, fontWeight: 700, marginTop: 12 }}>
              {uiText(locale, 'applyCompletedTitle')}
            </p>
            <p style={{ fontSize: 14, lineHeight: 1.7, marginTop: 8 }}>
              {uiText(locale, 'applyCompletedBody')}
            </p>
          </>
        )}
        {phase.kind === 'form' && (
          <>
            <p style={{ fontSize: 14, lineHeight: 1.7, marginTop: 10 }}>{lead}</p>
            {fee !== null && (
              <p style={{ fontSize: 15, fontWeight: 700, marginTop: 12 }}>
                {fee === 0
                  ? uiText(locale, 'applyFree')
                  : uiText(locale, 'applyMonthlyFee', {
                      amount: fee.toLocaleString(),
                    })}
              </p>
            )}
            <label style={{ ...labelStyle, marginTop: 20 }}>
              {uiText(locale, 'applyNameLabel')}
              <input
                style={inputStyle}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="organization"
              />
            </label>
            <label style={labelStyle}>
              {uiText(locale, 'applyEmailLabel')}
              <input
                style={inputStyle}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
            </label>
            {addressRequired && (
              <label style={labelStyle}>
                {uiText(locale, 'exhibitorAddressLabel')}
                <input
                  style={inputStyle}
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  autoComplete="street-address"
                />
                <span
                  style={{
                    display: 'block',
                    fontSize: 12.5,
                    fontWeight: 400,
                    color: '#64748b',
                    marginTop: 6,
                    lineHeight: 1.6,
                  }}
                >
                  {uiText(locale, 'exhibitorAddressNote')}
                </span>
              </label>
            )}
            <button
              onClick={() => void handleSubmit()}
              disabled={busy}
              style={{ ...primaryButtonStyle, marginTop: 22, opacity: busy ? 0.6 : 1 }}
            >
              {fee !== null && fee > 0
                ? uiText(locale, 'applyPayButton')
                : uiText(locale, 'applySubmitButton')}
            </button>
            {message && (
              <p style={{ color: '#b91c1c', marginTop: 12, fontSize: 14 }}>
                {message}
              </p>
            )}
            {flow === 'ad' && (
              <p style={{ marginTop: 16, fontSize: 13.5 }}>
                <a
                  href={`/e/${eventId}/shop`}
                  style={{ color: ACCENT, fontWeight: 700 }}
                >
                  {uiText(locale, 'applyAdLoginLink')}
                </a>
              </p>
            )}
          </>
        )}
      </section>
      <PoweredByFooter />
    </main>
  );
}
