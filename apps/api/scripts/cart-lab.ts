/**
 * Real add-to-cart test with per-site setups. Each store gets a guest cart in a throwaway Kernel browser (no sign-in,
 * never checkout), using exactly the code path Aeri uses for a real list. Reports what was added and whether any bot
 * check appeared, and teaches the site setups what happened.
 *
 *   DATA_DIR=.data-preview/expo-live node --import tsx apps/api/scripts/cart-lab.ts [target walmart amazon instacart]
 */
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });
const { discoverProducts, prepareMerchantCart, closeSession } = await import('../src/market.js');
const { siteSetupReport } = await import('../src/site-config.js');

const stores: Record<string, { url: string; queries: string[] }> = {
  target: { url: 'https://www.target.com/', queries: ['Lipton black tea bags', 'Solo paper cups'] },
  walmart: { url: 'https://www.walmart.com/', queries: ['Lipton black tea bags', 'Great Value paper cups'] },
  amazon: { url: 'https://www.amazon.com/', queries: ['Lipton black tea bags', 'Dixie paper cups'] },
  instacart: { url: 'https://www.instacart.com/', queries: [] },
};
const only = process.argv.slice(2);
for (const [store, { url, queries }] of Object.entries(stores).filter(([name]) => !only.length || only.includes(name))) {
  const started = Date.now();
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '');
    const lines = store === 'instacart'
      ? [{ itemId: 'tea', name: 'Lipton black tea bags', amount: 1, unit: 'each', packs: 1 }, { itemId: 'cups', name: 'Paper cups', amount: 1, unit: 'each', packs: 1 }]
      : (await Promise.all(queries.map(async (query, i) => {
          const hit = (await discoverProducts(query, [domain], 3)).find(h => /\/(p|ip|dp)\//.test(new URL(h.url).pathname));
          return hit ? { itemId: `item${i}`, name: query, amount: 1, unit: 'each', packs: 1, productUrl: hit.url } : null;
        }))).filter(Boolean) as Array<{ itemId: string; name: string; amount: number; unit: string; packs: number; productUrl?: string }>;
    if (!lines.length) { console.log(`${store}: no product pages found to test`); continue; }
    const prepared = await prepareMerchantCart(url, lines);
    await closeSession(prepared.sessionId);
    const checks = prepared.lines.filter(l => /confirm you’re a person|sign-in or a check/.test(l.detail ?? '')).length;
    console.log(`\n${store.toUpperCase()} ${Math.round((Date.now() - started) / 1000)}s  bot checks: ${checks}`);
    console.log(`  ${prepared.note}`);
    for (const line of prepared.lines) console.log(`  ${lines.find(l => l.itemId === line.itemId)?.name.padEnd(26)} ${line.result.padEnd(11)} ${line.detail ?? ''}`);
  } catch (error) { console.log(`\n${store.toUpperCase()} error: ${(error as Error).message.slice(0, 200)}`); }
}
console.log('\nSITE SETUPS NOW');
for (const site of await siteSetupReport()) console.log(`  ${site.domain.padEnd(16)} using ${site.using} (${site.source})  ok=${JSON.stringify(site.successes)} blocked=${JSON.stringify(site.failures)}`);
