import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart } from '@personal-agent/core';
import { singlePersonApp } from './testing.js';
import { prepareMerchantCart, closeSession, type PreparedCart } from './market.js';
import { disconnectMerchantAuth } from './merchant-auth.js';
import { createStore, type Store } from './store.js';

vi.mock('./market.js', async () => ({ ...(await vi.importActual<typeof import('./market.js')>('./market.js')), prepareMerchantCart: vi.fn(), closeSession: vi.fn(async () => {}) }));
vi.mock('./merchant-auth.js', async () => ({ ...(await vi.importActual<typeof import('./merchant-auth.js')>('./merchant-auth.js')), disconnectMerchantAuth: vi.fn(async () => {}) }));
let directory: string, store: Store, app: ReturnType<typeof singlePersonApp>;
const headers = { Authorization: 'Bearer test-code', 'Content-Type': 'application/json' };
const at = '2026-10-04T12:00:00.000Z';
const cart: Cart = { id: 'cart', origin: 'request', status: 'approved', merchant: 'Target', createdAt: at, updatedAt: at,
  items: [{ id: 'milk', name: 'Milk', quantity: { amount: 1, unit: 'each' }, optional: false, status: 'found', estimatedPriceCents: 399,
    offer: { merchant: 'Target', title: 'Milk', url: 'https://www.target.com/p/milk/-/A-1234', priceCents: 399, packs: 1, verified: true, capturedAt: at } }] };
function signal<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function pendingPreparation() {
  const started = signal<void>(), result = signal<PreparedCart>();
  vi.mocked(prepareMerchantCart).mockImplementationOnce(async () => { started.resolve(); return result.promise; });
  return { started, result };
}
function prepared(sessionId: string): PreparedCart { return { mode: 'kernel', url: 'https://www.target.com/cart', sessionId, liveViewUrl: `https://live.kernel.sh/${sessionId}`, note: 'Fixture prepared cart', lines: [{ itemId: 'milk', result: 'added' }] }; }
const post = (path: string) => app.request(path, { method: 'POST', headers });
const disconnect = () => app.request('/v1/retailers/target.com/auth', { method: 'DELETE', headers });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aeri-checkout-lifecycle-')); vi.stubEnv('DATA_DIR', directory); vi.stubEnv('KERNEL_API_KEY', 'test-never-used');
  for (const key of ['DATABASE_URL', 'EXA_API_KEY', 'GEMINI_API_KEY', 'NEON_AI_GATEWAY_API_KEY', 'NEON_AI_GATEWAY_TOKEN']) vi.stubEnv(key, '');
  store = createStore('', directory); await store.update(state => state.carts.push(structuredClone(cart))); app = singlePersonApp(store, 'test-code');
  vi.mocked(prepareMerchantCart).mockReset(); vi.mocked(closeSession).mockClear(); vi.mocked(disconnectMerchantAuth).mockClear();
});
afterEach(async () => { await app.service.idle(); await store.close(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('hosted merchant preparation lifecycle', () => {
  it('rejects duplicate preparation while the first approved cart is still being prepared', async () => {
    const pending = pendingPreparation();
    const first = post('/v1/carts/cart/checkout?wait=1'); await pending.started.promise;
    const duplicate = await post('/v1/carts/cart/checkout?wait=1');
    expect(duplicate.status).toBe(400); expect(prepareMerchantCart).toHaveBeenCalledTimes(1);
    expect((await store.read()).carts[0]).toMatchObject({ status: 'approved', checkoutUrl: 'https://www.target.com/', checkout: { status: 'preparing' } });
    pending.result.resolve(prepared('first-session')); expect((await first).status).toBe(200);
    expect((await store.read()).carts[0]).toMatchObject({ status: 'checkout_ready', checkout: { sessionId: 'first-session' } });
  });
  it('closes a late preparation result after cancellation instead of reviving a cancelled cart', async () => {
    const pending = pendingPreparation();
    const first = post('/v1/carts/cart/checkout?wait=1'); await pending.started.promise;
    expect((await post('/v1/carts/cart/cancel')).status).toBe(200);
    pending.result.resolve(prepared('late-session')); expect((await first).status).toBe(400);
    expect(closeSession).toHaveBeenCalledWith('late-session'); expect(await store.getLiveView('cart')).toBeNull();
    expect((await store.read()).carts[0].status).toBe('cancelled');
  });
  it('finds a first-time pending cart by its early checkout URL and invalidates it on retailer disconnect', async () => {
    await store.setMerchantConnection({ merchant: 'target.com', connectionId: 'connection-owned', createdAt: at });
    const pending = pendingPreparation();
    const first = post('/v1/carts/cart/checkout?wait=1'); await pending.started.promise;
    expect((await disconnect()).status).toBe(200);
    expect(disconnectMerchantAuth).toHaveBeenCalledOnce(); expect(await store.getMerchantConnection('target.com')).toBeNull();
    expect((await store.read()).carts[0].checkout?.status).toBe('failed');
    pending.result.resolve(prepared('disconnected-late')); expect((await first).status).toBe(400);
    expect(closeSession).toHaveBeenCalledWith('disconnected-late'); expect(await store.getLiveView('cart')).toBeNull();
    expect((await store.read()).carts[0].status).toBe('approved');
  });
  it('keeps a newer preparation and its live session when an older disconnected attempt finishes late', async () => {
    await store.setMerchantConnection({ merchant: 'target.com', connectionId: 'connection-owned', createdAt: at });
    const old = pendingPreparation(); const first = post('/v1/carts/cart/checkout?wait=1'); await old.started.promise;
    expect((await disconnect()).status).toBe(200);
    const fresh = pendingPreparation(); const second = post('/v1/carts/cart/checkout?wait=1'); await fresh.started.promise;
    fresh.result.resolve(prepared('fresh-session')); expect((await second).status).toBe(200);
    old.result.resolve(prepared('old-session')); expect((await first).status).toBe(400);
    expect(closeSession).toHaveBeenCalledWith('old-session'); expect(closeSession).not.toHaveBeenCalledWith('fresh-session');
    expect((await store.getLiveView('cart'))?.sessionId).toBe('fresh-session');
    expect((await store.read()).carts[0]).toMatchObject({ status: 'checkout_ready', checkout: { status: 'ready', sessionId: 'fresh-session' } });
  });
});
