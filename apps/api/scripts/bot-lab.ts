/**
 * Bot-detection lab for Kernel browsers. Runs each browser configuration against real store pages and records
 * whether a bot check appeared, whether the product was readable, the exit IP and the browser fingerprint.
 *
 *   node --import tsx apps/api/scripts/bot-lab.ts            # all configurations, 2 rounds
 *   node --import tsx apps/api/scripts/bot-lab.ts c4 c7      # only some configurations
 *
 * Read-only: it opens product pages and never adds to a cart, signs in or checks out.
 */
import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Kernel from '@onkernel/sdk';
import type { BrowserCreateParams } from '@onkernel/sdk/resources/browsers/browsers';

loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });
const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const ROUNDS = Number(process.env.LAB_ROUNDS ?? 2);

type Setup = { id: string; label: string; create: () => Promise<BrowserCreateParams>; warm?: boolean; solveHold?: boolean; profile?: string };
let residential: string | undefined, isp: string | undefined, mobile: string | undefined;
async function proxy(type: 'residential' | 'isp' | 'mobile') {
  const name = `aeri-lab-${type}`;
  for await (const existing of client.proxies.list()) if (existing.name === name) return existing.id!;
  const created = await client.proxies.create({ type, name, config: type === 'residential' ? { country: 'US', os: 'windows' } : { country: 'US' } } as never);
  return created.id!;
}
const desktop = { width: 1280, height: 800 };
const setups: Setup[] = [
  { id: 'c1', label: 'stealth, default proxy, default 1920x1080 window', create: async () => ({ stealth: true, headless: false }) },
  { id: 'c2', label: 'stealth, default proxy, phone window 390x844 + kiosk (current)', create: async () => ({ stealth: true, headless: false, viewport: { width: 390, height: 844 }, kiosk_mode: true }) },
  { id: 'c3', label: 'stealth, default proxy, 1280x800 + kiosk', create: async () => ({ stealth: true, headless: false, viewport: desktop, kiosk_mode: true }) },
  { id: 'c4', label: 'stealth, US residential (windows) proxy, 1280x800 + kiosk', create: async () => ({ stealth: true, headless: false, viewport: desktop, kiosk_mode: true, proxy: { id: residential ??= await proxy('residential') } }) },
  { id: 'c5', label: 'stealth, US ISP proxy, 1280x800 + kiosk', create: async () => ({ stealth: true, headless: false, viewport: desktop, kiosk_mode: true, proxy: { id: isp ??= await proxy('isp') } }) },
  { id: 'c6', label: 'stealth, US mobile proxy, 1280x800 + kiosk', create: async () => ({ stealth: true, headless: false, viewport: desktop, kiosk_mode: true, proxy: { id: mobile ??= await proxy('mobile') } }) },
  { id: 'c7', label: 'c4 + warm-up (home page, human mouse and scroll) + press-and-hold solver + saved profile', warm: true, solveHold: true, profile: 'aeri-lab-warm',
    create: async () => ({ stealth: true, headless: false, viewport: desktop, kiosk_mode: true, proxy: { id: residential ??= await proxy('residential') } }) },
];

const pages = [
  { store: 'target', home: 'https://www.target.com/', product: 'https://www.target.com/s?searchTerm=black+tea+bags' },
  { store: 'walmart', home: 'https://www.walmart.com/', product: 'https://www.walmart.com/search?q=black+tea+bags' },
  { store: 'instacart', home: 'https://www.instacart.com/', product: 'https://www.instacart.com/store/s?k=black%20tea%20bags' },
];

const blockedText = /quick verification|press (&|and) hold|robot or human|verify (you are|you're) (a )?human|are you a robot|access denied|just a moment|unusual (activity|traffic)|pardon our interruption|blocked/i;
const inspect = `
const title = await page.title().catch(() => '');
const text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 4000);
const hold = await page.locator('#px-captcha').boundingBox().catch(() => null);
const prices = (text.match(/\\$\\s?\\d+\\.\\d{2}/g) || []).length;
return { url: page.url(), title, prices, hold, text: text.slice(0, 300) };`;
const fingerprint = `
return await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl');
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return { ua: navigator.userAgent, webdriver: navigator.webdriver, platform: navigator.platform, languages: navigator.languages, cores: navigator.hardwareConcurrency,
    memory: navigator.deviceMemory, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, screen: [screen.width, screen.height], window: [innerWidth, innerHeight],
    gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null, uaData: navigator.userAgentData ? navigator.userAgentData.platform : null };
});`;

const run = async (session: string, code: string, timeout = 60) => {
  const result = await client.browsers.playwright.execute(session, { code, timeout_sec: timeout }).catch(error => ({ success: false, error: (error as Error).message, result: undefined }));
  if (!result.success) throw new Error(String(result.error ?? 'step failed').slice(0, 160));
  return result.result as Record<string, unknown>;
};
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const jitter = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

/** Human-looking mouse wander and scroll with OS-level input, which page scripts can't tell from a person. */
async function humanize(session: string) {
  await client.browsers.computer.batch(session, { actions: [
    { type: 'move_mouse', move_mouse: { x: jitter(300, 900), y: jitter(200, 600), duration_ms: jitter(500, 1100) } },
    { type: 'sleep', sleep: { duration_ms: jitter(400, 900) } },
    { type: 'scroll', scroll: { x: jitter(400, 800), y: jitter(300, 500), delta_x: 0, delta_y: jitter(3, 6) } },
    { type: 'sleep', sleep: { duration_ms: jitter(600, 1400) } },
    { type: 'move_mouse', move_mouse: { x: jitter(200, 1000), y: jitter(150, 650), duration_ms: jitter(500, 1200) } },
    { type: 'scroll', scroll: { x: jitter(400, 800), y: jitter(300, 500), delta_x: 0, delta_y: -jitter(2, 4) } },
  ] } as never).catch(() => undefined);
}

/** Press and hold the challenge button with a real mouse: move there smoothly, press, hold ~9 s, release. */
async function pressAndHold(session: string, box: { x: number; y: number; width: number; height: number }) {
  const x = Math.round(box.x + box.width / 2 + jitter(-12, 12)), y = Math.round(box.y + box.height / 2 + jitter(-4, 4));
  await client.browsers.computer.batch(session, { actions: [
    { type: 'move_mouse', move_mouse: { x, y, duration_ms: jitter(700, 1300) } },
    { type: 'sleep', sleep: { duration_ms: jitter(200, 500) } },
    { type: 'click_mouse', click_mouse: { x, y, click_type: 'down' } },
    { type: 'sleep', sleep: { duration_ms: jitter(8500, 10500) } },
    { type: 'click_mouse', click_mouse: { x, y, click_type: 'up' } },
  ] } as never);
  await sleep(5000);
}

type Visit = { store: string; outcome: 'ok' | 'blocked' | 'blocked→solved' | 'error' | 'unclear'; prices?: number; title?: string; note?: string };
async function trial(setup: Setup, round: number) {
  const started = Date.now();
  let params = await setup.create();
  if (setup.profile) params = { ...params, profile: { name: setup.profile, save_changes: true } };
  let browser;
  try { browser = await client.browsers.create({ ...params, timeout_seconds: 300 }); }
  catch (error) { if (setup.profile && /profile/i.test((error as Error).message)) { await client.profiles.create({ name: setup.profile }).catch(() => undefined); browser = await client.browsers.create({ ...params, timeout_seconds: 300 }); } else throw error; }
  const session = browser.session_id;
  const visits: Visit[] = [];
  let ip: unknown = null, print: unknown = null;
  try {
    ip = await run(session, `await page.goto('https://ipinfo.io/json', { timeout: 30000 }); return JSON.parse(await page.locator('body').innerText());`).then(r => ({ ip: r.ip, city: r.city, region: r.region, org: r.org })).catch(e => ({ error: (e as Error).message }));
    print = await run(session, `await page.goto('about:blank'); ${fingerprint}`).catch(e => ({ error: (e as Error).message }));
    for (const target of pages) {
      try {
        if (setup.warm) {
          await run(session, `await page.goto(${JSON.stringify(target.home)}, { waitUntil: 'domcontentloaded', timeout: 45000 }); return page.url();`);
          await sleep(jitter(2500, 4500)); await humanize(session); await sleep(jitter(1500, 3000));
        }
        await run(session, `await page.goto(${JSON.stringify(target.product)}, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(6000); return page.url();`, 70);
        if (setup.warm) await humanize(session);
        let seen = await run(session, inspect);
        let blocked = blockedText.test(`${seen.title} ${seen.text}`) || !!seen.hold;
        let outcome: Visit['outcome'] = blocked ? 'blocked' : Number(seen.prices) > 0 ? 'ok' : 'unclear';
        if (blocked && setup.solveHold && seen.hold) {
          await pressAndHold(session, seen.hold as { x: number; y: number; width: number; height: number });
          seen = await run(session, inspect);
          blocked = blockedText.test(`${seen.title} ${seen.text}`) || !!seen.hold;
          outcome = blocked ? 'blocked' : 'blocked→solved';
        }
        visits.push({ store: target.store, outcome, prices: Number(seen.prices), title: String(seen.title).slice(0, 70), ...(outcome === 'unclear' ? { note: String(seen.text).slice(0, 140) } : {}) });
      } catch (error) { visits.push({ store: target.store, outcome: 'error', note: (error as Error).message }); }
    }
  } finally { await client.browsers.deleteByID(session).catch(() => undefined); }
  return { setup: setup.id, label: setup.label, round, seconds: Math.round((Date.now() - started) / 1000), ip, fingerprint: print, visits };
}

const only = process.argv.slice(2);
const chosen = setups.filter(s => !only.length || only.includes(s.id));
const results: Awaited<ReturnType<typeof trial>>[] = [];
for (let round = 1; round <= ROUNDS; round++) {
  // Three at a time keeps the run short without opening a burst of sessions from one account.
  for (let i = 0; i < chosen.length; i += 3) {
    const batch = await Promise.all(chosen.slice(i, i + 3).map(setup => trial(setup, round).catch(error => ({ setup: setup.id, label: setup.label, round, seconds: 0, ip: null, fingerprint: null, visits: [{ store: '*', outcome: 'error' as const, note: (error as Error).message.slice(0, 200) }] }))));
    for (const r of batch) {
      results.push(r);
      console.log(`${r.setup} r${round} ${r.seconds}s ${JSON.stringify((r.ip as { org?: string; city?: string }) ?? {})}`);
      for (const v of r.visits) console.log(`   ${v.store.padEnd(9)} ${v.outcome.padEnd(15)} prices=${v.prices ?? '-'} ${v.title ?? ''} ${v.note ?? ''}`);
    }
  }
}
const out = resolve(import.meta.dirname, '../../../.data-preview/bot-lab');
await mkdir(out, { recursive: true });
const file = resolve(out, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
await writeFile(file, JSON.stringify(results, null, 2));
console.log('\nSUMMARY (ok or solved / visits)');
for (const setup of chosen) {
  const visits = results.filter(r => r.setup === setup.id).flatMap(r => r.visits);
  const good = visits.filter(v => v.outcome === 'ok' || v.outcome === 'blocked→solved').length;
  const by = (store: string) => visits.filter(v => v.store === store).map(v => v.outcome[0]).join('');
  console.log(`${setup.id} ${good}/${visits.length}  target:${by('target')} walmart:${by('walmart')} instacart:${by('instacart')}  ${setup.label}`);
}
console.log(`\nSaved ${file}`);
