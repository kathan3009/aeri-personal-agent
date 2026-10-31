import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Cart } from '@personal-agent/core';
import { confirmsAge, gateIn, runShoppingAgent } from './shopping-agent.js';
import { createStore, type Store } from './store.js';
import { singlePersonApp } from './testing.js';

vi.mock('./shopping-agent.js', async () => ({ ...(await vi.importActual<typeof import('./shopping-agent.js')>('./shopping-agent.js')), runShoppingAgent: vi.fn() }));
vi.mock('./market.js', async () => ({ ...(await vi.importActual<typeof import('./market.js')>('./market.js')), closeSession: vi.fn(async () => {}), sessionAlive: vi.fn(async () => true) }));

describe('walls read from the store page', () => {
  it('spots age checks, sign-in walls, address prompts and order minimums', () => {
    expect(gateIn('Must be 21+ to purchase. Valid ID required at delivery.')).toBe('age_check');
    expect(gateIn('Alcohol delivery: confirm your age')).toBe('age_check');
    expect(gateIn('Sign in to continue shopping')).toBe('sign_in');
    expect(gateIn('Enter your delivery address to see what’s available')).toBe('address');
    expect(gateIn('$10 order minimum')).toBe('minimum_order');
    expect(gateIn('Lipton Black Tea, 100 ct, $6.48. Add to cart')).toBeNull();
  });
  it('treats only age confirmations as age confirmations', () => {
    expect(confirmsAge('Yes, I’m 21 or older', null)).toBe(true);
    expect(confirmsAge('I am over 21', null)).toBe(true);
    expect(confirmsAge('Yes', 'age_check')).toBe(true);
    expect(confirmsAge('Yes', null)).toBe(false);
    expect(confirmsAge('Add to cart', 'age_check')).toBe(false);
  });
});

const at = '2026-10-04T12:00:00.000Z';
const cart: Cart = { id: 'party', title: 'Party', origin: 'request', status: 'approved', merchant: 'Instacart', createdAt: at, updatedAt: at,
  items: [
    { id: 'soda', name: 'Soda', quantity: { amount: 1, unit: 'each' }, optional: false, status: 'found', estimatedPriceCents: 500, offer: { merchant: 'Instacart', title: 'Soda', url: 'https://www.instacart.com/products/1-soda', priceCents: 500, packs: 1, verified: true, capturedAt: at } },
    { id: 'beer', name: 'Beer', quantity: { amount: 1, unit: 'each' }, optional: false, status: 'found', estimatedPriceCents: 1200, offer: { merchant: 'Instacart', title: 'Beer', url: 'https://www.instacart.com/products/2-beer', priceCents: 1200, packs: 1, verified: true, capturedAt: at } },
  ] };
let directory: string, store: Store;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aeri-trace-')); vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('KERNEL_API_KEY', 'test-kernel'); vi.stubEnv('NEON_AI_GATEWAY_API_KEY', 'test-gateway'); vi.stubEnv('NEON_AI_GATEWAY_BASE_URL', 'https://gateway.example');
  store = createStore('', directory); await store.update(state => { state.carts.push(structuredClone(cart)); });
  vi.mocked(runShoppingAgent).mockReset();
});
afterEach(async () => { await store.close(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('a store visit you can trace, with prompts for what only you can do', () => {
  it('keeps the trace and reasons, asks the person to confirm their age, and adds the item after they do', async () => {
    const app = singlePersonApp(store, 'test-code');
    const headers = { Authorization: 'Bearer test-code', 'Content-Type': 'application/json' };
    vi.mocked(runShoppingAgent).mockResolvedValueOnce({ url: 'https://www.instacart.com/', mode: 'kernel', sessionId: 's1', note: 'Soda is in your cart.', signedIn: true, cartUrl: 'https://www.instacart.com/store/raleys/storefront', runId: 'run1',
      trace: [{ at, step: 'open_store', detail: 'Opened instacart.com (signed in)', ok: true }, { at, step: 'press', detail: 'Pressed “Yes, I’m 21” — Only the person can confirm their age.', ok: false }],
      lines: [{ itemId: 'soda', result: 'added' }, { itemId: 'beer', result: 'uncertain', reason: 'age_check', detail: 'Not added' }] });
    expect((await app.request('/v1/carts/party/checkout?wait=1', { method: 'POST', headers })).status).toBe(200);
    let state = await store.read(), saved = state.carts[0];
    expect(saved.checkout).toMatchObject({ account: 'signed_in', runId: expect.any(String) });
    expect(saved.checkout!.trace).toHaveLength(2);
    expect(saved.checkout!.lines.find(line => line.itemId === 'beer')?.reason).toBe('age_check');
    expect(state.tasks.find(task => task.title === 'Confirm you’re 21 or older')).toMatchObject({ status: 'needs_review', subjectId: 'party' });
    expect(vi.mocked(runShoppingAgent).mock.calls[0][0]).toMatchObject({ ageConfirmed: false, userId: 'default' });

    vi.mocked(runShoppingAgent).mockResolvedValueOnce({ url: 'https://www.instacart.com/', mode: 'kernel', sessionId: 's2', note: 'Beer is in your cart.', signedIn: true, runId: 'run2',
      trace: [{ at, step: 'record_item', detail: 'Beer: added, checked in the cart', ok: true }], lines: [{ itemId: 'beer', result: 'added' }] });
    expect((await app.request('/v1/carts/party/finish', { method: 'POST', headers, body: JSON.stringify({ confirmAge: true }) })).status).toBe(200);
    await app.service.idle();
    const second = vi.mocked(runShoppingAgent).mock.calls[1][0];
    expect(second).toMatchObject({ ageConfirmed: true, stayAt: true, chosen: 'instacart.com' });
    expect(second.cart.items.map(item => item.id)).toEqual(['beer']);
    state = await store.read(); saved = state.carts[0];
    expect(saved.checkout!.lines.map(line => [line.itemId, line.result])).toEqual([['soda', 'added'], ['beer', 'added']]);
    expect(saved.checkout!.trace).toHaveLength(3);
    expect(state.preferences.Age).toMatch(/21 or older/);
    expect(state.tasks.find(task => task.title === 'Confirm you’re 21 or older')?.status).toBe('done');
  });

  it('tells the person to have ID ready when an age-restricted item was added', async () => {
    const app = singlePersonApp(store, 'test-code');
    vi.mocked(runShoppingAgent).mockResolvedValueOnce({ url: 'https://www.instacart.com/', mode: 'kernel', sessionId: 's1', note: 'Both are in your cart.', signedIn: true, runId: 'r',
      lines: [{ itemId: 'soda', result: 'added' }, { itemId: 'beer', result: 'added', reason: 'age_check', detail: 'Valid ID (21+) needed at delivery.' }] });
    await app.request('/v1/carts/party/checkout?wait=1', { method: 'POST', headers: { Authorization: 'Bearer test-code' } });
    const state = await store.read();
    expect(state.tasks.find(task => task.title === 'Have your ID ready')?.detail).toMatch(/Beer from Instacart needs a valid ID/);
    expect(state.tasks.some(task => task.title === 'Confirm you’re 21 or older')).toBe(false);
  });

  it('keeps the trace and a reference when a store visit fails', async () => {
    const app = singlePersonApp(store, 'test-code');
    vi.mocked(runShoppingAgent).mockRejectedValueOnce(Object.assign(new Error('The shopping agent couldn’t open a store'), { trace: [{ at, step: 'open_store', detail: 'Opened walmart.com — failed: timeout', ok: false }] }));
    const response = await app.request('/v1/carts/party/checkout?wait=1', { method: 'POST', headers: { Authorization: 'Bearer test-code' } });
    expect(response.ok).toBe(false);
    const saved = (await store.read()).carts[0];
    expect(saved.checkout).toMatchObject({ status: 'failed', note: expect.stringMatching(/reference [0-9a-f]{8}/) });
    expect(saved.checkout!.trace?.[0].detail).toMatch(/timeout/);
  });
});
