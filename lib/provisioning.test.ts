import { describe, expect, it } from 'vitest';
import {
  MAX_WORLD_NAME_LENGTH,
  buildProvisioningUpdate,
  decideProvisioning,
  validateCreateInput,
  type ProvisionOrganizerInput,
} from './provisioning';

describe('decideProvisioning', () => {
  it('レコードが無ければ create', () => {
    expect(decideProvisioning(null)).toBe('create');
  });
  it('ownerUid 未設定（途中状態）なら create で続きから', () => {
    expect(decideProvisioning({ ownerUid: null })).toBe('create');
  });
  it('ownerUid 設定済みなら update（枠の追随）', () => {
    expect(decideProvisioning({ ownerUid: 'uid-123' })).toBe('update');
  });
});

describe('buildProvisioningUpdate', () => {
  it('枠だけなら枠だけの patch になる', () => {
    expect(
      buildProvisioningUpdate({
        companyName: '',
        subscriberCap: 100000,
        couponCap: 200,
      }),
    ).toEqual({ subscriberCap: 100000, couponCap: 200 });
  });
  it('会社情報が送られれば含める', () => {
    expect(
      buildProvisioningUpdate({
        companyName: '株式会社テスト',
        address: '東京都千代田区1-1',
        phone: '03-0000-0000',
      }),
    ).toEqual({
      companyName: '株式会社テスト',
      address: '東京都千代田区1-1',
      phone: '03-0000-0000',
    });
  });
  it('何も送られなければ空（no-op）', () => {
    expect(buildProvisioningUpdate({ companyName: '' })).toEqual({});
  });
  it('空文字の会社名は含めない（誤って消さない）', () => {
    expect(buildProvisioningUpdate({ companyName: '  ' })).toEqual({});
  });

  describe('一時上げまわりの任意項目', () => {
    it('正しい日付と復帰枠は含める', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          tempSubscriberCapUntil: '2026-12-31',
          restoredSubscriberCap: 50000,
        }),
      ).toEqual({
        tempSubscriberCapUntil: '2026-12-31',
        restoredSubscriberCap: 50000,
      });
    });
    it('ISO日時形式でも日付として読めれば含める', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          tempSubscriberCapUntil: '2026-12-31T23:59:59+09:00',
        }),
      ).toEqual({ tempSubscriberCapUntil: '2026-12-31T23:59:59+09:00' });
    });
    it('null は明示的なクリアとして含める', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          tempSubscriberCapUntil: null,
          restoredSubscriberCap: null,
        }),
      ).toEqual({ tempSubscriberCapUntil: null, restoredSubscriberCap: null });
    });
    it('送られなければ含めない（既存値を変えない）', () => {
      expect(buildProvisioningUpdate({ companyName: '' })).toEqual({});
    });
    it('日付として読めない文字列は無視する（リクエスト全体は落とさない）', () => {
      expect(
        buildProvisioningUpdate({ companyName: '', tempSubscriberCapUntil: '来月末' }),
      ).toEqual({});
      expect(
        buildProvisioningUpdate({ companyName: '', tempSubscriberCapUntil: '2026-13-40' }),
      ).toEqual({});
    });
    it('復帰枠が数値でなければ・負なら無視する', () => {
      expect(
        buildProvisioningUpdate({ companyName: '', restoredSubscriberCap: Number.NaN }),
      ).toEqual({});
      expect(buildProvisioningUpdate({ companyName: '', restoredSubscriberCap: -1 })).toEqual(
        {},
      );
    });
  });

  describe('スタンプラリー固有の任意項目', () => {
    it('billingOptionEnabled は boolean が送られた場合だけ含める', () => {
      expect(buildProvisioningUpdate({ companyName: '', billingOptionEnabled: true })).toEqual({
        billingOptionEnabled: true,
      });
      expect(buildProvisioningUpdate({ companyName: '', billingOptionEnabled: false })).toEqual({
        billingOptionEnabled: false,
      });
    });
    it('billingOptionEnabled が boolean でなければ無視する', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          billingOptionEnabled: 'true' as unknown as boolean,
        }),
      ).toEqual({});
      expect(
        buildProvisioningUpdate({
          companyName: '',
          billingOptionEnabled: 1 as unknown as boolean,
        }),
      ).toEqual({});
    });
    it('billingOptionEnabled が送られなければ含めない（既存値を変えない）', () => {
      expect(buildProvisioningUpdate({ companyName: '' })).toEqual({});
    });
    it('smsAuthEnabled は boolean が送られた場合だけ含める', () => {
      expect(buildProvisioningUpdate({ companyName: '', smsAuthEnabled: true })).toEqual({
        smsAuthEnabled: true,
      });
      expect(buildProvisioningUpdate({ companyName: '', smsAuthEnabled: false })).toEqual({
        smsAuthEnabled: false,
      });
    });
    it('smsAuthEnabled が boolean でなければ無視し、送られなければ含めない', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          smsAuthEnabled: 'true' as unknown as boolean,
        }),
      ).toEqual({});
      expect(buildProvisioningUpdate({ companyName: '' })).toEqual({});
    });
    it('adsOptionEnabled は boolean が送られた場合だけ含める', () => {
      expect(buildProvisioningUpdate({ companyName: '', adsOptionEnabled: true })).toEqual({
        adsOptionEnabled: true,
      });
      expect(buildProvisioningUpdate({ companyName: '', adsOptionEnabled: false })).toEqual({
        adsOptionEnabled: false,
      });
    });
    it('adsOptionEnabled が boolean でなければ無視する', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          adsOptionEnabled: 'true' as unknown as boolean,
        }),
      ).toEqual({});
      expect(
        buildProvisioningUpdate({
          companyName: '',
          adsOptionEnabled: 1 as unknown as boolean,
        }),
      ).toEqual({});
    });
    it('adsOptionEnabled が送られなければ含めない（既存値を変えない）', () => {
      expect(buildProvisioningUpdate({ companyName: '' })).toEqual({});
    });
    it('portalEnabled は boolean が送られた場合だけ含め、それ以外は無視する', () => {
      expect(buildProvisioningUpdate({ companyName: '', portalEnabled: true })).toEqual({
        portalEnabled: true,
      });
      expect(buildProvisioningUpdate({ companyName: '', portalEnabled: false })).toEqual({
        portalEnabled: false,
      });
      expect(
        buildProvisioningUpdate({
          companyName: '',
          portalEnabled: 'true' as unknown as boolean,
        }),
      ).toEqual({});
      expect(buildProvisioningUpdate({ companyName: '' })).toEqual({});
    });
    it('worldName は前後の空白を除いて含める', () => {
      expect(buildProvisioningUpdate({ companyName: '', worldName: ' 飯能カレー ' })).toEqual({
        worldName: '飯能カレー',
      });
    });
    it('worldName が空文字・空白だけなら含めない（誤って消さない）', () => {
      expect(buildProvisioningUpdate({ companyName: '', worldName: '' })).toEqual({});
      expect(buildProvisioningUpdate({ companyName: '', worldName: '   ' })).toEqual({});
    });
    it('worldName が上限を超えたら無視する（リクエスト全体は落とさない）', () => {
      expect(
        buildProvisioningUpdate({
          companyName: '',
          worldName: 'あ'.repeat(MAX_WORLD_NAME_LENGTH + 1),
        }),
      ).toEqual({});
      expect(
        buildProvisioningUpdate({
          companyName: '',
          worldName: 'あ'.repeat(MAX_WORLD_NAME_LENGTH),
        }),
      ).toEqual({ worldName: 'あ'.repeat(MAX_WORLD_NAME_LENGTH) });
    });
    it('worldName が送られなければ含めない（既存値を変えない）', () => {
      expect(buildProvisioningUpdate({ companyName: '', worldName: undefined })).toEqual({});
    });
  });
});

const createInput = (overrides: Partial<ProvisionOrganizerInput> = {}): ProvisionOrganizerInput => ({
  contractId: 'contract-1',
  email: 'owner@example.com',
  password: 'initial-pass',
  companyName: '株式会社テスト',
  startDate: '2026-11-08',
  ...overrides,
});

describe('validateCreateInput', () => {
  it('揃っていれば null', () => {
    expect(validateCreateInput(createInput())).toBeNull();
  });
  it('email が不正ならエラー', () => {
    expect(validateCreateInput(createInput({ email: '' }))).toBe('有効な email が必要です');
    expect(validateCreateInput(createInput({ email: 'no-at-mark' }))).toBe(
      '有効な email が必要です',
    );
  });
  it('パスワードが無い・短いとエラー（新規作成では必須）', () => {
    expect(validateCreateInput(createInput({ password: undefined }))).toBe(
      'password は6文字以上が必要です',
    );
    expect(validateCreateInput(createInput({ password: '12345' }))).toBe(
      'password は6文字以上が必要です',
    );
  });
  it('会社名が空ならエラー', () => {
    expect(validateCreateInput(createInput({ companyName: '' }))).toBe(
      'companyName が必要です',
    );
  });
  it('startDate の形式が違えばエラー', () => {
    expect(validateCreateInput(createInput({ startDate: '2026/11/08' }))).toBe(
      'startDate は YYYY-MM-DD 形式で指定してください',
    );
  });
});
