import Kernel from '@onkernel/sdk';
import { describe, expect, it, vi } from 'vitest';
import { beginMerchantAuth, disconnectMerchantAuth, merchantAuthStatus, merchantBrowserOptions, retailerDomain } from './merchant-auth.js';
import { normalizeMerchantSummary, merchantSummaryScript, readMerchantSummary } from './merchant-summary.js';
import { selectStore } from './merchant-store.js';
import { addScript } from './market.js';

const store = 'https://www.target.com', at = '2026-10-04T18:00:00Z';
const connection = { id: 'con_1', domain: 'target.com', profile_name: 'aeri-owner-target-com', status: 'NEEDS_AUTH' };
function fakeClient(items: unknown[] = [], overrides: object = {}) {
  const connections = { list: vi.fn(() => (async function* () { for (const item of items) yield item; })()), create: vi.fn(async () => connection),
    retrieve: vi.fn(async () => connection), login: vi.fn(async () => ({ hosted_url: 'https://login.kernel.sh/private', flow_expires_at: '2099-01-01T00:00:00Z' })), delete: vi.fn(async () => {}), ...overrides };
  const profiles = { delete: vi.fn(async () => {}) };
  return { client: { auth: { connections }, profiles } as unknown as Kernel, connections, profiles };
}
describe('managed retailer authentication', () => {
  it('requires explicit consent and prevents foreign or non-HTTPS domains', async () => {
    const f = fakeClient();
    await expect(beginMerchantAuth(f.client, store, 'owner', false)).rejects.toThrow('consent');
    expect(f.connections.list).not.toHaveBeenCalled();
    expect(() => retailerDomain('https://target.com.evil.test')).toThrow('supported');
    expect(() => retailerDomain('http://target.com')).toThrow('HTTPS');
  });
  it('creates one scoped connection and never accepts passwords or saves credentials', async () => {
    const f = fakeClient();
    const state = await beginMerchantAuth(f.client, store, 'owner', true);
    expect(f.connections.create).toHaveBeenCalledWith(expect.objectContaining({ domain: 'target.com', profile_name: 'aeri-owner-target-com', save_credentials: false, health_checks: false, auto_reauth: false }));
    expect(state).toMatchObject({ connectionId: 'con_1', flowStatus: 'IN_PROGRESS', hostedUrl: 'https://login.kernel.sh/private' });
    expect(state).not.toHaveProperty('profile_name');
  });
  it('reuses an active hosted login instead of superseding it', async () => {
    const f = fakeClient([{ ...connection, flow_status: 'IN_PROGRESS', flow_expires_at: '2099-01-01T00:00:00Z', hosted_url: 'https://login.kernel.sh/original' }]);
    expect(await beginMerchantAuth(f.client, store, 'owner', true)).toMatchObject({ hostedUrl: 'https://login.kernel.sh/original' });
    expect(f.connections.create).not.toHaveBeenCalled(); expect(f.connections.login).not.toHaveBeenCalled();
  });
  it('loads only the authenticated saved retailer profile and preserves its proxy', async () => {
    const f = fakeClient([], { retrieve: vi.fn(async () => ({ ...connection, status: 'AUTHENTICATED', flow_status: 'SUCCESS', browser: { proxy: { id: 'proxy_1' } } })) });
    expect(await merchantBrowserOptions(f.client, store, 'con_1')).toMatchObject({ profile: { name: 'aeri-owner-target-com', save_changes: true }, proxy: { id: 'proxy_1' }, headless: false });
    await expect(merchantBrowserOptions(f.client, 'https://walmart.com', 'con_1')).rejects.toThrow('another retailer');
    const pending = fakeClient();
    await expect(merchantBrowserOptions(pending.client, store, 'con_1')).rejects.toThrow('Complete');
  });
  it('returns sanitized status and disconnects only the owner’s profile', async () => {
    const f = fakeClient([], { retrieve: vi.fn(async () => ({ ...connection, credential: { name: 'private' }, live_view_url: 'private' })) });
    expect(await merchantAuthStatus(f.client, 'con_1', store)).not.toHaveProperty('credential');
    await expect(disconnectMerchantAuth(f.client, 'con_1', store, 'other')).rejects.toThrow('this account');
    expect(f.connections.delete).not.toHaveBeenCalled();
    await disconnectMerchantAuth(f.client, 'con_1', store, 'owner');
    expect(f.profiles.delete).toHaveBeenCalledWith('aeri-owner-target-com');
  });
});

const complete = { url: `${store}/checkout`, currency: 'USD', lines: [{ name: 'Milk', quantity: 2, unitPriceCents: 300, lineTotalCents: 600 }],
  subtotalCents: 600, taxCents: 30, feesCents: 100, tipCents: 0, discountCents: 0, totalCents: 730, fulfillment: 'pickup', locationKey: 'Observed Store 42' };
describe('read-only merchant summary', () => {
  it('requires observed final totals, every line, fulfillment and location', () => {
    expect(normalizeMerchantSummary(complete, store, at)).toMatchObject({ complete: true, totalCents: 730 });
    for (const key of ['tipCents', 'discountCents', 'feesCents', 'fulfillment', 'locationKey']) {
      const raw = { ...complete, [key]: undefined };
      expect(normalizeMerchantSummary(raw, store, at).complete).toBe(false);
      expect(normalizeMerchantSummary(raw, store, at)[key as keyof typeof complete]).toBeUndefined();
    }
    expect(normalizeMerchantSummary({ ...complete, totalCents: 750 }, store, at).complete).toBe(false);
    expect(normalizeMerchantSummary({ ...complete, lines: [{ name: 'Milk', quantity: 1, unitPriceCents: 300, lineTotalCents: 600 }] }, store, at).complete).toBe(false);
    expect(normalizeMerchantSummary({ ...complete, url: `${store}/cart` }, store, at).complete).toBe(false);
  });
  it('does not accept another merchant or a model claim of completeness', () => {
    expect(normalizeMerchantSummary({ ...complete, url: 'https://evil.test/checkout', complete: true }, store, at)).toMatchObject({ complete: false, lines: [] });
    expect(normalizeMerchantSummary({ url: `${store}/checkout`, lines: [], complete: true }, store, at).complete).toBe(false);
    const script = merchantSummaryScript(store);
    expect(script).not.toMatch(/page\.(goto|click)|\.click\(|\.fill\(/);
  });
  it('reads the existing session once without opening another browser', async () => {
    const execute = vi.fn(async (_session: string, _options: unknown) => ({ success: true, result: complete }));
    const client = { browsers: { playwright: { execute } } } as unknown as Kernel;
    expect((await readMerchantSummary(client, 'session_1', store, () => at)).complete).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toBe('session_1');
  });
  it('parses exact total labels without confusing total fees with the order total', async () => {
    const page = { url: () => `${store}/checkout`, locator: (selector: string) => ({
      innerText: async () => 'Subtotal\n$6.00\nTotal fees\n$1.00\nTax\n$0.30\nNo tip\nNo discount\nTotal\n$7.30',
      count: async () => 0, allTextContents: async () => selector.includes('fulfillment') ? ['pickup'] : selector.includes('location') ? ['Observed Store 42'] : [],
    }) };
    const run = new (Object.getPrototypeOf(async function() {}).constructor)('page', merchantSummaryScript(store));
    expect(await run(page)).toMatchObject({ subtotalCents: 600, feesCents: 100, taxCents: 30, tipCents: 0, discountCents: 0, totalCents: 730 });
  });
});

describe('approved quantities', () => {
  const execute = (script: string, page: unknown) => new (Object.getPrototypeOf(async function() {}).constructor)('page', script)(page);
  function fakePage(supported: boolean, accepted: boolean) {
    let value = '1', added = false; const click = vi.fn(async () => { added = true; });
    const quantity = { first() { return this; }, count: async () => supported ? 1 : 0, evaluate: async () => 'select', selectOption: async (v: string) => { if (accepted) value = v; }, inputValue: async () => value };
    const button = { first() { return this; }, waitFor: async () => {}, count: async () => 1, isDisabled: async () => false, click };
    return { click, page: { url: () => `${store}/p/milk`, goto: async () => {}, waitForTimeout: async () => {}, title: async () => 'Milk', getByRole: () => button,
      locator: (name: string) => name === 'body' ? { innerText: async () => added ? 'Added to your cart' : 'Milk $3.00. View cart' } : quantity } };
  }
  it('sets and verifies requested packs before clicking add', async () => {
    const f = fakePage(true, true);
    expect(await execute(addScript(`${store}/p/milk`, 3), f.page)).toMatchObject({ result: 'added', confirmedPacks: 3 });
    expect(f.click).toHaveBeenCalledOnce();
  });
  it('does not add one pack when an approved quantity cannot be set', async () => {
    for (const f of [fakePage(false, true), fakePage(true, false)]) {
      expect(await execute(addScript(`${store}/p/milk`, 3), f.page)).toMatchObject({ result: 'uncertain' });
      expect(f.click).not.toHaveBeenCalled();
    }
    expect(() => addScript(`${store}/p/milk`, 0)).toThrow('pack count');
  });
  it('stops on retailer redirects and resets a supported quantity control even for one pack', async () => {
    const redirected = fakePage(true, true); redirected.page.url = () => 'https://evil.test/p/milk';
    expect(await execute(addScript(`${store}/p/milk`, 1), redirected.page)).toMatchObject({ result: 'uncertain' });
    expect(redirected.click).not.toHaveBeenCalled();
    const checkout = fakePage(true, true); checkout.page.url = () => `${store}/checkout/p/milk`;
    expect(await execute(addScript(`${store}/p/milk`, 1), checkout.page)).toMatchObject({ result: 'uncertain' });
    expect(checkout.click).not.toHaveBeenCalled();
    const f = fakePage(true, true);
    expect(await execute(addScript(`${store}/p/milk`, 1), f.page)).toMatchObject({ result: 'added', confirmedPacks: 1 });
  });
  it('does not pretend unsupported store selection works', async () => {
    const browser = { execute: vi.fn() };
    const client = { browsers: { playwright: browser } } as unknown as Kernel;
    expect(await selectStore(client, 'session', 'https://walmart.com', '94103')).toMatchObject({ status: 'unsupported', requestedZip: '94103' });
    expect(browser.execute).not.toHaveBeenCalled();
    await expect(selectStore(client, 'session', store, 'bad')).rejects.toThrow('ZIP');
  });
});
