// Live check of discovery (Exa) and retailer-page verification (Kernel). Spends a little Exa and Kernel credit.
// Usage: npm run check:retailer -w @personal-agent/api -- "Fage Total 2% Greek yogurt 32 oz" target.com walmart.com
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(import.meta.dirname, '../../../.env') });
const { discoverProducts, verifyPages } = await import('../src/market.js');
const [query = 'Fage Total 2% plain Greek yogurt 32 oz', ...domains] = process.argv.slice(2);
if (!process.env.EXA_API_KEY || !process.env.KERNEL_API_KEY) { console.error('Needs EXA_API_KEY and KERNEL_API_KEY in .env'); process.exit(1); }
const started = Date.now();
const hits = await discoverProducts(query, domains.length ? domains : ['target.com', 'walmart.com', 'wholefoodsmarket.com'], 1);
console.log(`Exa: ${hits.length} candidate pages in ${Date.now() - started} ms`);
for (const hit of hits) console.log(`  ${hit.merchant}  ${hit.title.slice(0, 70)}\n    ${hit.url}`);
const checked = Date.now();
const results = await verifyPages(hits.map(h => h.url), () => new Date().toISOString());
console.log(`Kernel: read ${results.size} pages in ${Date.now() - checked} ms`);
for (const [url, v] of results) console.log(`  ${new URL(url).hostname}: ${v.status}${v.priceCents != null ? ` $${(v.priceCents / 100).toFixed(2)}` : ''} ${v.availability} | ${v.name ?? ''} | brand ${v.brand ?? '?'} | size ${v.sizeText ?? '?'}${v.note ? ` | ${v.note}` : ''}`);
