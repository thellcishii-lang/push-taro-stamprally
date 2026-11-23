// lib/event-stamp.test.ts
// スタンプの純粋ロジック: ドキュメントID構成、達成判定、現在の周の解決、
// 取消し可否。Firestore を使う処理（grantStamp 等）はルートテスト側で
// lib をモックして検証する。
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';
import type { EventExhibitor } from './event-coupon';
import {
  STAMP_GPS_RADIUS_M,
  buildStampRewardSnapshot,
  evaluateGpsStamp,
  evaluateStampCancel,
  grantStamp,
  isRoundCompleted,
  parseStampMethod,
  redeemFreeCoupon,
  resolveCurrentRound,
  stampIdFor,
} from './event-stamp';

describe('stampIdFor', () => {
  it('memberId・周・参加店ID から一意なIDを作る', () => {
    expect(stampIdFor('member-a', 1, 'shop-a')).toBe('member-a_1_shop-a');
    expect(stampIdFor('member-a', 2, 'shop-a')).not.toBe(
      stampIdFor('member-a', 1, 'shop-a'),
    );
    expect(stampIdFor('member-a', 1, 'shop-b')).not.toBe(
      stampIdFor('member-a', 1, 'shop-a'),
    );
  });
});

describe('isRoundCompleted', () => {
  it('達成個数に届いたら達成', () => {
    expect(isRoundCompleted(5, 5)).toBe(true);
    expect(isRoundCompleted(6, 5)).toBe(true);
    expect(isRoundCompleted(4, 5)).toBe(false);
    expect(isRoundCompleted(0, 5)).toBe(false);
    expect(isRoundCompleted(1, 1)).toBe(true);
  });
});

describe('resolveCurrentRound', () => {
  it('保存済みの stampRound があればそれが正', () => {
    expect(resolveCurrentRound(3, [1, 1, 2], 5)).toBe(3);
    expect(resolveCurrentRound(1, [], 5)).toBe(1);
  });
  it('保存が無くスタンプも無ければ 1周目', () => {
    expect(resolveCurrentRound(undefined, [], 5)).toBe(1);
    expect(resolveCurrentRound(null, [], 5)).toBe(1);
  });
  it('保存が無ければ実績の最大周を引き継ぐ（未達成ならその周）', () => {
    expect(resolveCurrentRound(undefined, [1, 1, 2], 5)).toBe(2);
  });
  it('最大周が達成済みなら次の周に進める', () => {
    expect(resolveCurrentRound(undefined, [2, 2, 2, 2, 2], 5)).toBe(3);
  });
  it('不正な保存値は実績からの復元に倒す', () => {
    expect(resolveCurrentRound(0, [1], 5)).toBe(1);
    expect(resolveCurrentRound('2', [2, 2], 5)).toBe(2);
  });
});

describe('evaluateStampCancel', () => {
  const today = '2026-11-14';
  const stamp = {
    exhibitorId: 'shop-a',
    round: 2,
    grantedDateJst: today,
  };
  it('自店・当日・現在の周なら取り消せる', () => {
    expect(evaluateStampCancel(stamp, 'shop-a', 2, today)).toEqual({
      allowed: true,
    });
  });
  it('他店のスタンプは取り消せない', () => {
    expect(evaluateStampCancel(stamp, 'shop-b', 2, today)).toEqual({
      allowed: false,
      reason: 'not-owner',
    });
  });
  it('過去の周のスタンプは取り消せない', () => {
    expect(evaluateStampCancel(stamp, 'shop-a', 3, today)).toEqual({
      allowed: false,
      reason: 'not-current-round',
    });
  });
  it('当日以外のスタンプは取り消せない', () => {
    expect(
      evaluateStampCancel(
        { ...stamp, grantedDateJst: '2026-11-13' },
        'shop-a',
        2,
        today,
      ),
    ).toEqual({ allowed: false, reason: 'not-today' });
  });
});

describe('buildStampRewardSnapshot（発行クーポンへの特典スナップショット）', () => {
  it('free-dish では従来どおりの種別で、内容は空（設定に残る文面は写さない）', () => {
    expect(
      buildStampRewardSnapshot({
        stampRewardType: 'free-dish',
        stampBenefitText: '前に特典で使っていた文面',
      }),
    ).toEqual({ rewardType: 'free-dish', benefitText: '' });
  });
  it('benefit では種類と内容をそのまま写す', () => {
    expect(
      buildStampRewardSnapshot({
        stampRewardType: 'benefit',
        stampBenefitText: '特製グッズをプレゼント',
      }),
    ).toEqual({ rewardType: 'benefit', benefitText: '特製グッズをプレゼント' });
  });
  it('発行後に設定を変えても、作成済みスナップショットは変わらない', () => {
    const issued = buildStampRewardSnapshot({
      stampRewardType: 'benefit',
      stampBenefitText: '発行時点の特典',
    });
    // 設定変更を模して別オブジェクトを作っても issued は不変
    buildStampRewardSnapshot({
      stampRewardType: 'free-dish',
      stampBenefitText: '',
    });
    expect(issued).toEqual({
      rewardType: 'benefit',
      benefitText: '発行時点の特典',
    });
  });
});

describe('協賛（広告専用）アカウントのガード', () => {
  // 種別ガードは Firestore やプロジェクト取得より前に効くため、
  // db は使われない（null を渡してそれを担保する）。
  const noDb = null as unknown as Firestore;
  const advertiser: EventExhibitor = {
    id: 'sponsor-1',
    name: '協賛企業',
    email: 'sponsor@example.com',
    address: null,
    hasAccessCode: true,
    lang: 'ja',
    kind: 'advertiser',
    source: 'admin',
    delistedAt: null,
    closedAt: null,
    stampCode: null,
    stampLocation: null,
  };

  it('協賛アカウントはスタンプを押せない（403）', async () => {
    const result = await grantStamp(noDb, {
      eventId: 'event-1',
      exhibitor: advertiser,
      memberId: 'member-a',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('協賛アカウントは無料クーポンを消し込めない（403）', async () => {
    const result = await redeemFreeCoupon(noDb, {
      eventId: 'event-1',
      exhibitor: advertiser,
      freeCouponId: 'fc-1',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });
});

describe('parseStampMethod（付与方式の読み取り）', () => {
  it('新しい方式はそのまま読む', () => {
    expect(parseStampMethod('placed-qr')).toBe('placed-qr');
    expect(parseStampMethod('gps')).toBe('gps');
    expect(parseStampMethod('shop-qr')).toBe('shop-qr');
  });
  it('未設定・未知の値は従来方式に倒す（後方互換）', () => {
    expect(parseStampMethod(undefined)).toBe('shop-qr');
    expect(parseStampMethod(null)).toBe('shop-qr');
    expect(parseStampMethod('unknown')).toBe('shop-qr');
  });
});

describe('evaluateGpsStamp（GPS スタンプの近接判定）', () => {
  const spot = { lat: 35.8544, lng: 139.3211 };

  it('判定半径は 150m（定数1箇所）', () => {
    expect(STAMP_GPS_RADIUS_M).toBe(150);
  });

  it('スポットの座標そのものなら付与可', () => {
    const result = evaluateGpsStamp(spot, spot);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.distanceMeters).toBe(0);
  });

  it('半径内（約100m）なら付与可', () => {
    const result = evaluateGpsStamp(
      { lat: spot.lat + 0.0009, lng: spot.lng },
      spot,
    );
    expect(result.ok).toBe(true);
  });

  it('半径外（約1km）は 403 で、近づく距離入りの文言', () => {
    const result = evaluateGpsStamp(
      { lat: spot.lat + 0.009, lng: spot.lng },
      spot,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain('近づいてください');
    }
  });

  it('座標が読めない入力は 400（位置情報が取得できていない）', () => {
    for (const bad of [null, undefined, {}, { lat: 'x', lng: 139 }, { lat: 91, lng: 139 }]) {
      const result = evaluateGpsStamp(bad, spot);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.status).toBe(400);
        expect(result.error).toContain('位置情報が取得できませんでした');
      }
    }
  });

  it('スポット座標が未設定なら 400（GPS 非対応）', () => {
    const result = evaluateGpsStamp(spot, null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain('GPSスタンプに対応していません');
    }
  });
});
