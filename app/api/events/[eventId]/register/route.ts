// app/api/events/[eventId]/register/route.ts
// 来場者登録 API。本人確認の方式は契約のデータ上のスイッチ
// （organizers.smsAuthEnabled）で切り替わる:
// - SMSオン: Firebase Phone Auth（SMS認証）で本人確認した電話番号をキーに、
//   events/{eventId} 配下へ members（本人確認）と subscribers（プッシュ購読）
//   を保存する。
// - SMSオフ（既定）: 端末認証。匿名認証の uid（端末に保持される識別子）を
//   キーに保存し、電話番号は一切集めない。
import { NextResponse } from 'next/server';
import { authAdmin } from '@/lib/firebase-admin';
import { enforceRateLimit } from '@/lib/rate-limit';
import {
  registerEventDeviceVisitor,
  registerEventVisitor,
} from '@/lib/event-register';
import { getEvent } from '@/lib/event-store';
import { getEventSmsAuthEnabled } from '@/lib/event-member-auth';
import { normalizeAgeBand, normalizeGender } from '@/lib/member-demographics';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ eventId: string }> },
) {
  const retryAfter = await enforceRateLimit(request, 'event-register', 20, 60 * 1000);
  if (retryAfter !== null) {
    return NextResponse.json(
      { error: 'レート制限を超えました' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  const { eventId } = await params;

  const event = await getEvent(eventId);
  if (!event) {
    return NextResponse.json({ error: 'イベントが見つかりません' }, { status: 404 });
  }
  const smsEnabled = await getEventSmsAuthEnabled(event);
  const requiredMessage = smsEnabled ? '電話番号認証が必要です' : '認証が必要です';
  const expiredMessage = smsEnabled
    ? '電話番号認証の有効期限が切れています'
    : '認証の有効期限が切れています';

  // 本人確認済みのトークンから本人キーを取り出す。本人確認が無い登録は受けない。
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return NextResponse.json({ error: requiredMessage }, { status: 401 });
  }
  let decoded: { uid?: unknown; phone_number?: unknown };
  try {
    decoded = await authAdmin.verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: expiredMessage }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'リクエスト形式が不正です' }, { status: 400 });
  }
  const fcmToken = typeof body.fcmToken === 'string' ? body.fcmToken.trim() : '';
  if (!fcmToken || fcmToken.includes('/')) {
    return NextResponse.json({ error: '有効な fcmToken が必要です' }, { status: 400 });
  }
  const lang = typeof body.lang === 'string' ? body.lang : undefined;
  // 年代・性別は任意。許可コードのときだけ登録処理へ渡し、不正値や
  // 未送信は「送られなかった」扱いに倒す（保存側で null / 未更新になる）。
  const ageBand = normalizeAgeBand(body.ageBand);
  const gender = normalizeGender(body.gender);
  const demographics = {
    ...(ageBand ? { ageBand } : {}),
    ...(gender ? { gender } : {}),
  };

  if (smsEnabled) {
    if (typeof decoded.phone_number !== 'string' || !decoded.phone_number) {
      return NextResponse.json({ error: requiredMessage }, { status: 401 });
    }
    const result = await registerEventVisitor(eventId, {
      phoneE164: decoded.phone_number,
      fcmToken,
      lang,
      ...demographics,
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    return NextResponse.json({ ok: true, memberId: result.memberId }, { status: 201 });
  }

  // 端末認証: 匿名認証の uid が端末の識別子になる。
  if (typeof decoded.uid !== 'string' || !decoded.uid) {
    return NextResponse.json({ error: requiredMessage }, { status: 401 });
  }
  const result = await registerEventDeviceVisitor(eventId, {
    deviceUid: decoded.uid,
    fcmToken,
    lang,
    ...demographics,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, memberId: result.memberId }, { status: 201 });
}
