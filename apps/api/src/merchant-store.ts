import type Kernel from '@onkernel/sdk';
import { retailerDomain } from './merchant-auth.js';

export type StoreSelection = { status: 'selected' | 'unsupported' | 'uncertain'; requestedZip: string; storeName?: string; note: string };
export function targetStoreScript(zip: string): string {
  if (!/^\d{5}$/.test(zip)) throw new Error('A five-digit US ZIP is required');
  return `
const zip = ${JSON.stringify(zip)};
if (!/(^|\\.)target\\.com$/.test(new URL(page.url()).hostname)) return { status: 'uncertain', requestedZip: zip, note: 'The browser is outside Target' };
const picker = page.getByRole('button', { name: /my store|your store|find a store|change store|select store/i }).first();
if (!(await picker.count())) return { status: 'uncertain', requestedZip: zip, note: 'Choose your store in the live view' };
await picker.click();
const dialog = page.getByRole('dialog').last();
const area = await dialog.count() ? dialog : page.locator('body');
const field = area.getByRole('textbox', { name: /zip|city|location/i }).first();
if (!(await field.count())) return { status: 'uncertain', requestedZip: zip, note: 'The store picker did not expose a ZIP field' };
await field.fill(zip);
const search = area.getByRole('button', { name: /^search$|find stores/i }).first();
if (await search.count()) await search.click(); else await field.press('Enter');
await page.waitForTimeout(1500);
const cards = area.locator('[data-test*="StoreCard"], [data-test*="store-card"], li').filter({ hasText: zip });
for (let i = 0; i < Math.min(await cards.count(), 10); i++) {
 const card = cards.nth(i), select = card.getByRole('button', { name: /select|make.*my store|choose/i }).first();
 if (!(await select.count())) continue;
 const shownZips = (await card.innerText()).match(/\\b\\d{5}(?:-\\d{4})?\\b/g) ?? [];
 if (!shownZips.some(value => value.split('-')[0] === zip)) continue;
 const name = (await card.locator('h2,h3,h4,[data-test*="StoreName"]').first().textContent().catch(() => null))?.trim();
 if (!name) continue;
 await select.click(); await page.waitForTimeout(1000);
 // Do not mistake a still-open picker result card for the selected store in the site header.
 if (await dialog.count() && await dialog.isVisible().catch(() => false)) return { status: 'uncertain', requestedZip: zip, note: 'The store picker is still open; confirm the selected store in the live view' };
 const shown = await page.locator('[data-test*="StoreName"], [data-test*="storeName"]').allTextContents();
 if (shown.some(t => t.trim().includes(name))) return { status: 'selected', requestedZip: zip, storeName: name, note: 'Target confirmed this store for your ZIP' };
 return { status: 'uncertain', requestedZip: zip, note: 'A store was clicked but the page did not confirm the selection' };
}
return { status: 'uncertain', requestedZip: zip, note: 'Select a nearby store in the live view; no exact ZIP match was confirmed' };`;
}

/** Retailer-specific capability: no inferred location from proxy IP. No delivery address is entered. */
export async function selectStore(client: Kernel, sessionId: string, storeUrl: string, zip: string): Promise<StoreSelection> {
  if (!/^\d{5}$/.test(zip)) throw new Error('A five-digit US ZIP is required');
  if (retailerDomain(storeUrl) !== 'target.com') return { status: 'unsupported', requestedZip: zip, note: 'Choose the store or delivery location in the live view; this retailer adapter is not implemented' };
  const run = await client.browsers.playwright.execute(sessionId, { code: targetStoreScript(zip), timeout_sec: 40 });
  return run.success ? run.result as StoreSelection : { status: 'uncertain', requestedZip: zip, note: 'The store picker could not be verified; choose your store in the live view' };
}
