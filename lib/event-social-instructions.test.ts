// lib/event-social-instructions.test.ts
// Muse 向けセットアップ案内文の組み立てを検証する。
// 案内文は主催者が自分の Muse にそのまま渡すものなので、
// キュー確認 URL・連携キーの渡し方・朝昼夜の定期確認・完了 API が
// 欠けていないことを担保する。
import { describe, expect, it } from 'vitest';
import {
  buildSocialQueueInstructions,
  socialQueueEndpoints,
} from './event-social-instructions';

describe('socialQueueEndpoints', () => {
  it('origin と eventId から API の URL 群を作る（末尾スラッシュは正規化）', () => {
    const endpoints = socialQueueEndpoints('https://example.com/', 'event-1');
    expect(endpoints.queueUrl).toBe(
      'https://example.com/api/events/event-1/social-queue',
    );
    expect(endpoints.postedUrlTemplate).toBe(
      'https://example.com/api/events/event-1/social-queue/{postId}/posted',
    );
  });
});

describe('buildSocialQueueInstructions', () => {
  const endpoints = socialQueueEndpoints('https://example.com', 'event-1');

  it('キーがある場合は案内文にキーが入る', () => {
    const text = buildSocialQueueInstructions({ endpoints, key: 'SECRET_KEY' });
    expect(text).toContain('X-Queue-Key: SECRET_KEY');
  });

  it('確認 URL・完了 URL・朝昼夜の定期確認・完了報告の指示を含む', () => {
    const text = buildSocialQueueInstructions({ endpoints, key: 'K' });
    expect(text).toContain('https://example.com/api/events/event-1/social-queue');
    expect(text).toContain(
      'https://example.com/api/events/event-1/social-queue/{postId}/posted',
    );
    expect(text).toContain('朝・昼・夜');
    expect(text).toContain('Instagram');
    expect(text).toContain('postedUrl');
  });

  it('キーが無い場合はプレースホルダで示す', () => {
    const text = buildSocialQueueInstructions({ endpoints, key: null });
    expect(text).toContain('＜管理画面で発行した連携キー＞');
    expect(text).not.toContain('X-Queue-Key: SECRET');
  });
});
