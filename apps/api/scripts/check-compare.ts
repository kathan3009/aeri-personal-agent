// Live store comparison for the sample recipe's missing items (Exa discovery + Kernel page reads). Spends a little
// Exa and Kernel credit; nothing is added to any cart. Usage: npm run check:compare -w @personal-agent/api
import { config } from 'dotenv'; import { join, resolve } from 'node:path'; import { mkdtemp, rm } from 'node:fs/promises'; import { tmpdir } from 'node:os';
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
delete process.env.GEMINI_API_KEY; delete process.env.DATABASE_URL;
const dir = await mkdtemp(join(tmpdir(), 'aeri-live-')); process.env.DATA_DIR = dir;
const { createApp } = await import('../src/app.js'); const { createStore } = await import('../src/store.js');
const store = createStore('', dir); const app = createApp(store, 'probe');
const post = async (path: string, body?: unknown) => (await app.request(path, { method: 'POST', headers: { Authorization: 'Bearer probe', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json() as Promise<any>;
const { cart } = await post('/v1/recipes', { url: 'https://youtu.be/demo' });
const started = Date.now();
const p = await post(`/v1/carts/${cart.id}/compare?wait=1`, { live: true });
console.log(`${p.status} (${p.source}) in ${Math.round((Date.now() - started) / 1000)} s ${p.error ?? ''}`);
for (const o of p.offers) console.log(`  ${o.merchant.padEnd(8)} ${o.verified ? 'checked  ' : 'unchecked'} ${o.priceCents != null ? `$${(o.priceCents / 100).toFixed(2)}`.padStart(7) : '      ?'} stock ${String(o.inStock).padEnd(5)} ${o.title.slice(0, 60)}`);
for (const b of p.baskets) console.log(`  basket ${b.label}: $${(b.knownTotalCents / 100).toFixed(2)} known, complete ${b.complete}, missing ${b.missing}`);
console.log(`  ${p.explanation}`);
await store.close(); await rm(dir, { recursive: true, force: true });
