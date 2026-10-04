import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { emptyState, type AppState } from '@personal-agent/core';
import { entityKeys, entityRows, relatedRows, retainState, stateFromRows } from './persistence.js';
import { createStore, type Store } from './store.js';

const stores: Store[] = [], directories: string[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function local(options?: Parameters<typeof createStore>[2]) {
  const directory = await mkdtemp(join(tmpdir(), 'aeri-store-')); directories.push(directory);
  const store = createStore('', directory, options); stores.push(store); return { directory, store };
}
const at = '2026-10-04T10:00:00.000Z';

describe('durable store', () => {
  it('preserves legacy local state on reopening and serializes concurrent changes', async () => {
    const { directory, store } = await local();
    const legacy = emptyState(); legacy.preferences = { size: 'M' };
    await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
    expect(await store.read()).toEqual(legacy);
    await Promise.all(Array.from({ length: 15 }, (_, index) => store.update(async state => { state.messages.push({ id: String(index), role: 'user', content: `Hello ${index}`, createdAt: at }); })));
    const reopened = createStore('', directory); stores.push(reopened);
    expect((await reopened.read()).messages).toHaveLength(15);
    expect((await reopened.read()).preferences.size).toBe('M');
  });

  it('rolls back a rejected change and allows later updates', async () => {
    const { store } = await local();
    await expect(store.update(state => { state.preferences.size = 'L'; throw new Error('Rejected'); })).rejects.toThrow('Rejected');
    expect((await store.read()).preferences).toEqual({});
    await store.update(state => { state.preferences.size = 'M'; });
    expect((await store.read()).preferences.size).toBe('M');
  });

  it('never silently resets a corrupted local state', async () => {
    const { store, directory } = await local();
    await writeFile(join(directory, 'state.json'), '{broken');
    await expect(store.read()).rejects.toThrow();
    await expect(store.update(state => { state.preferences.size = 'M'; })).rejects.toThrow();
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe('{broken');
  });

  it('retains current tasks while capping history after every save', async () => {
    const { store } = await local({ retention: { events: 2, messages: 2, completedTasks: 1 } });
    await store.update(state => {
      state.events = [0, 1, 2].map(id => ({ id: String(id), type: 'inventory.updated', at, data: {} }));
      state.messages = [0, 1, 2].map(id => ({ id: String(id), role: 'user', content: 'Hi', createdAt: at }));
      state.tasks = [
        { id: 'recent', kind: 'cart', title: 'Done recently', status: 'done', createdAt: at, updatedAt: at },
        { id: 'running', kind: 'scan', title: 'Running', status: 'running', createdAt: at, updatedAt: at },
        { id: 'review', kind: 'scan', title: 'Review', status: 'needs_review', createdAt: at, updatedAt: at },
        { id: 'old', kind: 'cart', title: 'Old failed task', status: 'failed', createdAt: at, updatedAt: '2026-10-03T10:00:00.000Z' },
      ];
    });
    const state = await store.read();
    expect(state.events.map(event => event.id)).toEqual(['1', '2']);
    expect(state.messages.map(message => message.id)).toEqual(['1', '2']);
    expect(state.tasks.map(task => task.id)).toEqual(['recent', 'running', 'review']);
  });

  it('persists private session links across restart and removes expired links', async () => {
    let clock = new Date(at);
    const { store, directory } = await local({ now: () => clock });
    await store.setLiveView('cart-1', { sessionId: 'session-opaque', url: 'https://kernel.example/live/session-opaque' }, 1000);
    const restarted = createStore('', directory, { now: () => clock }); stores.push(restarted);
    expect((await restarted.getLiveView('cart-1'))?.sessionId).toBe('session-opaque');
    expect(JSON.stringify(await restarted.read())).not.toContain('kernel.example');
    expect((await stat(join(directory, 'private-sessions.json'))).mode & 0o777).toBe(0o600);
    clock = new Date(clock.getTime() + 1000);
    expect(await restarted.getLiveView('cart-1')).toBeNull();
    expect(await readFile(join(directory, 'private-sessions.json'), 'utf8')).not.toContain('session-opaque');
    await expect(store.setLiveView('cart-2', { sessionId: 'x', url: 'http://example.com' })).rejects.toThrow();
  });

  it('keeps only opaque retailer metadata outside public state', async () => {
    const { store, directory } = await local();
    await store.setMerchantConnection({ merchant: 'target.com', connectionId: 'connection-1', profileId: 'profile-1', createdAt: at });
    const restarted = createStore('', directory); stores.push(restarted);
    expect((await restarted.getMerchantConnection('target.com'))?.connectionId).toBe('connection-1');
    expect(JSON.stringify(await restarted.read())).not.toContain('connection-1');
    await restarted.deleteMerchantConnection('target.com');
    expect(await restarted.getMerchantConnection('target.com')).toBeNull();
  });

  it('deduplicates receipts across restart independently of retained events', async () => {
    let clock = new Date(at);
    const { store, directory } = await local({ now: () => clock, retention: { events: 0, messages: 0, completedTasks: 0 } });
    expect(await store.claimReceipt('receipt-1')).toBe(true);
    await store.update(state => { state.events.push({ id: 'receipt-1', type: 'email.received', at, data: {} }); });
    expect((await store.read()).events).toEqual([]);
    const restarted = createStore('', directory, { now: () => clock }); stores.push(restarted);
    expect(await restarted.claimReceipt('receipt-1')).toBe(false);
    const claims = await Promise.all(Array.from({ length: 5 }, () => restarted.claimReceipt('receipt-2')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    clock = new Date(clock.getTime() + 91 * 24 * 60 * 60_000);
    expect(await restarted.claimReceipt('receipt-1')).toBe(true);
  });

  it('persists purchase approval consumption across restart', async () => {
    const { store, directory } = await local();
    await store.update(state => state.carts.push({ id: 'cart-1', origin: 'request', items: [], status: 'checkout_ready', createdAt: at, updatedAt: at,
      purchaseApproval: { id: 'approval-1', cartId: 'cart-1', snapshotId: 'snapshot-1', snapshotHash: 'a'.repeat(64), maximumTotalCents: 1000, createdAt: at, expiresAt: '2026-10-04T10:01:00.000Z', status: 'active' } }));
    await store.update(state => { state.carts[0].purchaseApproval = { ...state.carts[0].purchaseApproval!, status: 'used', usedAt: at }; });
    const restarted = createStore('', directory); stores.push(restarted);
    const state = await restarted.read();
    expect(state.carts[0].purchaseApproval?.status).toBe('used');
    expect(relatedRows(state).approvals[0].body).toMatchObject({ id: 'approval-1', status: 'used' });
  });
});

describe('relational state mapping', () => {
  it('round trips every entity in order without collapsing records into one state row', () => {
    const state = emptyState(); state.preferences = { size: 'S' };
    state.messages = [{ id: 'second', role: 'assistant', content: 'Second', createdAt: at }, { id: 'first', role: 'user', content: 'First', createdAt: at }];
    const rows = Object.fromEntries(entityKeys.map(key => [key, entityRows(state, key).reverse()]));
    expect(stateFromRows(rows, state.preferences)).toEqual(state);
    state.messages.push(state.messages[0]);
    expect(() => entityRows(state, 'messages')).toThrow('Duplicate');
  });

  it('projects receipt and approval records separately and keeps an immutable input', () => {
    const state: AppState = emptyState();
    state.carts.push({ id: 'cart-1', origin: 'request', items: [], status: 'ordered', merchant: 'Target', orderReference: 'T-123', approvedAt: at, createdAt: at, updatedAt: at });
    state.events.push({ id: 'event-1', type: 'inventory.added', at, data: { name: 'Milk' } });
    const before = JSON.stringify(state), rows = relatedRows(state);
    expect(rows.cart_approvals[0].id).toBe('cart-1');
    expect(rows.orders[0].body).toMatchObject({ orderReference: 'T-123' });
    expect(rows.inventory_events).toHaveLength(1);
    retainState(state, { events: 0, messages: 0, completedTasks: 0 });
    expect(JSON.stringify(state)).toBe(before);
  });
});
