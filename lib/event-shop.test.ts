// lib/event-shop.test.ts
// 店舗プロフィールの純粋関数: 読み取り整形（防御的）と保存検証、
// 表示名フォールバックを検証する。あわせて店舗リンク（最大3件）と
// 座標（保存時のジオコーディング）の判断・保存フローも検証する。
import type { Firestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';
import {
  effectiveShopLinks,
  emptyShopProfile,
  isShopPubliclyListed,
  listBillingSuspendedExhibitorIds,
  listPublicShops,
  parseShopProfile,
  resolveShopLocation,
  resolveTopFeatured,
  setShopDelistedAt,
  shopCoverPhotoStoragePath,
  shopFreeDishPhotoStoragePath,
  shopMainVisualUrl,
  shopLoginRewardPhotoStoragePath,
  shopPhotoStoragePath,
  toPublicShop,
  updateShopProfile,
  validateShopProfileInput,
  type ShopProfile,
} from './event-shop';

describe('parseShopProfile', () => {
  it('未設定（undefined / null / 非オブジェクト）は空プロフィールで掲載あり', () => {
    expect(parseShopProfile(undefined)).toEqual(emptyShopProfile());
    expect(parseShopProfile(null)).toEqual(emptyShopProfile());
    expect(parseShopProfile('x')).toEqual(emptyShopProfile());
    expect(parseShopProfile(undefined).published).toBe(true);
  });

  it('保存済みの値を読み、published=false を保持する', () => {
    const profile = parseShopProfile({
      displayName: 'カレー堂',
      address: '埼玉県飯能市…',
      photoUrls: ['https://example.com/a.jpg'],
      instagramUrl: 'https://instagram.com/shop',
      published: false,
    });
    expect(profile.displayName).toBe('カレー堂');
    expect(profile.address).toBe('埼玉県飯能市…');
    expect(profile.photoUrls).toEqual(['https://example.com/a.jpg']);
    expect(profile.instagramUrl).toBe('https://instagram.com/shop');
    expect(profile.published).toBe(false);
  });

  it('写真は https のものだけ最大3枚、Instagram は https 以外を落とす', () => {
    const profile = parseShopProfile({
      photoUrls: [
        'https://example.com/1.jpg',
        'http://example.com/2.jpg',
        123,
        'https://example.com/3.jpg',
        'https://example.com/4.jpg',
        'https://example.com/5.jpg',
      ],
      instagramUrl: 'http://instagram.com/shop',
    });
    expect(profile.photoUrls).toEqual([
      'https://example.com/1.jpg',
      'https://example.com/3.jpg',
      'https://example.com/4.jpg',
    ]);
    expect(profile.instagramUrl).toBe('');
  });

  it('文字列でない項目は空に倒し、長すぎる文字列は上限で切る', () => {
    const profile = parseShopProfile({
      displayName: 42,
      description: 'あ'.repeat(1500),
    });
    expect(profile.displayName).toBe('');
    expect(profile.description).toHaveLength(1000);
  });
});

describe('toPublicShop', () => {
  it('表示名が未設定なら登録名に倒す', () => {
    const shop = toPublicShop({ id: 'shop-a', name: '登録名A' }, undefined);
    expect(shop.exhibitorId).toBe('shop-a');
    expect(shop.name).toBe('登録名A');
    expect(shop.profile.displayName).toBe('登録名A');
  });

  it('表示名が設定されていればそれを使う', () => {
    const shop = toPublicShop(
      { id: 'shop-a', name: '登録名A' },
      { displayName: '表示名A' },
    );
    expect(shop.profile.displayName).toBe('表示名A');
    expect(shop.name).toBe('登録名A');
  });
});

describe('validateShopProfileInput', () => {
  it('正常な入力を正規化する（前後空白を落とす）', () => {
    const result = validateShopProfileInput({
      displayName: ' カレー堂 ',
      address: '埼玉県飯能市…',
      photoUrls: ['https://example.com/a.jpg'],
      instagramUrl: ' https://instagram.com/shop ',
      published: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.displayName).toBe('カレー堂');
      expect(result.value.instagramUrl).toBe('https://instagram.com/shop');
      expect(result.value.published).toBe(false);
    }
  });

  it('空の入力は空プロフィール（掲載あり）として通る', () => {
    const result = validateShopProfileInput({});
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(emptyShopProfile());
  });

  it('文字数上限を超えたらエラー', () => {
    const result = validateShopProfileInput({
      displayName: 'あ'.repeat(61),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('60文字以内');
  });

  it('写真が4枚以上ならエラー、https でなければエラー', () => {
    const four = validateShopProfileInput({
      photoUrls: [
        'https://example.com/1.jpg',
        'https://example.com/2.jpg',
        'https://example.com/3.jpg',
        'https://example.com/4.jpg',
      ],
    });
    expect(four.ok).toBe(false);
    const http = validateShopProfileInput({
      photoUrls: ['http://example.com/1.jpg'],
    });
    expect(http.ok).toBe(false);
  });

  it('Instagram URL が https でなければエラー', () => {
    const result = validateShopProfileInput({
      instagramUrl: 'instagram.com/shop',
    });
    expect(result.ok).toBe(false);
  });

  it('published が真偽値でなければエラー、非オブジェクトはエラー', () => {
    expect(validateShopProfileInput({ published: 'yes' }).ok).toBe(false);
    expect(validateShopProfileInput(null).ok).toBe(false);
    expect(validateShopProfileInput('x').ok).toBe(false);
  });
});

describe('お店のトップ画像（coverImageUrl）', () => {
  it('読み取り: https のトップ画像を保持し、無い旧プロフィールは null', () => {
    const withCover = parseShopProfile({
      coverImageUrl: 'https://example.com/cover.jpg',
    });
    expect(withCover.coverImageUrl).toBe('https://example.com/cover.jpg');
    expect(parseShopProfile({}).coverImageUrl).toBeNull();
    expect(parseShopProfile(undefined).coverImageUrl).toBeNull();
  });

  it('読み取り: https でない・文字列でないトップ画像は null に倒す', () => {
    expect(
      parseShopProfile({ coverImageUrl: 'http://example.com/c.jpg' })
        .coverImageUrl,
    ).toBeNull();
    expect(parseShopProfile({ coverImageUrl: 42 }).coverImageUrl).toBeNull();
    expect(parseShopProfile({ coverImageUrl: null }).coverImageUrl).toBeNull();
  });

  it('公開用にもトップ画像がそのまま載る', () => {
    const shop = toPublicShop(
      { id: 'shop-a', name: '登録名A' },
      { coverImageUrl: 'https://example.com/cover.jpg' },
    );
    expect(shop.profile.coverImageUrl).toBe('https://example.com/cover.jpg');
  });

  it('保存検証: https のトップ画像を通し、前後空白を落とす', () => {
    const result = validateShopProfileInput({
      coverImageUrl: ' https://example.com/cover.jpg ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.coverImageUrl).toBe('https://example.com/cover.jpg');
    }
  });

  it('保存検証: 未指定・null・空文字は未設定（null）として通る', () => {
    for (const input of [{}, { coverImageUrl: null }, { coverImageUrl: '  ' }]) {
      const result = validateShopProfileInput(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.coverImageUrl).toBeNull();
    }
  });

  it('保存検証: https でない・文字列でないトップ画像はエラー', () => {
    expect(
      validateShopProfileInput({ coverImageUrl: 'http://example.com/c.jpg' })
        .ok,
    ).toBe(false);
    expect(validateShopProfileInput({ coverImageUrl: 42 }).ok).toBe(false);
  });

  it('保存先パスは同じディレクトリに cover- 接頭辞で作る', () => {
    expect(shopCoverPhotoStoragePath('ev1', 'shop-a', 'x.jpg')).toBe(
      'events/ev1/shop-photos/shop-a/cover-x.jpg',
    );
  });
});

describe('shopMainVisualUrl（メイン画像のフォールバック）', () => {
  it('トップ画像があればそれを使う', () => {
    expect(
      shopMainVisualUrl({
        coverImageUrl: 'https://example.com/cover.jpg',
        photoUrls: ['https://example.com/food.jpg'],
      }),
    ).toBe('https://example.com/cover.jpg');
  });

  it('トップ画像が無ければ料理の写真の1枚目で代用する', () => {
    expect(
      shopMainVisualUrl({
        coverImageUrl: null,
        photoUrls: ['https://example.com/food.jpg', 'https://example.com/f2.jpg'],
      }),
    ).toBe('https://example.com/food.jpg');
  });

  it('どちらも無ければ null', () => {
    expect(shopMainVisualUrl({ coverImageUrl: null, photoUrls: [] })).toBeNull();
  });
});

describe('shopPhotoStoragePath', () => {
  it('events/{eventId}/shop-photos/{exhibitorId}/{fileName} を作る', () => {
    expect(shopPhotoStoragePath('ev1', 'shop-a', 'x.jpg')).toBe(
      'events/ev1/shop-photos/shop-a/x.jpg',
    );
  });
  it('無料の一品の写真は同じディレクトリに free-dish- 接頭辞で作る', () => {
    expect(shopFreeDishPhotoStoragePath('ev1', 'shop-a', 'x.jpg')).toBe(
      'events/ev1/shop-photos/shop-a/free-dish-x.jpg',
    );
  });
});

describe('店舗リンクの読み取り（parseShopProfile）', () => {
  it('保存済みリンクを読み、座標も読む', () => {
    const profile = parseShopProfile({
      links: [
        { label: '公式サイト', url: 'https://example.com/' },
        { label: 'Instagram', url: 'https://instagram.com/shop' },
      ],
      location: { lat: 35.85, lng: 139.32 },
    });
    expect(profile.links).toEqual([
      { label: '公式サイト', url: 'https://example.com/' },
      { label: 'Instagram', url: 'https://instagram.com/shop' },
    ]);
    expect(profile.location).toEqual({ lat: 35.85, lng: 139.32 });
  });

  it('リンク項目が無い旧ドキュメントは空配列・座標なし', () => {
    const profile = parseShopProfile({ displayName: '旧店舗' });
    expect(profile.links).toEqual([]);
    expect(profile.location).toBeNull();
  });

  it('不正なリンク行は捨て、最大3件に切る', () => {
    const profile = parseShopProfile({
      links: [
        { label: 'OK', url: 'https://example.com/1' },
        { label: 'httpは不可', url: 'http://example.com/2' },
        { label: '', url: 'https://example.com/3' },
        'garbage',
        { label: 'OK2', url: 'https://example.com/4' },
        { label: 'OK3', url: 'https://example.com/5' },
        { label: 'OK4', url: 'https://example.com/6' },
      ],
    });
    expect(profile.links).toEqual([
      { label: 'OK', url: 'https://example.com/1' },
      { label: 'OK2', url: 'https://example.com/4' },
      { label: 'OK3', url: 'https://example.com/5' },
    ]);
  });

  it('座標が数値でない・範囲外なら null に倒す', () => {
    expect(parseShopProfile({ location: { lat: '35.8', lng: 139.3 } }).location).toBeNull();
    expect(parseShopProfile({ location: { lat: 91, lng: 139.3 } }).location).toBeNull();
    expect(parseShopProfile({ location: 'x' }).location).toBeNull();
  });
});

describe('店舗リンクの保存検証（validateShopProfileInput）', () => {
  it('リンク0件・3件は通り、前後空白は落とす', () => {
    const none = validateShopProfileInput({ links: [] });
    expect(none.ok).toBe(true);
    if (none.ok) expect(none.value.links).toEqual([]);

    const three = validateShopProfileInput({
      links: [
        { label: ' 公式サイト ', url: ' https://example.com/ ' },
        { label: 'Instagram', url: 'https://instagram.com/shop' },
        { label: 'X', url: 'https://x.com/shop' },
      ],
    });
    expect(three.ok).toBe(true);
    if (three.ok) {
      expect(three.value.links).toEqual([
        { label: '公式サイト', url: 'https://example.com/' },
        { label: 'Instagram', url: 'https://instagram.com/shop' },
        { label: 'X', url: 'https://x.com/shop' },
      ]);
    }
  });

  it('リンク4件はエラー', () => {
    const result = validateShopProfileInput({
      links: [1, 2, 3, 4].map((i) => ({
        label: `リンク${i}`,
        url: `https://example.com/${i}`,
      })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('3件まで');
  });

  it('https でないURLはエラー', () => {
    const result = validateShopProfileInput({
      links: [{ label: 'サイト', url: 'http://example.com/' }],
    });
    expect(result.ok).toBe(false);
  });

  it('表示名31文字・URL501文字はエラー', () => {
    const longLabel = validateShopProfileInput({
      links: [{ label: 'あ'.repeat(31), url: 'https://example.com/' }],
    });
    expect(longLabel.ok).toBe(false);
    if (!longLabel.ok) expect(longLabel.error).toContain('30文字以内');

    const longUrl = validateShopProfileInput({
      links: [
        { label: 'サイト', url: `https://example.com/${'a'.repeat(500)}` },
      ],
    });
    expect(longUrl.ok).toBe(false);
    if (!longUrl.ok) expect(longUrl.error).toContain('500文字以内');
  });

  it('空行は捨て、片方だけの行はエラー', () => {
    const dropped = validateShopProfileInput({
      links: [
        { label: '', url: '' },
        { label: '公式サイト', url: 'https://example.com/' },
      ],
    });
    expect(dropped.ok).toBe(true);
    if (dropped.ok) expect(dropped.value.links).toHaveLength(1);

    expect(
      validateShopProfileInput({ links: [{ label: '名前だけ', url: '' }] }).ok,
    ).toBe(false);
    expect(
      validateShopProfileInput({
        links: [{ label: '', url: 'https://example.com/' }],
      }).ok,
    ).toBe(false);
  });

  it('クライアントが送った座標は無視される（検証結果は常に null）', () => {
    const result = validateShopProfileInput({
      address: '埼玉県飯能市',
      location: { lat: 35.85, lng: 139.32 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.location).toBeNull();
  });
});

describe('effectiveShopLinks（Instagram の暗黙リンク）', () => {
  it('リンクが空で Instagram だけあれば、それが1件目になる', () => {
    const profile = parseShopProfile({
      instagramUrl: 'https://instagram.com/shop',
    });
    expect(effectiveShopLinks(profile)).toEqual([
      { label: 'Instagram', url: 'https://instagram.com/shop' },
    ]);
  });

  it('リンクが設定されていれば Instagram は混ざらない', () => {
    const profile = parseShopProfile({
      instagramUrl: 'https://instagram.com/shop',
      links: [{ label: '公式サイト', url: 'https://example.com/' }],
    });
    expect(effectiveShopLinks(profile)).toEqual([
      { label: '公式サイト', url: 'https://example.com/' },
    ]);
  });

  it('どちらも無ければ空配列', () => {
    expect(effectiveShopLinks(parseShopProfile({}))).toEqual([]);
  });

  it('toPublicShop では profile.links が実効リンクになる', () => {
    const shop = toPublicShop(
      { id: 'shop-a', name: '店A' },
      { instagramUrl: 'https://instagram.com/shop' },
    );
    expect(shop.profile.links).toEqual([
      { label: 'Instagram', url: 'https://instagram.com/shop' },
    ]);
    expect(shop.profile.location).toBeNull();
  });
});

describe('無料の一品（freeDish）の読み取り（parseShopProfile / toPublicShop）', () => {
  it('旧ドキュメント（項目なし）は null（未登録）', () => {
    expect(parseShopProfile({}).freeDish).toBeNull();
    expect(parseShopProfile(undefined).freeDish).toBeNull();
    const shop = toPublicShop({ id: 'shop-a', name: '店A' }, {});
    expect(shop.profile.freeDish).toBeNull();
  });

  it('保存済みの値を読み、公開用にもそのまま出る', () => {
    const raw = {
      freeDish: {
        name: ' 飯能カレー ',
        description: '地元野菜たっぷり',
        photoUrl: 'https://example.com/dish.jpg',
      },
    };
    const expected = {
      name: '飯能カレー',
      description: '地元野菜たっぷり',
      photoUrl: 'https://example.com/dish.jpg',
    };
    expect(parseShopProfile(raw).freeDish).toEqual(expected);
    const shop = toPublicShop({ id: 'shop-a', name: '店A' }, raw);
    expect(shop.profile.freeDish).toEqual(expected);
  });

  it('名前が無ければ未登録に倒し、写真は https 以外を落とす', () => {
    expect(
      parseShopProfile({ freeDish: { description: '説明だけ' } }).freeDish,
    ).toBeNull();
    expect(
      parseShopProfile({ freeDish: { name: '  ' } }).freeDish,
    ).toBeNull();
    expect(
      parseShopProfile({
        freeDish: { name: 'カレー', photoUrl: 'http://example.com/x.jpg' },
      }).freeDish,
    ).toEqual({ name: 'カレー', description: '', photoUrl: null });
    expect(parseShopProfile({ freeDish: 'x' }).freeDish).toBeNull();
  });

  it('長すぎる名前・説明は上限で切る', () => {
    const profile = parseShopProfile({
      freeDish: {
        name: 'あ'.repeat(80),
        description: 'い'.repeat(300),
      },
    });
    expect(profile.freeDish?.name).toHaveLength(50);
    expect(profile.freeDish?.description).toHaveLength(200);
  });
});

describe('無料の一品（freeDish）の保存検証（validateShopProfileInput）', () => {
  it('未指定・全項目が空なら未登録（null）', () => {
    const none = validateShopProfileInput({});
    expect(none.ok && none.value.freeDish).toBeNull();
    const empty = validateShopProfileInput({
      freeDish: { name: ' ', description: '', photoUrl: null },
    });
    expect(empty.ok && empty.value.freeDish).toBeNull();
    const explicitNull = validateShopProfileInput({ freeDish: null });
    expect(explicitNull.ok && explicitNull.value.freeDish).toBeNull();
  });

  it('正常な入力を正規化する（前後空白を落とす）', () => {
    const result = validateShopProfileInput({
      freeDish: {
        name: ' 飯能カレー ',
        description: ' 地元野菜たっぷり ',
        photoUrl: 'https://example.com/dish.jpg',
      },
    });
    expect(result.ok && result.value.freeDish).toEqual({
      name: '飯能カレー',
      description: '地元野菜たっぷり',
      photoUrl: 'https://example.com/dish.jpg',
    });
  });

  it('名前なしで説明や写真だけあるものはエラー', () => {
    expect(
      validateShopProfileInput({ freeDish: { description: '説明だけ' } }).ok,
    ).toBe(false);
    expect(
      validateShopProfileInput({
        freeDish: { photoUrl: 'https://example.com/dish.jpg' },
      }).ok,
    ).toBe(false);
  });

  it('名前51文字・説明201文字・http の写真はエラー', () => {
    expect(
      validateShopProfileInput({ freeDish: { name: 'あ'.repeat(51) } }).ok,
    ).toBe(false);
    expect(
      validateShopProfileInput({
        freeDish: { name: 'カレー', description: 'い'.repeat(201) },
      }).ok,
    ).toBe(false);
    expect(
      validateShopProfileInput({
        freeDish: { name: 'カレー', photoUrl: 'http://example.com/x.jpg' },
      }).ok,
    ).toBe(false);
    expect(validateShopProfileInput({ freeDish: 'x' }).ok).toBe(false);
  });

  it('名前50文字・説明200文字は上限ちょうどで通る', () => {
    const result = validateShopProfileInput({
      freeDish: { name: 'あ'.repeat(50), description: 'い'.repeat(200) },
    });
    expect(result.ok).toBe(true);
  });
});

function profileWith(partial: Partial<ShopProfile>): ShopProfile {
  return { ...emptyShopProfile(), ...partial };
}

describe('resolveShopLocation', () => {
  it('住所が空なら座標なし（変換は呼ばない）', async () => {
    const geocode = vi.fn(async () => ({ lat: 35.85, lng: 139.32 }));
    await expect(
      resolveShopLocation(
        profileWith({ address: '埼玉県飯能市' }),
        profileWith({ address: '' }),
        geocode,
      ),
    ).resolves.toBeNull();
    expect(geocode).not.toHaveBeenCalled();
  });

  it('住所が同じで座標があれば使い回す（変換は呼ばない）', async () => {
    const geocode = vi.fn(async () => ({ lat: 1, lng: 2 }));
    const previous = profileWith({
      address: '埼玉県飯能市',
      location: { lat: 35.85, lng: 139.32 },
    });
    await expect(
      resolveShopLocation(previous, profileWith({ address: '埼玉県飯能市' }), geocode),
    ).resolves.toEqual({ lat: 35.85, lng: 139.32 });
    expect(geocode).not.toHaveBeenCalled();
  });

  it('住所が変われば変換し、座標がまだ無い場合も変換する', async () => {
    const geocode = vi.fn(async () => ({ lat: 35.85, lng: 139.32 }));
    const previous = profileWith({
      address: '埼玉県飯能市',
      location: { lat: 35.0, lng: 139.0 },
    });
    await expect(
      resolveShopLocation(previous, profileWith({ address: '埼玉県狭山市' }), geocode),
    ).resolves.toEqual({ lat: 35.85, lng: 139.32 });
    await expect(
      resolveShopLocation(
        profileWith({ address: '埼玉県飯能市' }),
        profileWith({ address: '埼玉県飯能市' }),
        geocode,
      ),
    ).resolves.toEqual({ lat: 35.85, lng: 139.32 });
    expect(geocode).toHaveBeenCalledTimes(2);
  });

  it('変換できなければ null、変換が例外でも null', async () => {
    await expect(
      resolveShopLocation(
        profileWith({}),
        profileWith({ address: '住所' }),
        async () => null,
      ),
    ).resolves.toBeNull();
    await expect(
      resolveShopLocation(
        profileWith({}),
        profileWith({ address: '住所' }),
        async () => {
          throw new Error('boom');
        },
      ),
    ).resolves.toBeNull();
  });
});

// updateShopProfile / listPublicShops 用の最小フェイク Firestore。
// exhibitors コレクションの doc 取得・更新と一覧取得だけを再現する。
// eventData を渡すと events ドキュメント自体の get も再現する
// （listPublicShops がトップ掲載の料金を読むため）。
function fakeShopDb(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
  eventData?: Record<string, unknown>,
) {
  const updates: Array<{ id: string; value: { profile: ShopProfile } }> = [];
  const collection = {
    doc: (id: string) => {
      const found = docs.find((d) => d.id === id);
      return {
        get: async () => ({
          exists: found !== undefined,
          data: () => found?.data,
        }),
        update: async (value: { profile: ShopProfile }) => {
          updates.push({ id, value });
        },
      };
    },
    get: async () => ({
      docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
    }),
  };
  const db = {
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: eventData !== undefined,
          data: () => eventData,
        }),
        collection: () => collection,
      }),
    }),
  };
  return { db: db as unknown as Firestore, updates };
}

describe('updateShopProfile（保存フローと座標）', () => {
  it('住所から座標を求めて一緒に保存する', async () => {
    const { db, updates } = fakeShopDb([
      { id: 'shop-a', data: { name: '店A', profile: {} } },
    ]);
    const input = validateShopProfileInput({ address: '埼玉県飯能市' });
    if (!input.ok) throw new Error('input should be valid');
    const result = await updateShopProfile(db, 'ev1', 'shop-a', input.value, async () => ({
      lat: 35.85,
      lng: 139.32,
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.profile.location).toEqual({ lat: 35.85, lng: 139.32 });
    }
    expect(updates).toHaveLength(1);
    expect(updates[0].value.profile.location).toEqual({
      lat: 35.85,
      lng: 139.32,
    });
  });

  it('ジオコーディングが例外を投げても保存は成功する（座標なし）', async () => {
    const { db, updates } = fakeShopDb([
      { id: 'shop-a', data: { name: '店A', profile: {} } },
    ]);
    const input = validateShopProfileInput({ address: '埼玉県飯能市' });
    if (!input.ok) throw new Error('input should be valid');
    const result = await updateShopProfile(db, 'ev1', 'shop-a', input.value, async () => {
      throw new Error('geocoder down');
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.location).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it('店が無ければ 404', async () => {
    const { db } = fakeShopDb([]);
    const input = validateShopProfileInput({});
    if (!input.ok) throw new Error('input should be valid');
    const result = await updateShopProfile(db, 'ev1', 'missing', input.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });
});

describe('listPublicShops（公開APIの形・旧ドキュメント）', () => {
  it('リンク・座標の無い旧ドキュメントは links [] / location null で出る', async () => {
    const { db } = fakeShopDb([
      {
        id: 'shop-a',
        data: {
          name: '店A',
          profile: { displayName: '店A', address: '埼玉県飯能市' },
        },
      },
    ]);
    const shops = await listPublicShops(db, 'ev1');
    expect(shops).toHaveLength(1);
    expect(shops[0].profile.links).toEqual([]);
    expect(shops[0].profile.location).toBeNull();
  });

  it('Instagram だけの旧ドキュメントはリンクに Instagram が入る', async () => {
    const { db } = fakeShopDb([
      {
        id: 'shop-a',
        data: {
          name: '店A',
          profile: {
            displayName: '店A',
            instagramUrl: 'https://instagram.com/shop',
            location: { lat: 35.85, lng: 139.32 },
          },
        },
      },
    ]);
    const shops = await listPublicShops(db, 'ev1');
    expect(shops[0].profile.links).toEqual([
      { label: 'Instagram', url: 'https://instagram.com/shop' },
    ]);
    expect(shops[0].profile.location).toEqual({ lat: 35.85, lng: 139.32 });
  });

  it('無料の一品は profile.freeDish として出て、無い店は null', async () => {
    const { db } = fakeShopDb([
      {
        id: 'shop-a',
        data: {
          name: '店A',
          profile: {
            displayName: '店A',
            freeDish: {
              name: '飯能カレー',
              description: '地元野菜たっぷり',
              photoUrl: 'https://example.com/dish.jpg',
            },
          },
        },
      },
      {
        id: 'shop-b',
        data: { name: '店B', profile: { displayName: '店B' } },
      },
    ]);
    const shops = await listPublicShops(db, 'ev1');
    const byId = new Map(shops.map((s) => [s.exhibitorId, s]));
    expect(byId.get('shop-a')?.profile.freeDish).toEqual({
      name: '飯能カレー',
      description: '地元野菜たっぷり',
      photoUrl: 'https://example.com/dish.jpg',
    });
    expect(byId.get('shop-b')?.profile.freeDish).toBeNull();
  });
});

describe('isShopPubliclyListed', () => {
  it('掲載あり＋課金停止でなければ公開する', () => {
    const profile = parseShopProfile({ published: true });
    expect(isShopPubliclyListed(profile, undefined)).toBe(true);
    expect(isShopPubliclyListed(profile, false)).toBe(true);
  });

  it('課金停止中の店は、掲載設定がオンでも公開しない', () => {
    const profile = parseShopProfile({ published: true });
    expect(isShopPubliclyListed(profile, true)).toBe(false);
  });

  it('店自身が掲載をオフにしていれば、課金状態によらず公開しない', () => {
    const profile = parseShopProfile({ published: false });
    expect(isShopPubliclyListed(profile, undefined)).toBe(false);
    expect(isShopPubliclyListed(profile, true)).toBe(false);
  });
});

describe('ログインボーナス特典（loginReward）の読み取り', () => {
  it('未設定は null、設定済みはそのまま読む（freeDish とは独立）', () => {
    expect(parseShopProfile({}).loginReward).toBeNull();
    const profile = parseShopProfile({
      freeDish: { name: '無料カレー', description: '', photoUrl: null },
      loginReward: {
        name: 'ドリンク1杯',
        description: 'ログイン特典',
        photoUrl: 'https://example.com/drink.jpg',
      },
    });
    expect(profile.loginReward).toEqual({
      name: 'ドリンク1杯',
      description: 'ログイン特典',
      photoUrl: 'https://example.com/drink.jpg',
    });
    expect(profile.freeDish?.name).toBe('無料カレー');
    // 公開形にも loginReward が載る
    const shop = toPublicShop(
      { id: 'shop-a', name: '店A' },
      {
        loginReward: {
          name: 'ドリンク1杯',
          description: 'ログイン特典',
          photoUrl: 'https://example.com/drink.jpg',
        },
      },
    );
    expect(shop.profile.loginReward?.name).toBe('ドリンク1杯');
  });

  it('名前が無い特典は null、写真が https でなければ写真だけ落とす', () => {
    expect(
      parseShopProfile({ loginReward: { description: '説明だけ' } })
        .loginReward,
    ).toBeNull();
    // 読み取りは防御的: 不正な写真は null に倒し、特典自体は残す
    // （freeDish の読み取りと同じ規則）
    expect(
      parseShopProfile({
        loginReward: { name: '特典', photoUrl: 'http://example.com/x.jpg' },
      }).loginReward,
    ).toEqual({ name: '特典', description: '', photoUrl: null });
  });

  it('写真パスは login-reward- 接頭辞で作る', () => {
    expect(shopLoginRewardPhotoStoragePath('ev1', 'shop-a', 'x.jpg')).toBe(
      'events/ev1/shop-photos/shop-a/login-reward-x.jpg',
    );
  });
});

describe('ログインボーナス特典（loginReward）の保存検証', () => {
  it('正常な特典を通し、空なら未登録（null）', () => {
    const ok = validateShopProfileInput({
      loginReward: { name: ' ドリンク1杯 ', description: '', photoUrl: null },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.loginReward?.name).toBe('ドリンク1杯');
    const none = validateShopProfileInput({});
    expect(none.ok && none.value.loginReward).toBeNull();
  });

  it('名前なし・文字数超過・http 写真はエラー（文面は特典用）', () => {
    const noName = validateShopProfileInput({
      loginReward: { description: '説明だけ' },
    });
    expect(noName.ok).toBe(false);
    if (!noName.ok) {
      expect(noName.error).toBe('ログインボーナス特典の名前を入力してください');
    }
    const tooLong = validateShopProfileInput({
      loginReward: { name: 'あ'.repeat(51) },
    });
    expect(tooLong.ok).toBe(false);
    const badPhoto = validateShopProfileInput({
      loginReward: { name: '特典', photoUrl: 'http://example.com/x.jpg' },
    });
    expect(badPhoto.ok).toBe(false);
  });
});

describe('resolveTopFeatured（トップ掲載の対象判定・無料対応）', () => {
  it('料金 0（無料）の間は参加表明だけを見る（課金フラグは無視）', () => {
    expect(
      resolveTopFeatured({
        topPlacementPrice: 0,
        topFeatured: false,
        placementOptIn: true,
      }),
    ).toBe(true);
    expect(
      resolveTopFeatured({
        topPlacementPrice: 0,
        topFeatured: true,
        placementOptIn: false,
      }),
    ).toBe(false);
    expect(
      resolveTopFeatured({
        topPlacementPrice: 0,
        topFeatured: undefined,
        placementOptIn: undefined,
      }),
    ).toBe(false);
  });

  it('有料の間は従来どおり課金フラグだけを見る（表明は無視）', () => {
    expect(
      resolveTopFeatured({
        topPlacementPrice: 3000,
        topFeatured: true,
        placementOptIn: false,
      }),
    ).toBe(true);
    expect(
      resolveTopFeatured({
        topPlacementPrice: 3000,
        topFeatured: false,
        placementOptIn: true,
      }),
    ).toBe(false);
  });

  it('料金未設定（null）は有料扱い（従来動作）', () => {
    expect(
      resolveTopFeatured({
        topPlacementPrice: null,
        topFeatured: true,
        placementOptIn: false,
      }),
    ).toBe(true);
    expect(
      resolveTopFeatured({
        topPlacementPrice: null,
        topFeatured: false,
        placementOptIn: true,
      }),
    ).toBe(false);
  });
});

describe('listPublicShops のトップ掲載フラグ（無料の間は参加表明）', () => {
  it('料金 0 のプロジェクトでは placementOptIn の店だけ topFeatured になる', async () => {
    const { db } = fakeShopDb(
      [
        { id: 'shop-a', data: { name: '店A', profile: {}, placementOptIn: true } },
        { id: 'shop-b', data: { name: '店B', profile: {}, topFeatured: true } },
      ],
      { topPlacementPrice: 0 },
    );
    const shops = await listPublicShops(db, 'ev1');
    const byId = new Map(shops.map((s) => [s.exhibitorId, s]));
    expect(byId.get('shop-a')?.topFeatured).toBe(true);
    expect(byId.get('shop-b')?.topFeatured).toBe(false);
  });

  it('有料のプロジェクトでは従来どおり topFeatured フラグで決まる', async () => {
    const { db } = fakeShopDb(
      [
        { id: 'shop-a', data: { name: '店A', profile: {}, placementOptIn: true } },
        { id: 'shop-b', data: { name: '店B', profile: {}, topFeatured: true } },
      ],
      { topPlacementPrice: 3000 },
    );
    const shops = await listPublicShops(db, 'ev1');
    const byId = new Map(shops.map((s) => [s.exhibitorId, s]));
    expect(byId.get('shop-a')?.topFeatured).toBe(false);
    expect(byId.get('shop-b')?.topFeatured).toBe(true);
  });
});

describe('listPublicShops の協賛アカウント除外', () => {
  it('協賛（広告専用）アカウントは参加店一覧に出ない', async () => {
    const { db } = fakeShopDb([
      { id: 'shop-a', data: { name: '店A', profile: {} } },
      {
        id: 'sponsor-1',
        data: { name: '協賛企業', profile: {}, kind: 'advertiser' },
      },
      { id: 'shop-b', data: { name: '店B', profile: {}, kind: 'shop' } },
    ]);
    const shops = await listPublicShops(db, 'ev1');
    expect(shops.map((s) => s.exhibitorId)).toEqual(['shop-a', 'shop-b']);
  });

  it('スポットは kind とチェックポイント番号つきで一覧に出る', async () => {
    const { db } = fakeShopDb([
      { id: 'shop-a', data: { name: '店A', profile: {}, kind: 'shop' } },
      {
        id: 'spot-b',
        data: {
          name: '展望台',
          profile: {},
          kind: 'spot',
          checkpointNumber: 2,
        },
      },
    ]);
    const shops = await listPublicShops(db, 'ev1');
    const byId = new Map(shops.map((s) => [s.exhibitorId, s]));
    expect(byId.get('shop-a')?.kind).toBe('shop');
    expect(byId.get('shop-a')?.checkpointNumber).toBeNull();
    expect(byId.get('spot-b')?.kind).toBe('spot');
    expect(byId.get('spot-b')?.checkpointNumber).toBe(2);
  });
});

describe('setShopDelistedAt（掲載停止の日時の付け替え）', () => {
  const delistedOf = (updates: Array<{ value: unknown }>) =>
    updates.map(
      (u) => (u.value as { delistedAt?: string | null }).delistedAt,
    );

  it('停止時に日時を付け、既にある場合は最初の日時を維持する', async () => {
    const { db, updates } = fakeShopDb([
      { id: 'shop-a', data: { name: '店A', profile: {} } },
    ]);
    await expect(
      setShopDelistedAt(db, 'ev1', 'shop-a', '2026-11-01T00:00:00.000Z'),
    ).resolves.toBe(true);
    expect(delistedOf(updates)).toEqual(['2026-11-01T00:00:00.000Z']);

    const second = fakeShopDb([
      {
        id: 'shop-a',
        data: {
          name: '店A',
          profile: {},
          delistedAt: '2026-11-01T00:00:00.000Z',
        },
      },
    ]);
    await setShopDelistedAt(second.db, 'ev1', 'shop-a', '2026-12-01T00:00:00.000Z');
    expect(second.updates).toHaveLength(0);
  });

  it('復旧時（null）は日時を取り除き、店が無ければ false', async () => {
    const { db, updates } = fakeShopDb([
      {
        id: 'shop-a',
        data: {
          name: '店A',
          profile: {},
          delistedAt: '2026-11-01T00:00:00.000Z',
        },
      },
    ]);
    await expect(setShopDelistedAt(db, 'ev1', 'shop-a', null)).resolves.toBe(
      true,
    );
    expect(delistedOf(updates)).toEqual([null]);
    await expect(
      setShopDelistedAt(db, 'ev1', 'missing', '2026-11-01T00:00:00.000Z'),
    ).resolves.toBe(false);
  });
});

describe('listBillingSuspendedExhibitorIds', () => {
  function fakeDb(
    docs: Array<{ id: string; billingSuspended?: unknown }>,
  ): Firestore {
    return {
      collection: () => ({
        doc: () => ({
          collection: () => ({
            where: (field: string, _op: string, value: unknown) => ({
              get: async () => ({
                docs: docs
                  .filter((d) => d[field as 'billingSuspended'] === value)
                  .map((d) => ({ id: d.id, data: () => d })),
              }),
            }),
          }),
        }),
      }),
    } as unknown as Firestore;
  }

  it('billingSuspended=true の店だけを集める', async () => {
    const db = fakeDb([
      { id: 'shop-1', billingSuspended: true },
      { id: 'shop-2', billingSuspended: false },
      { id: 'shop-3' },
    ]);
    const ids = await listBillingSuspendedExhibitorIds(db, 'event-1');
    expect([...ids]).toEqual(['shop-1']);
  });

  it('停止店が無ければ空集合', async () => {
    const db = fakeDb([{ id: 'shop-1', billingSuspended: false }]);
    const ids = await listBillingSuspendedExhibitorIds(db, 'event-1');
    expect(ids.size).toBe(0);
  });
});
