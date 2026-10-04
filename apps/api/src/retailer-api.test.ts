import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Kernel from '@onkernel/sdk';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerRetailerRoutes } from './retailer-api.js';
import { createStore, type Store } from './store.js';

const token = 'test-owner-access', at = '2026-10-04T12:00:00.000Z';
const scope = createHash('sha256').update(token).digest('hex').slice(0, 24);
let directory: string, store: Store;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aeri-retailer-test-')); store = createStore('', directory); });
afterEach(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
function setup() {
  const records = new Map<string, Record<string, unknown>>();
  const connections = {
    list: vi.fn(({ domain, profile_name }: { domain: string; profile_name: string }) => (async function* () { for (const value of records.values()) if (value.domain === domain && value.profile_name === profile_name) yield value; })()),
    create: vi.fn(async (args: Record<string, unknown>) => { const c = { id: `connection_${records.size + 1}`, ...args, status: 'NEEDS_AUTH' }; records.set(c.id, c); return c; }),
    retrieve: vi.fn(async (id: string) => { const c = records.get(id); if (!c) throw Object.assign(new Error('not found'), { status: 404 }); return c; }),
    login: vi.fn(async (id: string) => { const c = records.get(id)!; Object.assign(c, { flow_status: 'IN_PROGRESS', hosted_url: 'https://login.kernel.sh/sensitive', flow_expires_at: '2099-01-01T00:00:00Z' }); return c; }),
    delete: vi.fn(async (id: string) => { records.delete(id); }),
  };
  const profiles = { delete: vi.fn(async () => {}) }, browsers = { deleteByID: vi.fn(async () => {}) };
  const client = { auth: { connections }, profiles, browsers } as unknown as Kernel;
  const app = new Hono();
  app.onError((e, c) => c.json({ error: e.message }, 400));
  app.use('/v1/*', async (c, next) => { if (c.req.header('authorization') !== `Bearer ${token}`) return c.json({ error: 'unauthorized' }, 401); await next(); });
  registerRetailerRoutes(app, store, token, { client, now: () => at });
  const request = (domain = 'target.com', method = 'GET', body?: unknown, auth = true) => app.request(`/v1/retailers/${domain}/auth`, { method,
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { app, request, records, connections, profiles, browsers };
}

it('never starts login without owner authentication, explicit consent and a supported domain', async () => {
  const f = setup();
  expect((await f.request('target.com', 'POST', { consent: true }, false)).status).toBe(401);
  expect((await f.request('target.com', 'POST', { consent: false })).status).toBe(400);
  expect((await f.request('target.com', 'POST', { consent: true, connectionId: 'someone-else' })).status).toBe(400);
  expect((await f.request('evil.test', 'POST', { consent: true })).status).toBe(400);
  expect(f.connections.create).not.toHaveBeenCalled();
});
it('stores only opaque IDs privately and reuses one active flow', async () => {
  const f = setup();
  expect(await (await f.request()).json()).toEqual({ connected: false, status: 'NOT_CONNECTED' });
  const start = await (await f.request('target.com', 'POST', { consent: true })).json();
  expect(start).toMatchObject({ connected: false, status: 'NEEDS_AUTH', hostedUrl: 'https://login.kernel.sh/sensitive' });
  expect(start).not.toHaveProperty('connectionId');
  await f.request('target.com', 'POST', { consent: true });
  expect(f.connections.create).toHaveBeenCalledOnce(); expect(f.connections.login).toHaveBeenCalledOnce();
  expect(await store.getMerchantConnection('target.com')).toEqual({ merchant: 'target.com', connectionId: 'connection_1', createdAt: at });
  expect(JSON.stringify(await store.read())).not.toContain('kernel.sh');
  Object.assign(f.records.get('connection_1')!, { status: 'AUTHENTICATED', flow_status: 'SUCCESS', credential: { name: 'secret' } });
  const status = await (await f.request()).json();
  expect(status).toMatchObject({ connected: true }); expect(status).not.toHaveProperty('hostedUrl'); expect(status).not.toHaveProperty('credential');
});
it('enforces the three-connection local limit before an external create', async () => {
  const f = setup();
  for (const domain of ['walmart.com', 'amazon.com', 'kroger.com']) await store.setMerchantConnection({ merchant: domain, connectionId: domain, createdAt: at });
  expect((await f.request('target.com', 'POST', { consent: true })).status).toBe(409);
  expect(f.connections.create).not.toHaveBeenCalled();
});
it('disconnects saved account and cart sessions, invalidates approval and removes private IDs', async () => {
  const f = setup();
  f.records.set('owned', { id: 'owned', domain: 'target.com', profile_name: `aeri-${scope}-target-com`, status: 'AUTHENTICATED' });
  await store.setMerchantConnection({ merchant: 'target.com', connectionId: 'owned', createdAt: at });
  await store.setLiveView('cart', { sessionId: 'browser', url: 'https://live.kernel.sh/private' });
  await store.update(state => state.carts.push({ id: 'cart', origin: 'request', items: [], status: 'checkout_ready', checkoutUrl: 'https://www.target.com/cart', createdAt: at, updatedAt: at,
    checkout: { mode: 'kernel', sessionId: 'browser', openedAt: at, status: 'ready', lines: [], note: 'ready' },
    purchaseApproval: { id: 'approval', cartId: 'cart', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), maximumTotalCents: 500, createdAt: at, expiresAt: '2026-10-04T12:05:00.000Z', status: 'active' } }));
  expect(await (await f.request('target.com', 'DELETE')).json()).toEqual({ ok: true });
  expect(f.browsers.deleteByID).toHaveBeenCalledExactlyOnceWith('browser');
  expect(f.profiles.delete).toHaveBeenCalledWith(`aeri-${scope}-target-com`);
  expect(await store.getMerchantConnection('target.com')).toBeNull(); expect(await store.getLiveView('cart')).toBeNull();
  expect((await store.read()).carts[0]).toMatchObject({ status: 'approved', checkout: { status: 'failed', closedAt: at }, purchaseApproval: { status: 'invalidated' } });
});
it('keeps the saved record when disconnect cannot finish, so cleanup is retryable', async () => {
  const f = setup();
  f.records.set('owned', { id: 'owned', domain: 'target.com', profile_name: `aeri-${scope}-target-com`, status: 'AUTHENTICATED' });
  await store.setMerchantConnection({ merchant: 'target.com', connectionId: 'owned', createdAt: at });
  f.profiles.delete.mockRejectedValueOnce(new Error('profile is busy'));
  expect((await f.request('target.com', 'DELETE')).status).toBe(400);
  expect(await store.getMerchantConnection('target.com')).not.toBeNull();
  expect((await f.request('target.com', 'DELETE')).status).toBe(200);
  expect(await store.getMerchantConnection('target.com')).toBeNull();
});
