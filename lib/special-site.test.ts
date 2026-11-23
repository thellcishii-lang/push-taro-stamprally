import { describe, expect, it } from 'vitest';
import { HONKE_BASE_URL, specialSiteShopUrl, specialSiteUrl } from './special-site';

describe('specialSiteUrl', () => {
  it('points at the project page on push-taro.com', () => {
    expect(specialSiteUrl('ev-123')).toBe(
      'https://push-taro.com/stamprally/site/ev-123',
    );
  });

  it('encodes the eventId', () => {
    expect(specialSiteUrl('ev 1/2')).toBe(
      'https://push-taro.com/stamprally/site/ev%201%2F2',
    );
  });
});

describe('specialSiteShopUrl', () => {
  it('points at the shop page under the project page', () => {
    expect(specialSiteShopUrl('ev-123', 'shop-9')).toBe(
      'https://push-taro.com/stamprally/site/ev-123/shop/shop-9',
    );
  });

  it('encodes both ids', () => {
    expect(specialSiteShopUrl('ev 1', 'shop 2')).toBe(
      'https://push-taro.com/stamprally/site/ev%201/shop/shop%202',
    );
  });
});

describe('HONKE_BASE_URL', () => {
  it('is the honke origin', () => {
    expect(HONKE_BASE_URL).toBe('https://push-taro.com');
  });
});
