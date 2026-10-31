import { config } from 'dotenv'; import { resolve } from 'node:path'; import { writeFile } from 'node:fs/promises';
config({ path: resolve(import.meta.dirname, '../../../.env') });
const { default: Kernel } = await import('@onkernel/sdk');
const { createStore } = await import('../src/store.js');
const { merchantBrowserOptions } = await import('../src/merchant-auth.js');
const { siteSetup, launchOptions } = await import('../src/site-config.js');
const k = new Kernel({ apiKey: process.env.KERNEL_API_KEY! });
const url = `https://www.instacart.com/store/${process.env.SLUG ?? 'raleys'}/storefront`;
const saved = await createStore('', '.data-preview/expo-live').getMerchantConnection('instacart.com');
const b = await k.browsers.create({ ...(await merchantBrowserOptions(k, 'https://www.instacart.com/', saved!.connectionId, await launchOptions(k, await siteSetup(k, 'https://www.instacart.com/')))), timeout_seconds: 300 });
const run = async (code: string) => { const r = await k.browsers.playwright.execute(b.session_id, { code, timeout_sec: 90 }); return r.success ? r.result : { error: r.error }; };
const remove = process.argv.includes('--remove');
try {
  console.log(JSON.stringify(await run(`
await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 45000 }); await page.waitForTimeout(6000);
const open = page.getByRole('button', { name: /view cart|items in cart|cart/i }).first();
await open.click({ timeout: 8000 }).catch(() => undefined); await page.waitForTimeout(4000);
const panel = page.getByRole('dialog').first();
const before = (await panel.innerText().catch(() => '')).replace(/\\s+/g, ' ').slice(0, 1500);
const removed = [];
if (${remove}) {
  for (let i = 0; i < 6; i++) {
    const labels = await panel.getByRole('button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim()));
    const target = labels.find(l => new RegExp(${JSON.stringify(process.env.REMOVE_MATCH ?? 'lipton|sugar')}, 'i').test(l) && /remove|decrease|delete/i.test(l));
    if (!target) break;
    await panel.getByRole('button', { name: target, exact: true }).first().click().catch(() => undefined); removed.push(target); await page.waitForTimeout(2500);
  }
}
const buttons = await panel.getByRole('button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40));
return { before, removed, buttons, after: (await panel.innerText().catch(() => '')).replace(/\\s+/g, ' ').slice(0, 600) };`), null, 1).slice(0, 4000));
  const shot = await k.browsers.computer.captureScreenshot(b.session_id); await writeFile('.data-preview/bot-lab/instacart-cart.png', Buffer.from(await shot.arrayBuffer()));
} finally { await k.browsers.deleteByID(b.session_id).catch(() => undefined); }
