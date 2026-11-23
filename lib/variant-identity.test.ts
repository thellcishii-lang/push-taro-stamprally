// lib/variant-identity.test.ts
// バリアント識別ガード。
//
// バリアントは互いのフォークで作るため、コピー元の公開 URL や
// プロジェクト ID がコードに残ると、来場者が別バリアントのアプリへ
// 飛んでしまう（初詣で来場者 URL が EVENT のまま残り、実際に発生した）。
// このテストは「自分の識別子が正しく組み立っているか」と「他バリアントの
// 識別子がソースに紛れ込んでいないか」を常時検査し、残りを公開前に止める。

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN } from './app-origin';
import { DEFAULT_STORAGE_BUCKET } from './storage-bucket';
import {
  APP_HOSTING_ORIGIN,
  DEFAULT_STORAGE_BUCKET_NAME,
  VARIANT_BACKEND_ID,
  VARIANT_PROJECT_ID,
} from './variant-identity';

/**
 * 他バリアントの識別子（プロジェクト ID と、その hosted.app
 * サブドメイン表記）。プロジェクト ID はサブドメインにも含まれるが、
 * 事故パターンを明示するため両方を並べる。
 */
const FORBIDDEN_TOKENS = [
  'push-taro-event', // EVENT のプロジェクト ID
  'push-taro-event--push-taro-event', // EVENT の hosted.app サブドメイン
  'push-taro-hatsumode', // 初詣のプロジェクト ID
  'push-taro-hatsumode--', // 初詣の hosted.app サブドメイン
  'push-taro-8b503', // 本家のプロジェクト ID
  'push-taro-machiokoshi', // 町おこし（このバリアントのコピー元）のプロジェクト ID
  'machiokoshi--push-taro-machiokoshi', // 町おこしの hosted.app サブドメイン
  'push-taro-fes', // FES のプロジェクト ID
  'push-taro-fes--', // FES の hosted.app サブドメイン
];

describe('バリアント識別', () => {
  it('プロジェクト ID とバックエンド ID から公開 origin が組み立つ', () => {
    expect(VARIANT_PROJECT_ID).toBe('push-taro-stamprally');
    // バックエンド ID はプロジェクト ID と別（'machiokoshi'）。
    expect(VARIANT_BACKEND_ID).toBe('push-taro-stamprally');
    expect(APP_HOSTING_ORIGIN).toBe(
      'https://push-taro-stamprally--push-taro-stamprally.asia-east1.hosted.app',
    );
  });

  it('APP_ORIGIN は自バリアントの hosted.app で、他バリアントの ID を含まない', () => {
    expect(APP_ORIGIN).toBe(APP_HOSTING_ORIGIN);
    const host = new URL(APP_ORIGIN).host;
    expect(host.endsWith('--push-taro-stamprally.asia-east1.hosted.app')).toBe(
      true,
    );
    for (const token of FORBIDDEN_TOKENS) {
      expect(APP_ORIGIN).not.toContain(token);
    }
  });

  it('既定ストレージバケットは自プロジェクトのもの', () => {
    expect(DEFAULT_STORAGE_BUCKET).toBe(
      'push-taro-stamprally.firebasestorage.app',
    );
    expect(DEFAULT_STORAGE_BUCKET).toBe(DEFAULT_STORAGE_BUCKET_NAME);
  });

  it('lib/ app/ components/ のソースに他バリアントの識別子が残っていない', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    // 識別子の定義ファイルは検査対象から外す（自バリアントの値の出どころ）。
    const definitionFiles = new Set([
      'lib/variant-identity.ts',
      'lib/app-origin.ts',
      'lib/storage-bucket.ts',
    ]);
    // 正当な言及が必要になったファイルは、理由をコメントしてここへ足す。
    const allowlist = new Set<string>([
      // 例: 'lib/example.ts', // ○○の理由で EVENT の ID に言及する
    ]);
    const offenders: string[] = [];
    for (const dir of ['lib', 'app', 'components']) {
      for (const file of walkSourceFiles(path.join(root, dir))) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        if (/\.test\.tsx?$/.test(rel)) continue;
        if (definitionFiles.has(rel) || allowlist.has(rel)) continue;
        const text = readFileSync(file, 'utf8');
        for (const token of FORBIDDEN_TOKENS) {
          if (text.includes(token)) offenders.push(`${rel}: ${token}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkSourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}
