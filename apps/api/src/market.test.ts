import { expect, it, vi } from 'vitest';
import { merchantDomainsFor, toVerification } from './market.js';

const at = '2026-10-04T12:00:00Z';
it('reads a price from structured data or the store’s own price element, and says whose store it is', () => {
  expect(toVerification({ status: 200, url: 'https://www.target.com/p/x', name: 'FAGE Total 2% 32oz', price: null, shownPrice: '7.49', shownStore: 'Chelsea 23rd and 8th', stockText: 'PickupReady within 2 hours', availability: '' }, at))
    .toMatchObject({ status: 'verified', priceCents: 749, availability: 'in_stock', storeLocation: "Chelsea 23rd and 8th (picked by the store for the browser's location)" });
  expect(toVerification({ status: 200, url: 'https://x.com/p/y', name: 'Thing', price: '3.99', availability: 'https://schema.org/OutOfStock', stockText: 'Pickup ready today' }, at))
    .toMatchObject({ status: 'verified', priceCents: 399, availability: 'out_of_stock' });
  expect(toVerification({ status: 200, url: 'https://x.com/p/y', name: 'Thing', price: null }, at)).toMatchObject({ status: 'partial', note: 'The page did not publish a machine-readable price' });
});

it('never takes a product name or price from a bot check or a missing page', () => {
  const walled = toVerification({ status: 200, url: 'https://www.walmart.com/ip/1', name: 'Robot or human?', title: 'Robot or human?', price: '1.00' }, at);
  expect(walled).toMatchObject({ status: 'blocked' });
  expect(walled.name).toBeUndefined(); expect(walled.priceCents).toBeUndefined();
  expect(toVerification({ status: 200, url: 'https://www.target.com/p/2', name: 'Product not found', title: 'Product not found : Target' }, at)).toMatchObject({ status: 'failed', note: 'The product page no longer exists' });
});

it('maps saved store names to the domains it searches', () => {
  expect(merchantDomainsFor(['Trader Joe’s', 'Whole Foods', 'Target', 'Costco'])).toEqual(['traderjoes.com', 'wholefoodsmarket.com', 'target.com']);
  expect(merchantDomainsFor([])).toEqual(['walmart.com', 'target.com']);
});

it('finds stores by searching for each item, keeps favourites first and drops avoided stores and non-shops', async () => {
  vi.resetModules();
  vi.doMock('./providers.js', async original => ({ ...(await original<typeof import('./providers.js')>()), researchProducts: async (query: string) => ({
    'Vanilla extract buy online': [{ title: 'Vanilla', url: 'https://www.kroger.com/p/vanilla/1' }, { title: 'Recipe', url: 'https://www.allrecipes.com/recipe/1' }, { title: 'Vanilla', url: 'https://www.walmart.com/ip/2' }],
    'Flour buy online': [{ title: 'Flour', url: 'https://www.kroger.com/p/flour/2' }, { title: 'Flour', url: 'https://www.amazon.com/dp/B1' }, { title: 'Flour blog', url: 'https://www.kroger.com/blog/flour' }],
  } as Record<string, Array<{ title: string; url: string }>>)[query] ?? [] }));
  const { discoverStores } = await import('./market.js');
  const found = await discoverStores([{ id: 'v', name: 'Vanilla extract' }, { id: 'f', name: 'Flour' }], { prefer: ['Target'], avoid: ['Amazon'] });
  expect(found.domains).toEqual(['target.com', 'kroger.com', 'walmart.com']);
  expect(found.coverage).toEqual({ 'kroger.com': 2, 'walmart.com': 1 });
  vi.doUnmock('./providers.js');
});

it('describes cart fills in plain words', async () => {
  const { fillNote } = await import('./market.js');
  expect(fillNote([{ itemId: 'a', result: 'uncertain', detail: 'Search for x' }], 3, 'Instacart')).toMatch(/couldn’t add these at Instacart by itself/);
  expect(fillNote([{ itemId: 'a', result: 'added' }, { itemId: 'b', result: 'uncertain', detail: 'Aeri added this. Check it.' }], 3, 'Target')).toBe('Aeri added 2 of 3 items at Target. Add the rest from the list below, check the cart, then pay there yourself.');
});
