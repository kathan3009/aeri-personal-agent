import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Kernel from '@onkernel/sdk';
import { launchOptions, recordOutcome, siteSetup } from './site-config.js';

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aeri-sites-')); vi.stubEnv('DATA_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });
const rec = (stealth: boolean, type: string) => ({ type: 'recommendation', match_scope: 'exact', matched_target: 'x', evidence: { success_rate: 1 },
  browser: { stealth, headless: false, gpu: false, viewport: { width: 1920, height: 1080 } }, proxy: { mode: 'managed', create: { type, config: { country: 'US' } } } });
const fake = (working: unknown[]) => {
  const proxies: Array<{ id: string; name: string }> = [];
  return { proxies, client: {
    configRegistry: { lookup: vi.fn(async () => ({ working_configurations: working })), resolve: vi.fn(async () => ({})) },
    proxies: { list: () => (async function* () { yield* proxies; })(), create: vi.fn(async ({ name }: { name: string }) => { const p = { id: `px_${proxies.length + 1}`, name }; proxies.push(p); return p; }) },
  } as unknown as Kernel };
};

describe('per-site browser setups', () => {
  it('uses Kernel’s recommended setup for the store, and launches it with a reusable proxy', async () => {
    const f = fake([rec(false, 'isp'), rec(true, 'residential')]);
    const setup = await siteSetup(f.client, 'https://www.target.com/p/x');
    expect(setup).toMatchObject({ domain: 'target.com', label: 'isp+headful', source: 'registry' });
    const options = await launchOptions(f.client, setup, { timeout_seconds: 60 });
    expect(options).toEqual({ stealth: false, headless: false, viewport: { width: 1920, height: 1080 }, proxy: { id: 'px_1' }, timeout_seconds: 60 });
    await launchOptions(f.client, setup);
    expect(f.proxies).toHaveLength(1);
  });
  it('moves to the next working setup after two blocks, and back after a success resets the count', async () => {
    const f = fake([rec(false, 'isp'), rec(true, 'residential')]);
    const first = await siteSetup(f.client, 'https://www.walmart.com/');
    await recordOutcome('walmart.com', first.label, true);
    expect((await siteSetup(f.client, 'https://www.walmart.com/')).label).toBe('isp+headful');
    await recordOutcome('walmart.com', first.label, true);
    expect((await siteSetup(f.client, 'https://www.walmart.com/')).label).toBe('residential+stealth+headful');
  });
  it('asks Kernel to analyse an unknown store and uses Aeri’s tested fallback meanwhile', async () => {
    const f = fake([]);
    const setup = await siteSetup(f.client, 'https://shop.example.com/');
    expect(setup).toMatchObject({ source: 'fallback', label: 'residential+stealth+headful' });
    expect((f.client.configRegistry.resolve as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
