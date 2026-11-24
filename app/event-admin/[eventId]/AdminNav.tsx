'use client';

// app/event-admin/[eventId]/AdminNav.tsx
// 管理画面の共通ナビ。
// AdminShell のサイドバー（PC）とアコーディオン（スマホ）の中に置かれる。
// plain=true のときはサイドバー用にカード枠なし、通常はスマホ用に
// 白カードの中にアイコン付きメニューを縦に並べる。
// 現在地はどちらもバイオレットの塗りつぶしで示す（承認済みモック準拠）。
// 構造: プロジェクト内の画面では、先頭に「プロジェクト一覧」への戻りリンク、
// その下にプロジェクト名（見出し）、続いてダッシュボード、その下に
// 「ポータル」と「アプリ」の2グループを並べる（スタンプラリーは
// ポータル主体の製品で、コンソールは1つに寄せる）。
// クーポン・特典の管理場所は常に1か所: ポータル（特設サイト本契約）が
// 有効な間はポータル側で管理し、アプリ側の項目はグレーアウトして
// 「管理はポータル側」と出す。ポータルが無い（アプリ単独）間は逆になる。
// ポータルの有効状態はこのコンポーネントがイベント取得 API から読む。
// プロジェクトのダッシュボード（/event-admin/[eventId]）を開いた時点で
// サイドバーがこのプロジェクトメニューに切り替わる。
// eventId が無い場合（主催者トップ）はプロジェクト設定のみを現在地として出す。
// 上限警告バナー（CapWarningBanner）は各画面のコンテンツ側で描画する。
import { useEffect, useState, type ReactNode } from 'react';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '@/lib/firebase-client';
import { adminText } from '@/lib/ui-text';
import type { Locale } from '@/lib/i18n';
import { specialSiteUrl } from '@/lib/special-site';
import { ADMIN_CARD_BORDER, ADMIN_CARD_SHADOW, ADMIN_VIOLET } from '@/components/AdminBrand';

function NavIcon({ children }: { children: ReactNode }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {children}
    </svg>
  );
}

const eventIcon = (
  <NavIcon>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </NavIcon>
);

const dashboardIcon = (
  <NavIcon>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </NavIcon>
);

const settingsIcon = (
  <NavIcon>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 4.6v2.6M12 16.8v2.6M4.6 12h2.6M16.8 12h2.6M6.8 6.8l1.8 1.8M15.4 15.4l1.8 1.8M17.2 6.8l-1.8 1.8M8.6 15.4l-1.8 1.8" />
  </NavIcon>
);

const pushIcon = (
  <NavIcon>
    <path d="M22 2 11 13" />
    <path d="M22 2 15 22l-4-9-9-4z" />
  </NavIcon>
);

const scheduleIcon = (
  <NavIcon>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </NavIcon>
);

const couponsIcon = (
  <NavIcon>
    <path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z" />
    <path d="M13 5v2M13 11v2M13 17v2" />
  </NavIcon>
);

const reviewsIcon = (
  <NavIcon>
    <path d="M12 3.6l2.5 5.1 5.6.8-4 4 1 5.6-5.1-2.7-5.1 2.7 1-5.6-4-4 5.6-.8z" />
  </NavIcon>
);

const reportIcon = (
  <NavIcon>
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-7" />
    <path d="M22 20H2" />
  </NavIcon>
);

const socialIcon = (
  <NavIcon>
    <rect x="3" y="3" width="18" height="18" rx="5" />
    <circle cx="12" cy="12" r="4" />
    <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
  </NavIcon>
);

const billingIcon = (
  <NavIcon>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M3 10h18M7 15h4" />
  </NavIcon>
);

const siteEditIcon = (
  <NavIcon>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </NavIcon>
);

const adsIcon = (
  <NavIcon>
    <path d="M3 11l14-6v14L3 13v-2z" />
    <path d="M7 13v5a2 2 0 0 0 4 0v-3.6" />
    <path d="M17 8a4 4 0 0 1 0 6" />
  </NavIcon>
);

const externalIcon = (
  <NavIcon>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
  </NavIcon>
);

const gearIcon = (
  <NavIcon>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </NavIcon>
);

const itemBaseStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '12px 14px',
  fontSize: 15,
  fontWeight: 700,
  borderRadius: 12,
  textDecoration: 'none',
};

const itemLinkStyle: React.CSSProperties = {
  ...itemBaseStyle,
  color: '#26233B',
};

const itemCurrentStyle: React.CSSProperties = {
  ...itemBaseStyle,
  backgroundColor: ADMIN_VIOLET,
  color: '#ffffff',
  boxShadow: '0 4px 12px rgba(139, 94, 52, 0.30)',
};

const cardNavStyle: React.CSSProperties = {
  marginTop: 18,
  backgroundColor: '#ffffff',
  border: `1px solid ${ADMIN_CARD_BORDER}`,
  borderRadius: 18,
  boxShadow: ADMIN_CARD_SHADOW,
  padding: 10,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const plainNavStyle: React.CSSProperties = {
  marginTop: 8,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const backLinkStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  fontSize: 13.5,
  fontWeight: 600,
  color: '#8A7A63',
  textDecoration: 'none',
};

const projectNameStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '12px 14px 6px',
  fontSize: 16,
  fontWeight: 800,
  color: '#2E2015',
};

const headingStyle: React.CSSProperties = {
  padding: '14px 14px 2px',
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: '0.08em',
  color: '#8A7A63',
};

const itemDisabledStyle: React.CSSProperties = {
  ...itemBaseStyle,
  color: '#94a3b8',
  opacity: 0.55,
  cursor: 'default',
};

const itemNoteStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11.5,
  fontWeight: 600,
  color: '#94a3b8',
  marginTop: 2,
};

export function AdminNav({
  eventId,
  eventName,
  current,
  locale,
  plain = false,
}: {
  eventId?: string;
  /** プロジェクト内の画面で、メニューの見出しとしてそのプロジェクト名を出す。 */
  eventName?: string;
  current: string;
  locale: Locale;
  /** サイドバー内ではカード枠なしにする（AdminShell が指定）。 */
  plain?: boolean;
}) {
  // ポータル（特設サイト本契約）の有効状態。クーポン・特典の管理場所の
  // 切り替え（グレーアウト）に使う。読み取り前・失敗時はアプリ側管理
  // （ポータル無効）に倒す。
  const [portalEnabled, setPortalEnabled] = useState(false);
  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    const unsub = onAuthStateChanged(auth, (u) => {
      if (!u) return;
      void (async () => {
        try {
          const idToken = await u.getIdToken();
          const res = await fetch(`/api/events/${eventId}`, {
            headers: { Authorization: `Bearer ${idToken}` },
          });
          const data = await res.json().catch(() => ({}));
          if (!cancelled && data?.event?.portalEnabled === true) {
            setPortalEnabled(true);
          }
        } catch {
          // 既定（アプリ側管理）のまま
        }
      })();
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [eventId]);

  type NavItem = {
    type: 'item';
    key: string;
    href: string;
    label: string;
    icon: ReactNode;
    external?: boolean;
    disabled?: boolean;
    note?: string;
  };
  type NavEntry = NavItem | { type: 'heading'; key: string; label: string };

  const couponsHref = `/event-admin/${eventId}/coupons`;
  const entries: NavEntry[] = eventId
    ? [
        { type: 'item', key: 'ダッシュボード', href: `/event-admin/${eventId}`, label: adminText(locale, 'navDashboard'), icon: dashboardIcon },
        { type: 'heading', key: '見出しポータル', label: adminText(locale, 'navPortalGroup') },
        // 特設サイト編集は公開ページの表示内容（紹介文・ヒーロー画像・
        // 追加事項）を編集する画面。下の外部リンク（公開ページそのもの）
        // とは別物なので、並べて置く。
        { type: 'item', key: '⑧', href: `/event-admin/${eventId}/site`, label: adminText(locale, 'navSiteEdit'), icon: siteEditIcon },
        // クーポン・特典の管理はポータル有効時はポータル側。アプリ側の
        // 項目（下）はグレーアウトする。
        {
          type: 'item',
          key: '③P',
          href: couponsHref,
          label: adminText(locale, 'navCouponsBenefits'),
          icon: couponsIcon,
          disabled: !portalEnabled,
          note: !portalEnabled ? adminText(locale, 'couponsManagedOnApp') : undefined,
        },
        { type: 'item', key: '④', href: `/event-admin/${eventId}/reviews`, label: adminText(locale, 'navReviews'), icon: reviewsIcon },
        { type: 'item', key: '⑨', href: `/event-admin/${eventId}/ads`, label: adminText(locale, 'navAds'), icon: adsIcon },
        { type: 'item', key: '⑤', href: `/event-admin/${eventId}/social`, label: adminText(locale, 'navSocial'), icon: socialIcon },
        { type: 'item', key: '⑪', href: `/event-admin/${eventId}/report`, label: adminText(locale, 'navActionReport'), icon: reportIcon },
        // 特設サイトは本家（push-taro.com）上の公開ページ。宣伝に使う
        // URL へすぐ飛べるよう、ポータル末尾に外部リンクとして置く。
        {
          type: 'item',
          key: '特設',
          href: specialSiteUrl(eventId),
          label: adminText(locale, 'navSpecialSite'),
          icon: externalIcon,
          external: true,
        },
        { type: 'heading', key: '見出しアプリ', label: adminText(locale, 'navAppGroup') },
        { type: 'item', key: '①', href: `/event-admin/${eventId}/push`, label: adminText(locale, 'navPush'), icon: pushIcon },
        { type: 'item', key: '②', href: `/event-admin/${eventId}/schedule`, label: adminText(locale, 'navSchedule'), icon: scheduleIcon },
        // ポータル有効時はアプリ側のクーポン・特典はグレーアウトし、
        // 管理がポータル側であることを出す。
        {
          type: 'item',
          key: '③',
          href: couponsHref,
          label: adminText(locale, 'navCouponsBenefits'),
          icon: couponsIcon,
          disabled: portalEnabled,
          note: portalEnabled ? adminText(locale, 'couponsManagedOnPortal') : undefined,
        },
        { type: 'item', key: '⑩', href: `/event-admin/${eventId}/push-requests`, label: adminText(locale, 'navPushRequests'), icon: pushIcon },
        // 課金は別料金オプション。ナビは常時出し、オプション OFF の
        // 契約では課金ページ側で案内文を出す（API が 404 を返す）。
        { type: 'item', key: '⑦', href: `/event-admin/${eventId}/billing`, label: adminText(locale, 'navBilling'), icon: billingIcon },
        { type: 'item', key: '⑥', href: `/event-admin/${eventId}/settings`, label: adminText(locale, 'navConfig'), icon: gearIcon },
      ]
    : [
        { type: 'item', key: '設定', href: '/event-admin', label: adminText(locale, 'navSettings'), icon: settingsIcon },
      ];
  return (
    <nav style={plain ? plainNavStyle : cardNavStyle}>
      {eventId && (
        <>
          <a href="/event-admin" style={backLinkStyle}>
            ← {adminText(locale, 'eventsListTitle')}
          </a>
          {eventName && (
            <div style={projectNameStyle}>
              <span style={{ display: 'flex', color: ADMIN_VIOLET }}>{eventIcon}</span>
              {eventName}
            </div>
          )}
        </>
      )}
      {entries.map((entry) => {
        if (entry.type === 'heading') {
          return (
            <div key={entry.key} style={headingStyle}>
              {entry.label}
            </div>
          );
        }
        const item = entry;
        if (item.disabled) {
          return (
            <span key={item.key} style={itemDisabledStyle} aria-disabled="true">
              <span style={{ display: 'flex', color: '#94a3b8' }}>{item.icon}</span>
              <span>
                {item.label}
                {item.note && <span style={itemNoteStyle}>{item.note}</span>}
              </span>
            </span>
          );
        }
        return item.key === current ? (
          <span key={item.key} style={itemCurrentStyle} aria-current="page">
            <span style={{ display: 'flex', color: '#ffffff' }}>{item.icon}</span>
            {item.label}
          </span>
        ) : (
          <a
            key={item.key}
            href={item.href}
            style={itemLinkStyle}
            {...(item.external ? { target: '_blank', rel: 'noreferrer' } : {})}
          >
            <span style={{ display: 'flex', color: ADMIN_VIOLET }}>{item.icon}</span>
            {item.label}
            {item.external && (
              <span aria-hidden="true" style={{ marginLeft: 'auto', fontSize: 13, color: '#94a3b8' }}>
                ↗
              </span>
            )}
          </a>
        );
      })}
    </nav>
  );
}
