import { expect, it } from 'vitest';
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
