import { config } from 'dotenv'; import { resolve } from 'node:path';
config({ path: resolve(import.meta.dirname, '../../../.env') });
const { default: Kernel } = await import('@onkernel/sdk');
const k = new Kernel({ apiKey: process.env.KERNEL_API_KEY!, timeout: 200_000 });
const url = process.argv[2] ?? 'https://www.target.com/';
const started = await k.configRegistry.resolve({ url, allowed_proxy_countries: ['US'], intent: 'Open a grocery product page, choose Delivery, and add the product to the cart. Do not sign in or check out.' });
console.log('analysis', started.analysis?.id, started.analysis?.status);
if (started.analysis?.id) {
  const done = await k.configRegistry.analyses.waitForResult(started.analysis.id, { maxWaitMs: 15 * 60_000 } as never);
  const rec: any = done.recommendation;
  console.log('status', done.analysis?.status, 'workload', done.workload_outcome);
  console.log('recommendation', JSON.stringify(rec?.type === 'recommendation' ? { browser: rec.browser, proxy: rec.proxy, evidence: rec.evidence } : rec));
  console.log('working', JSON.stringify(done.working_configurations?.map((w: any) => ({ stealth: w.browser.stealth, proxy: w.proxy.mode === 'managed' ? w.proxy.create.type : w.proxy.mode, rate: w.evidence.success_rate }))));
  console.log('guidance', (done.guidance ?? '').slice(0, 800));
}
