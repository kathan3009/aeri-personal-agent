import type Kernel from '@onkernel/sdk';
import { retailerDomain } from './merchant-auth.js';
import { z } from 'zod';

const cents = z.number().int().nonnegative().optional();
export const MerchantSummarySchema = z.object({
  merchant: z.string(), url: z.string().url(), capturedAt: z.string(), currency: z.string().optional(),
  lines: z.array(z.object({ name: z.string().min(1), quantity: z.number().int().positive().optional(), unitPriceCents: cents, lineTotalCents: cents, productUrl: z.string().url().optional() })),
  subtotalCents: cents, taxCents: cents, feesCents: cents, tipCents: cents, discountCents: cents, totalCents: cents,
  fulfillment: z.enum(['delivery', 'pickup', 'shipping']).optional(), locationKey: z.string().optional(), complete: z.boolean(), note: z.string().optional(),
});
export type MerchantSummary = z.infer<typeof MerchantSummarySchema>;

/** Read only the current page. Neither this script nor its caller clicks/navigates to checkout. */
export const merchantSummaryScript = (storeUrl: string) => `
const expected = ${JSON.stringify(retailerDomain(storeUrl))};
const current = new URL(page.url());
if (current.protocol !== 'https:' || !(current.hostname === expected || current.hostname.endsWith('.' + expected))) return { url: page.url(), lines: [], note: 'The browser is outside the merchant' };
const money = (text) => { const m = text?.replace(/,/g, '').match(/(?:USD\\s*|\\$)\\s*(\\d+(?:\\.\\d{2})?)(?![\\d.])/i); return m ? Math.round(Number(m[1]) * 100) : undefined; };
const text = (await page.locator('body').innerText()).slice(0, 25000);
const texts = text.split('\\n').map(t => t.trim()).filter(Boolean);
const amount = (labels) => { for (let i = 0; i < texts.length; i++) { const label = texts[i].replace(/\\s*:?[\\s-]*(?:USD|\\$)\\s*[\\d,]+(?:\\.\\d{2})?\\s*$/i, '').trim().replace(/:$/, '').trim(); if (!labels.test(label)) continue; const own = money(texts[i]); if (own !== undefined) return own; if (i + 1 < texts.length && /^-?\\s*(?:USD|\\$)\\s*[\\d,]+(?:\\.\\d{2})?$/i.test(texts[i + 1])) return money(texts[i + 1]); } return undefined; };
const lines = [];
const rows = page.locator('[data-aeri-cart-item], [data-test="cartItem"], [data-test="cart-item"], [data-testid="cart-item"], [data-testid="cart-item-container"]');
for (let i = 0; i < Math.min(await rows.count(), 60); i++) {
 const row = rows.nth(i);
 const title = row.locator('[data-aeri-name], [data-test="cartItem-title"], [data-test="product-title"], [data-testid="product-title"], a[href*="/p/"], a[href*="/ip/"]').first();
 const name = (await title.textContent().catch(() => null))?.trim();
 if (!name) continue;
 const qty = row.locator('[data-aeri-quantity], select[aria-label*="uantity"], input[aria-label*="uantity"]').first();
 let rawQty = await qty.inputValue().catch(() => null);
 if (rawQty === null) rawQty = await qty.textContent().catch(() => null);
 const match = rawQty?.match(/^(?:Qty:?\\s*|Quantity:?\\s*)?(\\d+)$/i);
 const quantity = match ? Number(match[1]) : undefined;
 const unitPriceCents = money(await row.locator('[data-aeri-unit-price], [data-test="unit-price"], [data-testid="unit-price"]').first().textContent().catch(() => null));
 const lineTotalCents = money(await row.locator('[data-aeri-line-total], [data-test="cartItem-price"], [data-testid="line-price"]').first().textContent().catch(() => null));
 const href = await title.getAttribute('href').catch(() => null);
 lines.push({ name, quantity, unitPriceCents, lineTotalCents, ...(href ? { productUrl: new URL(href, page.url()).toString() } : {}) });
}
const fulfillText = await page.locator('[data-aeri-fulfillment], [data-test="fulfillment-method"], [data-testid="fulfillment-method"]').allTextContents();
const method = fulfillText.join(' ').trim().toLowerCase();
const fulfillment = /^delivery$/.test(method) ? 'delivery' : /^pick.?up$/.test(method) ? 'pickup' : /^shipping$/.test(method) ? 'shipping' : undefined;
const location = (await page.locator('[data-aeri-location], [data-test="delivery-address"], [data-testid="delivery-address"], [data-test="pickup-store"]').allTextContents()).map(x => x.trim()).filter(Boolean).join(' | ');
const finalPage = /\\/(checkout|review-order)(?:\\/|$)/i.test(current.pathname);
const noDiscount = texts.some(t => /^no discounts?(?: applied)?$/i.test(t));
const noTip = texts.some(t => /^no tip(?: selected)?$/i.test(t));
return { url: page.url(), currency: /\\$|USD/.test(text) ? 'USD' : undefined, lines,
 subtotalCents: amount(/^subtotal$/i), taxCents: amount(/^(?:estimated )?tax(?:es)?$/i),
 feesCents: amount(/^(?:total fees|fees)$/i), totalCents: finalPage ? amount(/^(?:order total|grand total|total)$/i) : undefined,
 tipCents: noTip ? 0 : amount(/^tip$/i), discountCents: noDiscount ? 0 : amount(/^(?:discounts?|savings)$/i),
 fulfillment, locationKey: location || undefined, note: finalPage ? undefined : 'Open the merchant checkout summary yourself in the live view to read a final total' };`;

export function normalizeMerchantSummary(raw: unknown, storeUrl: string, capturedAt: string): MerchantSummary {
  const domain = retailerDomain(storeUrl);
  const parsed = MerchantSummarySchema.safeParse({ ...(raw && typeof raw === 'object' ? raw : {}), merchant: domain, capturedAt, complete: false });
  if (!parsed.success) return { merchant: domain, url: storeUrl, capturedAt, lines: [], complete: false, note: 'The merchant summary could not be read' };
  const summary = parsed.data, actual = new URL(summary.url);
  if (actual.protocol !== 'https:' || !(actual.hostname === domain || actual.hostname.endsWith(`.${domain}`))) return { merchant: domain, url: storeUrl, capturedAt, lines: [], complete: false, note: 'The browser left the merchant' };
  const totals = ['subtotalCents', 'taxCents', 'feesCents', 'tipCents', 'discountCents', 'totalCents'] as const;
  const allTotals = totals.every(k => summary[k] !== undefined);
  const allLines = summary.lines.length > 0 && summary.lines.every(l => l.quantity !== undefined && l.unitPriceCents !== undefined && l.lineTotalCents === l.quantity * l.unitPriceCents);
  const linesAgree = allLines && summary.lines.reduce((n, l) => n + l.lineTotalCents!, 0) === summary.subtotalCents;
  const totalsAgree = allTotals && summary.subtotalCents! + summary.taxCents! + summary.feesCents! + summary.tipCents! - summary.discountCents! === summary.totalCents;
  summary.complete = !!(linesAgree && totalsAgree && summary.currency === 'USD' && summary.fulfillment && summary.locationKey && /\/(checkout|review-order)(?:\/|$)/i.test(actual.pathname));
  if (!summary.complete) summary.note ??= 'Some final lines, charges, fulfillment or location are not visible; verify them in the merchant checkout';
  return summary;
}

export async function readMerchantSummary(client: Kernel, sessionId: string, storeUrl: string, now = () => new Date().toISOString()): Promise<MerchantSummary> {
  const run = await client.browsers.playwright.execute(sessionId, { code: merchantSummaryScript(storeUrl), timeout_sec: 30 });
  return normalizeMerchantSummary(run.success ? run.result : null, storeUrl, now());
}
