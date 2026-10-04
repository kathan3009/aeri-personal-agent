// Live check of cart preparation in a throwaway Kernel guest session: one approved product, no sign-in, no checkout.
// The browser is deleted at the end. Usage: npm run check:cart -w @personal-agent/api -- <product URL>
import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(import.meta.dirname, '../../../.env'), quiet: true });
const { prepareMerchantCart, closeSession } = await import('../src/market.js');
const url = process.argv[2] ?? 'https://www.target.com/p/fage-total-2-milkfat-plain-greek-yogurt-32oz/-/A-14931777';
if (!process.env.KERNEL_API_KEY) { console.error('Needs KERNEL_API_KEY'); process.exit(1); }
delete process.env.NEON_AI_GATEWAY_API_KEY; delete process.env.NEON_AI_GATEWAY_TOKEN; // deterministic adapter only
const started = Date.now();
const result = await prepareMerchantCart(new URL(url).origin + '/', [{ itemId: 'probe', name: 'probe item', amount: 1, unit: 'each', packs: 1, productUrl: url }]);
console.log(`mode ${result.mode} in ${Date.now() - started} ms; live view ${result.liveViewUrl ? 'returned (not printed)' : 'missing'}`);
console.log('lines', JSON.stringify(result.lines));
console.log('note', result.note);
await closeSession(result.sessionId);
console.log('session deleted');
