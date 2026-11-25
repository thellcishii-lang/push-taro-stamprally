'use client';

// app/e/[eventId]/display/[exhibitorId]/page.tsx
// 回転QRの表示専用ページ。チェックポイントに固定したタブレット等で
// 開いておくと、数秒ごとに切り替わる QR を表示し続ける（無人運用前提）。
// 開くための鍵は表示リンク（?dt= 表示用トークン）で、コードの取得は
// そのトークンでしか叩けない API 経由。画面スリープ防止（Wake Lock）
// と自動更新を行う。スタッフ向け画面のため文言は日本語固定。
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { QRCodeSVG } from 'qrcode.react';

interface DisplayCode {
  url: string;
  exhibitorName: string;
  refreshInSeconds: number;
}

export default function CheckpointDisplayPage() {
  const params = useParams<{ eventId: string; exhibitorId: string }>();
  const eventId = params.eventId;
  const exhibitorId = params.exhibitorId;
  const [code, setCode] = useState<DisplayCode | null>(null);
  const [invalid, setInvalid] = useState(false);
  const timerRef = useRef<number | null>(null);

  // 画面スリープ防止（Wake Lock）。タブに戻ったときも取り直す。
  useEffect(() => {
    let wakeLock: { release: () => Promise<void> } | null = null;
    let disposed = false;
    const requestLock = async () => {
      try {
        const nav = navigator as Navigator & {
          wakeLock?: {
            request: (
              type: 'screen',
            ) => Promise<{ release: () => Promise<void> }>;
          };
        };
        if (!nav.wakeLock) return;
        wakeLock = await nav.wakeLock.request('screen');
      } catch {
        // 取れなくても表示は続ける
      }
    };
    void requestLock();
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !disposed) {
        void requestLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void wakeLock?.release().catch(() => undefined);
    };
  }, []);

  // 現在のコードを取り、ウィンドウの切り替わりに合わせて取り直す。
  useEffect(() => {
    let cancelled = false;
    const token = new URLSearchParams(window.location.search).get('dt') ?? '';
    if (!token) {
      setInvalid(true);
      return;
    }
    const fetchCode = async () => {
      try {
        const res = await fetch(
          `/api/events/${eventId}/checkpoints/${exhibitorId}/rotating-code?dt=${encodeURIComponent(token)}`,
        );
        if (!res.ok) {
          if (res.status === 403 || res.status === 404) {
            if (!cancelled) setInvalid(true);
            return;
          }
          throw new Error('fetch failed');
        }
        const data = (await res.json()) as DisplayCode;
        if (cancelled) return;
        setCode(data);
        const delayMs = Math.max(1, data.refreshInSeconds) * 1000 + 250;
        timerRef.current = window.setTimeout(() => void fetchCode(), delayMs);
      } catch {
        // 通信が切れたら少し待って取り直す（表示は前コードのまま）
        if (!cancelled) {
          timerRef.current = window.setTimeout(() => void fetchCode(), 3000);
        }
      }
    };
    void fetchCode();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [eventId, exhibitorId]);

  return (
    <main
      style={{
        minHeight: '100dvh',
        backgroundColor: '#ffffff',
        color: '#111827',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px 16px',
        boxSizing: 'border-box',
        textAlign: 'center',
      }}
    >
      {invalid ? (
        <>
          <p style={{ fontSize: 22, fontWeight: 700 }}>
            表示リンクが無効です
          </p>
          <p style={{ fontSize: 15, color: '#4b5563', marginTop: 12 }}>
            主催者に新しい表示リンクを発行してもらってください。
          </p>
        </>
      ) : code ? (
        <>
          <p
            style={{
              fontSize: 'clamp(22px, 5vw, 36px)',
              fontWeight: 800,
              margin: 0,
            }}
          >
            {code.exhibitorName}
          </p>
          <p
            style={{
              fontSize: 'clamp(14px, 3vw, 19px)',
              color: '#374151',
              marginTop: 10,
            }}
          >
            スタンプラリーのチェックポイント
          </p>
          <div
            style={{
              marginTop: 24,
              padding: 16,
              backgroundColor: '#ffffff',
              border: '3px solid #111827',
              borderRadius: 16,
            }}
          >
            <QRCodeSVG
              value={code.url}
              size={420}
              style={{ width: 'min(72vw, 420px)', height: 'auto' }}
            />
          </div>
          <p
            style={{
              fontSize: 'clamp(15px, 3.4vw, 20px)',
              fontWeight: 700,
              marginTop: 22,
            }}
          >
            スマートフォンで読み取ってください
          </p>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>
            このQRコードは数秒ごとに切り替わります
          </p>
        </>
      ) : (
        <p style={{ fontSize: 18, color: '#4b5563' }}>読み込み中…</p>
      )}
    </main>
  );
}
