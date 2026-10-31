import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type Kernel from '@onkernel/sdk';
import type { BrowserCreateParams } from '@onkernel/sdk/resources/browsers/browsers';
import { retailerDomain } from './merchant-auth.js';

/**
 * Per-site browser settings. Each store protects itself differently (Target's reCAPTCHA fails when a CAPTCHA solver
 * is on; Walmart's Akamai and HUMAN checks want stealth), so one setup can't fit all. Aeri asks Kernel's Config
 * Registry which browser and proxy reliably reach the site, uses that, and learns from real runs: a setup that gets
 * blocked twice is skipped in favour of the next working one.
 */
export type SiteSetup = {
  domain: string; label: string; source: 'registry' | 'fallback';
  browser: { stealth: boolean; headless: boolean; gpu: boolean; viewport?: { width: number; height: number } };
  proxy: { mode: 'direct' } | { mode: 'managed'; type: 'datacenter' | 'isp' | 'residential' | 'mobile'; country?: string; id?: string } | { mode: 'default' };
};
type Ledger = Record<string, { setups: SiteSetup[]; checkedAt: string; failures: Record<string, number>; successes: Record<string, number> }>;

const STALE_MS = 3 * 86_400_000;
const MAX_FAILURES = 2;
// Used only when the registry has no answer: the setup that reached every store in Aeri's own tests.
const fallbacks = (domain: string): SiteSetup[] => [
  { domain, label: 'residential+stealth+headful', source: 'fallback', browser: { stealth: true, headless: false, gpu: false, viewport: { width: 1280, height: 800 } }, proxy: { mode: 'managed', type: 'residential', country: 'US' } },
  { domain, label: 'isp+headful', source: 'fallback', browser: { stealth: false, headless: false, gpu: false, viewport: { width: 1920, height: 1080 } }, proxy: { mode: 'managed', type: 'isp', country: 'US' } },
  { domain, label: 'default+stealth+headful', source: 'fallback', browser: { stealth: true, headless: false, gpu: false }, proxy: { mode: 'default' } },
];

const file = () => resolve(import.meta.dirname, '../../../', process.env.DATA_DIR ?? '.data', 'site-setups.json');
let queue: Promise<unknown> = Promise.resolve();
const locked = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };
const load = async (): Promise<Ledger> => { try { return JSON.parse(await readFile(file(), 'utf8')) as Ledger; } catch { return {}; } };
const save = async (ledger: Ledger) => { await mkdir(dirname(file()), { recursive: true }); await writeFile(`${file()}.tmp`, JSON.stringify(ledger, null, 2), { mode: 0o600 }); await rename(`${file()}.tmp`, file()); };

const labelOf = (browser: SiteSetup['browser'], proxy: SiteSetup['proxy']) =>
  [proxy.mode === 'managed' ? proxy.type : proxy.mode === 'direct' ? 'direct' : 'default', browser.stealth ? 'stealth' : '', browser.headless ? 'headless' : 'headful'].filter(Boolean).join('+');

/** Kernel's known working setups for this site, best first. Side-effect free; refreshes in the background when empty. */
async function fromRegistry(client: Kernel, url: string, domain: string): Promise<SiteSetup[]> {
  const found = await client.configRegistry.lookup({ url, allowed_proxy_countries: ['US'] }).catch(() => null);
  const setups = (found?.working_configurations ?? []).map(rec => {
    const browser = { stealth: rec.browser.stealth, headless: rec.browser.headless, gpu: rec.browser.gpu, viewport: rec.browser.viewport ? { width: rec.browser.viewport.width, height: rec.browser.viewport.height } : undefined };
    const proxy: SiteSetup['proxy'] = rec.proxy.mode === 'managed'
      ? { mode: 'managed', type: rec.proxy.create.type as 'isp', country: (rec.proxy.create.config as { country?: string } | undefined)?.country ?? 'US' }
      : { mode: 'direct' };
    return { domain, label: labelOf(browser, proxy), source: 'registry' as const, browser, proxy };
  });
  // Nothing known yet: ask Kernel to analyse the store (a cart-filling workload) for next time.
  if (!setups.length) void client.configRegistry.resolve({ url, allowed_proxy_countries: ['US'], intent: 'Search for a grocery product and add it to the cart. Do not sign in or check out.' }).catch(() => undefined);
  return setups.filter((setup, i, all) => all.findIndex(other => other.label === setup.label) === i);
}

/** One reusable Kernel proxy per type and country; proxies are created once and kept. */
const proxyIds = new Map<string, string>();
async function proxyId(client: Kernel, type: string, country = 'US') {
  const name = `aeri-${type}-${country.toLowerCase()}`;
  if (proxyIds.has(name)) return proxyIds.get(name)!;
  for await (const existing of client.proxies.list()) if (existing.name === name && existing.id) { proxyIds.set(name, existing.id); return existing.id; }
  const created = await client.proxies.create({ type, name, config: { country } } as never);
  proxyIds.set(name, created.id!);
  return created.id!;
}

/** The setup to use for this store now: the best known one that hasn't been blocked repeatedly. */
export async function siteSetup(client: Kernel, storeUrl: string): Promise<SiteSetup> {
  if (!refresh) onRepeatedBlocks(client);
  const domain = retailerDomain(storeUrl);
  const url = `https://www.${domain}/`;
  return locked(async () => {
    const ledger = await load();
    let entry = ledger[domain];
    if (!entry || Date.now() - Date.parse(entry.checkedAt) > STALE_MS) {
      const setups = [...await fromRegistry(client, url, domain), ...fallbacks(domain)].filter((setup, i, all) => all.findIndex(other => other.label === setup.label) === i);
      entry = { setups, checkedAt: new Date().toISOString(), failures: entry?.failures ?? {}, successes: entry?.successes ?? {} };
      ledger[domain] = entry; await save(ledger);
    }
    const usable = entry.setups.filter(setup => (entry!.failures[setup.label] ?? 0) < MAX_FAILURES);
    // Everything has been blocked lately: start over from the best-known setup rather than give up.
    if (!usable.length) { entry.failures = {}; await save(ledger); }
    return (usable[0] ?? entry.setups[0]);
  });
}

/** Browser launch options for a setup. A saved store sign-in keeps the proxy it signed in with, so the IP stays put. */
export async function launchOptions(client: Kernel, setup: SiteSetup, extra: Partial<BrowserCreateParams> = {}): Promise<BrowserCreateParams> {
  const proxy = setup.proxy.mode === 'managed' ? { proxy: { id: setup.proxy.id ?? await proxyId(client, setup.proxy.type, setup.proxy.country) } }
    : setup.proxy.mode === 'direct' ? { proxy: { mode: 'direct' as const } } : {};
  return { stealth: setup.browser.stealth, headless: setup.browser.headless, ...(setup.browser.gpu ? { gpu: true } : {}), ...(setup.browser.viewport ? { viewport: setup.browser.viewport } : {}), ...proxy, ...extra };
}

/** What happened when Aeri used a setup on a real page. Two blocks move the store to its next working setup. */
let refresh: ((url: string) => Promise<unknown>) | null = null;
/** Lets recordOutcome request a Kernel re-analysis (set once a Kernel client exists). */
export const onRepeatedBlocks = (client: Kernel) => { refresh = url => client.configRegistry.resolve({ url, allowed_proxy_countries: ['US'], intent: 'Sign in, search for a grocery product and add it to the cart. Do not check out.' }); };
export function recordOutcome(domain: string, label: string, blocked: boolean): Promise<void> {
  return locked(async () => {
    const ledger = await load();
    const entry = ledger[domain];
    if (!entry) return;
    if (blocked) {
      entry.failures[label] = (entry.failures[label] ?? 0) + 1;
      // A store that starts blocking gets a fresh Kernel analysis of the real workload, so the next setup is evidence-based.
      if (entry.failures[label] === MAX_FAILURES && refresh) void refresh(`https://www.${domain}/`).catch(() => undefined);
    }
    else { entry.successes[label] = (entry.successes[label] ?? 0) + 1; entry.failures[label] = 0; }
    await save(ledger);
  });
}

/** For Settings and diagnostics: what Aeri currently uses for each store, and how it has gone. */
export async function siteSetupReport() {
  const ledger = await load();
  return Object.entries(ledger).map(([domain, entry]) => {
    const current = entry.setups.find(setup => (entry.failures[setup.label] ?? 0) < MAX_FAILURES) ?? entry.setups[0];
    return { domain, using: current?.label, source: current?.source, successes: entry.successes, failures: entry.failures, checkedAt: entry.checkedAt };
  });
}

export const botCheck = /quick verification|press (&|and) hold|robot or human|verify (you are|you're) (a )?human|are you a robot|access denied|pardon our interruption|unusual (activity|traffic)/i;
