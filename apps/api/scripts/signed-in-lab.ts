/**
 * Signed-in cart test, run with the owner's permission: fills the owner's real store cart with two test items through
 * Aeri's own cart path (never checkout), records bot checks, then removes only the items that weren't there before.
 *
 *   node --import tsx apps/api/scripts/signed-in-lab.ts target instacart
 */
import { config as loadEnv } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });
const { default: Kernel } = await import('@onkernel/sdk');
const { createStore } = await import('../src/store.js');
const { discoverProducts, closeSession } = await import('../src/market.js');
const { runShoppingAgent } = await import('../src/shopping-agent.js');
const { merchantBrowserOptions } = await import('../src/merchant-auth.js');
const { siteSetup, launchOptions, siteSetupReport } = await import('../src/site-config.js');

const client = new Kernel({ apiKey: process.env.KERNEL_API_KEY!, timeout: 240_000 });
// Local files only; never the configured Postgres database.
const store = createStore('', '.data-preview/expo-live');
const shots = resolve(import.meta.dirname, '../../../.data-preview/bot-lab');
await mkdir(shots, { recursive: true });

type Plan = { url: string; cart: string; tests: Array<{ name: string; keyword: string; search?: string }> };
const plans: Record<string, Plan> = {
  target: { url: 'https://www.target.com/', cart: 'https://www.target.com/cart', tests: [{ name: 'Lipton black tea bags', keyword: 'lipton', search: 'Lipton black tea bags 100ct' }, { name: 'Granulated sugar', keyword: 'sugar', search: 'Market Pantry granulated sugar' }] },
  instacart: { url: 'https://www.instacart.com/', cart: 'https://www.instacart.com/store', tests: [{ name: 'Lipton black tea bags', keyword: 'lipton' }, { name: 'Granulated sugar', keyword: 'sugar' }] },
};

// Target: the cart badge count from the home page (its cart page draws a bot check). Instacart: each shop's cart,
// opened from a shop's storefront, with items named by Instacart's own "Remove <item>" buttons. Cleanup removes only
// labels that weren't there before; Target cleanup is left to the person if the badge went up.
const snapshotCode = (plan: Plan, removeNew?: Record<string, string[]>) => plan.url.includes('target') ? `
await page.goto('https://www.target.com/', { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
let label = '';
for (let i = 0; i < 3 && !label; i++) { label = await page.locator('[data-test="@web/CartLink"]').first().getAttribute('aria-label', { timeout: 10000 }).catch(() => '') || ''; if (!label) await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined); }
// The badge shows 0 until the account loads; read it again after a pause.
await page.waitForTimeout(5000); label = await page.locator('[data-test="@web/CartLink"]').first().getAttribute('aria-label').catch(() => label) || label;
return { carts: { 'target.com': [label || 'unknown'] }, removed: [] };` : `
const removeNew = ${JSON.stringify(removeNew ?? null)};
const carts = {}; const removed = [];
const labels = async scope => (await scope.getByRole('button', { name: /^remove /i }).evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim()))).filter(Boolean);
const slugs = ['raleys', 'walmart', 'lucky-supermarkets', 'target-corp'];
const seen = new Set();
for (const slug of slugs) {
  await page.goto('https://www.instacart.com/store/' + slug + '/storefront', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => undefined); await page.waitForTimeout(5000);
  await page.getByRole('button', { name: /view cart|items in cart|cart/i }).first().click({ timeout: 8000 }).catch(() => undefined); await page.waitForTimeout(4000);
  const scope = page.getByRole('dialog').first();
  const name = ((await scope.innerText().catch(() => '')).match(/Personal (.+?) Cart/) || [])[1];
  if (!name || seen.has(name)) continue;
  seen.add(name);
  if (removeNew) {
    const keep = removeNew[name] || [];
    for (let round = 0; round < 8; round++) {
      const target = (await labels(scope)).find(l => !keep.includes(l));
      if (!target) break;
      await scope.getByRole('button', { name: target, exact: true }).first().click({ timeout: 8000 }).catch(() => undefined); removed.push(name + ': ' + target); await page.waitForTimeout(3000);
    }
  }
  carts[name] = await labels(scope);
}
return { carts, removed };`;

async function shot(session: string, name: string) {
  const response = await client.browsers.computer.captureScreenshot(session).catch(() => null);
  if (response) await writeFile(resolve(shots, `${name}.png`), Buffer.from(await response.arrayBuffer()));
}
const execute = async (session: string, code: string) => { const r = await client.browsers.playwright.execute(session, { code, timeout_sec: 200 }); if (!r.success) throw new Error(String(r.error).slice(0, 200)); return r.result as Record<string, unknown>; };
async function withCart<T>(plan: Plan, connectionId: string, work: (session: string) => Promise<T>) {
  const setup = await siteSetup(client, plan.url);
  const browser = await client.browsers.create({ ...(await merchantBrowserOptions(client, plan.url, connectionId, await launchOptions(client, setup))), timeout_seconds: 300 });
  try { return await work(browser.session_id); } finally { await client.browsers.deleteByID(browser.session_id).catch(() => undefined); }
}

const only = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
for (const [name, plan] of Object.entries(plans).filter(([n]) => !only.length || only.includes(n))) {
  const domain = new URL(plan.url).hostname.replace(/^www\./, '');
  const connection = await store.getMerchantConnection(domain);
  if (!connection) { console.log(`${name}: not signed in`); continue; }
  console.log(`\n${name.toUpperCase()} (signed in)`);
  const before = await withCart(plan, connection.connectionId, session => execute(session, snapshotCode(plan))) as { carts: Record<string, string[]> };
  // Read-only: list every cart's items and stop (no shopping, no removal).
  if (process.argv.includes('--snapshot')) { console.log(JSON.stringify(before.carts, null, 1)); continue; }
  console.log(`  before: ${Object.entries(before.carts).map(([cart, items]) => `${cart}=${items.length}`).join(', ') || 'no carts'}`);
  // LAB_ITEM tries one item of your choice instead of the plan's (for example an age-restricted one).
  if (process.env.LAB_ITEM) plan.tests = [{ name: process.env.LAB_ITEM, keyword: process.env.LAB_ITEM.split(' ')[0].toLowerCase() }];
  const lines = await Promise.all(plan.tests.slice(0, Number(process.env.LAB_ITEMS ?? plan.tests.length)).map(async (test, i) => {
    const hit = test.search ? (await discoverProducts(test.search, [domain], 3)).find(h => /\/(p|ip|dp)\//.test(new URL(h.url).pathname)) : undefined;
    return { itemId: `t${i}`, name: test.name, amount: 1, unit: 'each', packs: 1, ...(hit ? { productUrl: hit.url } : {}) };
  }));
  const started = Date.now();
  // Exactly what checkout runs: the shopping agent with this store approved and no other candidates.
  const at = new Date().toISOString();
  const cart = { id: `lab-${name}`, origin: 'request' as const, status: 'approved' as const, title: 'Lab test', createdAt: at, updatedAt: at,
    items: lines.map(line => ({ id: line.itemId, name: line.name, quantity: { amount: 1, unit: 'each' as const }, optional: false, estimatedPriceCents: null, status: 'found' as const,
      ...(line.productUrl ? { offer: { merchant: name, title: line.name, url: line.productUrl, priceCents: null, packs: 1, verified: false, capturedAt: at } } : {}) })) };
  const prepared = await runShoppingAgent({ cart, state: await store.read(), store, client, chosen: domain, alternatives: (process.env.LAB_ALTERNATIVES ?? '').split(',').filter(Boolean) });
  if (prepared.sessionId) { await shot(prepared.sessionId, `${name}-after-fill`); await closeSession(prepared.sessionId); }
  const checks = prepared.lines.filter(l => /confirm you’re a person|sign-in or a check/.test(l.detail ?? '')).length;
  console.log(`  fill ${Math.round((Date.now() - started) / 1000)}s, bot checks: ${checks}`);
  console.log(`  ${prepared.note}`);
  for (const line of prepared.lines) console.log(`    ${lines.find(l => l.itemId === line.itemId)?.name.padEnd(24)} ${line.result.padEnd(11)} ${line.reason ? `[${line.reason}] ` : ''}${line.detail ?? ''}`);
  if (process.env.LAB_TRACE) for (const entry of prepared.trace ?? []) console.log(`    ${entry.ok ? '✓' : '!'} ${entry.detail}`);
  // Clean up: remove only what wasn't in any cart before, then read every cart again to prove it.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const cleanup = await withCart(plan, connection.connectionId, session => execute(session, snapshotCode(plan, before.carts))) as { carts: Record<string, string[]>; removed: string[] };
      const verify = await withCart(plan, connection.connectionId, session => execute(session, snapshotCode(plan))) as { carts: Record<string, string[]> };
      const extra = Object.entries(verify.carts).flatMap(([cart, items]) => items.filter(item => !(before.carts[cart] ?? []).includes(item)).map(item => `${cart}: ${item}`));
      console.log(`  cleanup removed ${JSON.stringify(cleanup.removed)}; ${extra.length ? `STILL NEW: ${extra.join(' | ')}` : 'every cart matches the start'}`);
      if (!extra.length) break;
    } catch (error) { console.log(`  cleanup attempt ${attempt} failed: ${(error as Error).message.slice(0, 120)}`); }
  }
}
console.log('\nSITE SETUPS NOW');
for (const site of await siteSetupReport()) console.log(`  ${site.domain.padEnd(16)} using ${site.using}  ok=${JSON.stringify(site.successes)} blocked=${JSON.stringify(site.failures)}`);
process.exit(0);
