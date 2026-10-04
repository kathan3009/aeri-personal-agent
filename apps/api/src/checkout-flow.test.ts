import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validatePurchaseApproval, type Cart, type PurchaseApproval } from '@personal-agent/core';
import type { MerchantSummary } from './merchant-summary.js';
import { createApp } from './app.js';
import { readMerchantSummary, closeSession } from './market.js';
import { createStore, type Store } from './store.js';

vi.mock('./market.js', async () => ({ ...(await vi.importActual<typeof import('./market.js')>('./market.js')), readMerchantSummary: vi.fn(), closeSession: vi.fn(async () => {}) }));
const at = '2026-10-04T12:00:00.000Z';
const headers = { Authorization: 'Bearer test-code', 'Content-Type': 'application/json' };
let directory: string, store: Store;
let app: ReturnType<typeof createApp>;
const cart: Cart = {
  id: 'cart', origin: 'request', status: 'checkout_ready', merchant: 'Target', checkoutUrl: 'https://www.target.com/checkout', createdAt: at, updatedAt: at,
  checkout: { mode: 'kernel', sessionId: 'mock-session', openedAt: at, status: 'ready', note: 'Fixture hosted cart', lines: [] },
  items: [{ id: 'milk', name: 'Milk', quantity: { amount: 2, unit: 'each' }, optional: false, status: 'added', estimatedPriceCents: 798,
    offer: { merchant: 'Target', title: 'Organic Whole Milk 1 L', url: 'https://www.target.com/p/milk/-/A-1234', priceCents: 798, packs: 2, verified: true, capturedAt: at } }],
};
const summary = (): MerchantSummary => ({
  merchant: 'target.com', url: 'https://www.target.com/checkout', capturedAt: new Date().toISOString(), currency: 'USD',
  lines: [{ name: 'Organic Whole Milk 1 L', productUrl: 'https://www.target.com/p/milk/-/A-1234', quantity: 2, unitPriceCents: 399, lineTotalCents: 798 }],
  subtotalCents: 798, feesCents: 100, taxCents: 50, tipCents: 0, discountCents: 25, totalCents: 923,
  fulfillment: 'pickup', locationKey: 'test-store:94103', complete: true,
});
const request = (path: string, method = 'GET', body?: unknown) => app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const readSummary = async () => { const response = await request('/v1/carts/cart/summary'); expect(response.status).toBe(200); return response.json() as Promise<any>; };
const approve = (snapshotId: string, maximumTotalCents = 1000) => request('/v1/carts/cart/purchase-approval', 'POST', { snapshotId, maximumTotalCents });

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(at));
  for (const key of ['DATABASE_URL', 'KERNEL_API_KEY', 'EXA_API_KEY', 'GEMINI_API_KEY', 'NEON_AI_GATEWAY_API_KEY', 'NEON_AI_GATEWAY_TOKEN']) vi.stubEnv(key, '');
  directory = await mkdtemp(join(tmpdir(), 'aeri-checkout-flow-')); vi.stubEnv('DATA_DIR', directory);
  store = createStore('', directory); await store.update(state => state.carts.push(structuredClone(cart)));
  app = createApp(store, 'test-code');
  vi.mocked(readMerchantSummary).mockReset(); vi.mocked(readMerchantSummary).mockImplementation(async () => summary());
  vi.mocked(closeSession).mockClear();
});
afterEach(async () => { await store?.close(); vi.useRealTimers(); vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });

describe('authenticated final checkout review', () => {
  it('keeps incomplete charges review-only without producing a snapshot or approval', async () => {
    vi.mocked(readMerchantSummary).mockResolvedValueOnce({ ...summary(), complete: false, taxCents: undefined, note: 'Tax is not visible yet' });
    const reviewed = await readSummary();
    expect(reviewed.matches).toBe(false); expect(reviewed.snapshot).toBeUndefined(); expect(reviewed.discrepancies).toContain('Tax is not visible yet');
    expect((await approve('invented')).status).toBe(400);
    expect((await store.read()).carts[0].purchaseApproval).toBeUndefined();
  });
  it('requires re-review for changed approved product prices and quantities', async () => {
    vi.mocked(readMerchantSummary).mockResolvedValueOnce({ ...summary(), lines: [{ ...summary().lines[0], unitPriceCents: 499, lineTotalCents: 998 }], subtotalCents: 998, totalCents: 1123 });
    const reviewed = await readSummary();
    expect(reviewed.snapshot).toBeTruthy(); expect(reviewed.matches).toBe(false); expect(reviewed.discrepancies).toContain('Milk has a different price.');
    const refused = await approve(reviewed.snapshot.id, 2000);
    expect(refused.status).toBe(400); expect((await store.read()).carts[0].purchaseApproval).toBeUndefined();
  });
  it('approves an exact multi-pack snapshot with a bounded maximum and five-minute expiry', async () => {
    const reviewed = await readSummary(); expect(reviewed.matches).toBe(true);
    expect(reviewed.snapshot.lines[0]).toMatchObject({ itemId: 'milk', quantity: 2, unitPriceCents: 399, lineTotalCents: 798 });
    expect((await approve(reviewed.snapshot.id, 900)).status).toBe(400);
    const response = await approve(reviewed.snapshot.id); expect(response.status).toBe(200);
    const approval = await response.json() as PurchaseApproval;
    expect(approval).toMatchObject({ status: 'active', cartId: 'cart', maximumTotalCents: 1000, expiresAt: '2026-10-04T12:05:00.000Z' });
    vi.setSystemTime(new Date('2026-10-04T12:05:00.000Z'));
    expect((await validatePurchaseApproval(approval, reviewed.snapshot, new Date().toISOString())).valid).toBe(false);
    expect((await approve(reviewed.snapshot.id)).status).toBe(400);
  });
  it('invalidates an earlier approval whenever checkout is refreshed, even with unchanged contents', async () => {
    const first = await readSummary(); await approve(first.snapshot.id);
    vi.setSystemTime(new Date('2026-10-04T12:01:00.000Z'));
    const second = await readSummary();
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect((await store.read()).carts[0].purchaseApproval).toMatchObject({ status: 'invalidated', invalidatedAt: '2026-10-04T12:01:00.000Z' });
    expect((await approve(first.snapshot.id)).status).toBe(400);
    expect((await approve(second.snapshot.id)).status).toBe(200);
  });
  it('clears checkout evidence and approval on cancellation without submitting a purchase', async () => {
    const reviewed = await readSummary(); await approve(reviewed.snapshot.id);
    expect((await request('/v1/carts/cart/cancel', 'POST')).status).toBe(200);
    const saved = (await store.read()).carts[0];
    expect(saved.status).toBe('cancelled'); expect(saved.checkoutSnapshot).toBeUndefined(); expect(saved.purchaseApproval).toBeUndefined();
    expect(closeSession).toHaveBeenCalledWith('mock-session');
  });
  it('exposes no real merchant submit/pay endpoint and authenticates final approval', async () => {
    expect((await app.request('/v1/carts/cart/purchase-approval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotId: 'x', maximumTotalCents: 1000 }) })).status).toBe(401);
    for (const action of ['submit', 'pay', 'purchase']) expect((await request(`/v1/carts/cart/${action}`, 'POST')).status).toBe(404);
    expect((await store.read()).carts[0].status).toBe('checkout_ready');
  });
});
