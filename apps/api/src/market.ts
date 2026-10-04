import Kernel from '@onkernel/sdk';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { normalizeName, parsePackSize, type Offer, type ShoppingNeed, type StoreQuote, type Verification } from '@personal-agent/core';
import { z } from 'zod';
import { ProviderError, researchProducts, scrub, withProvider } from './providers.js';

/**
 * Retailer-neutral discovery and verification. Exa finds candidate product pages (discovery is not verification);
 * a Kernel browser reads the retailer's own page for price, stock and variant. Checkout stays with the person.
 */
const kernel = () => process.env.KERNEL_API_KEY ? new Kernel({ apiKey: process.env.KERNEL_API_KEY }) : null;
export const liveMarketAvailable = () => !!process.env.EXA_API_KEY && !!process.env.KERNEL_API_KEY;

const merchantDomains: Array<[RegExp, string]> = [
  [/target/i, 'target.com'], [/walmart/i, 'walmart.com'], [/whole ?foods/i, 'wholefoodsmarket.com'], [/kroger/i, 'kroger.com'],
  [/safeway/i, 'safeway.com'], [/costco/i, 'costco.com'], [/trader ?joe/i, 'traderjoes.com'], [/instacart/i, 'instacart.com'],
  [/amazon/i, 'amazon.com'], [/\bh-?e-?b\b/i, 'heb.com'], [/publix/i, 'publix.com'], [/aldi/i, 'aldi.us'], [/sprouts/i, 'sprouts.com'],
  [/cvs/i, 'cvs.com'], [/walgreens/i, 'walgreens.com'], [/uniqlo/i, 'uniqlo.com'], [/old navy/i, 'oldnavy.gap.com'], [/\bgap\b/i, 'gap.com'], [/nordstrom/i, 'nordstrom.com'],
];
export function merchantDomainsFor(preferred: string[], fallback = ['walmart.com', 'target.com']): string[] {
  const domains = preferred.flatMap(name => merchantDomains.filter(([pattern]) => pattern.test(name)).map(([, domain]) => domain));
  return [...new Set(domains.length ? domains : fallback)].slice(0, 3);
}
export const merchantName = (host: string) => host.replace(/^www\./, '').replace(/\.(com|us|net|co)$/, '').replace(/^\w/, c => c.toUpperCase());

const productPath = /\/(p|ip|dp|pd|product|products|prod|item|items)\/|-p-|\/sku\//i;
export async function discoverProducts(query: string, domains: string[], perDomain = 2): Promise<Array<{ title: string; url: string; snippet?: string; merchant: string }>> {
  const results = await researchProducts(query, { includeDomains: domains, numResults: Math.min(10, domains.length * 4) });
  const byDomain = new Map<string, typeof results>();
  for (const result of results.sort((a, b) => Number(productPath.test(new URL(b.url).pathname)) - Number(productPath.test(new URL(a.url).pathname)))) {
    const host = new URL(result.url).hostname.replace(/^www\./, '');
    const domain = domains.find(d => host === d || host.endsWith(`.${d}`)) ?? host;
    const list = byDomain.get(domain) ?? [];
    if (list.length < perDomain) list.push(result);
    byDomain.set(domain, list);
  }
  return [...byDomain.entries()].flatMap(([domain, list]) => list.map(r => ({ ...r, merchant: domain })));
}

// Runs inside the retailer page. Reads schema.org Product/Offer JSON-LD and product meta tags; nothing is inferred.
export const extractScript = (url: string) => `
const response = await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
const host = new URL(page.url()).hostname.replace(/^www\./, '');
// Prices on many grocery pages render after load; wait briefly for the retailer's own price element.
const rules = {
  'target.com': { price: ['[data-test="product-price"]'], store: ['[data-test*="StoreName"]'], stock: ['[data-test*="fulfillment"]'] },
  'walmart.com': { price: ['[itemprop="price"]', 'span[data-seo-id="hero-price"]', '[data-testid="price-wrap"] span'], store: ['[data-testid*="store-name"]'], stock: ['[data-testid*="fulfillment"]'] },
  'wholefoodsmarket.com': { price: ['[class*="regular_price"]', '[class*="sale_price"]'], store: ['[class*="store-name"]'], stock: [] },
}[host] ?? { price: [], store: [], stock: [] };
// Read the retailer's own price/store/stock elements with locators (they pierce shadow DOM, unlike querySelector).
const firstText = async (sels, timeout) => { for (const sel of sels) { const t = await page.locator(sel).first().textContent({ timeout }).catch(() => null); if (t && t.trim()) return t.trim(); } return null; };
let shownPrice = null;
for (let i = 0; i < 12 && rules.price.length && !shownPrice; i++) { const t = await firstText(rules.price, 1500); const m = t?.match(/\\$\\s?(\\d+(?:\\.\\d{2})?)/); if (m) shownPrice = m[1]; else await page.waitForTimeout(800); }
if (!rules.price.length) await page.waitForTimeout(2500);
const shownStore = await firstText(rules.store, 1500);
const stockText = (await Promise.all(rules.stock.map(sel => page.locator(sel).allTextContents().catch(() => [])))).flat().join(' ').slice(0, 400);
const status = response ? response.status() : 0;
const facts = await page.evaluate(() => {

  const meta = (k) => document.querySelector('meta[property="' + k + '"],meta[name="' + k + '"],meta[itemprop="' + k + '"]')?.getAttribute('content') ?? null;
  const flat = (n) => !n ? [] : Array.isArray(n) ? n.flatMap(flat) : [n, ...flat(n['@graph'])];
  const isType = (n, t) => [].concat(n?.['@type'] ?? []).includes(t);
  const nodes = [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap(s => { try { return flat(JSON.parse(s.textContent)); } catch { return []; } });
  const p = nodes.find(n => isType(n, 'Product')) ?? nodes.find(n => isType(n, 'ProductGroup'))?.hasVariant?.[0] ?? {};
  const offers = [].concat(p.offers ?? []).flatMap(o => o?.offers ?? o);
  const o = offers.find(x => x?.price ?? x?.lowPrice) ?? offers[0] ?? {};
  const size = [].concat(p.additionalProperty ?? []).find(x => /size|weight|volume/i.test(x?.name ?? ''))?.value ?? p.size ?? p.weight?.value ?? null;
  return {
    name: p.name ?? meta('og:title') ?? document.querySelector('h1')?.textContent?.trim(), brand: typeof p.brand === 'string' ? p.brand : p.brand?.name ?? meta('product:brand'),
    sku: p.sku ?? null, gtin: p.gtin13 ?? p.gtin12 ?? p.gtin14 ?? p.gtin8 ?? p.gtin ?? null,
    price: o.price ?? o.lowPrice ?? o.priceSpecification?.price ?? meta('product:price:amount') ?? meta('og:price:amount'),
    currency: o.priceCurrency ?? o.priceSpecification?.priceCurrency ?? meta('product:price:currency') ?? meta('og:price:currency'),
    availability: String(o.availability ?? meta('product:availability') ?? meta('og:availability') ?? ''),
    size: size == null ? null : String(size), store: o.availableAtOrFrom?.name ?? o.seller?.name ?? null,
    title: document.title, text: document.body.innerText.slice(0, 600),
  };
});
return { status, url: page.url(), shownPrice, shownStore, stockText, ...facts };`;

type PageFacts = { status: number; url: string; shownPrice?: string | null; shownStore?: string | null; stockText?: string; name?: string | null; brand?: string | null; sku?: string | null; gtin?: string | null; price?: string | number | null; currency?: string | null; availability?: string; size?: string | null; store?: string | null; title?: string; text?: string };
export function toVerification(facts: PageFacts | null, checkedAt: string, error?: string): Verification {
  if (!facts) return { status: 'failed', method: 'kernel', checkedAt, availability: 'unknown', note: error ? scrub(error).slice(0, 120) : 'The page did not load' };
  const blocked = facts.status === 403 || facts.status === 429 || /access denied|robot|captcha|are you a human|verify you are human|blocked/i.test(`${facts.title ?? ''} ${facts.text ?? ''}`.slice(0, 400));
  // Structured data first; otherwise the price the retailer's own page displays.
  const raw = facts.price ?? facts.shownPrice;
  const price = raw == null ? NaN : Number(String(raw).replace(/[^\d.]/g, ''));
  const a = `${facts.availability ?? ''} ${facts.stockText ?? ''}`.toLowerCase();
  const availability = /outofstock|soldout|discontinued|out_of_stock|out of stock|sold out/.test(a) && !/instock|in stock|ready within|pickup today|delivery (as soon as|today)/.test(a) ? 'out_of_stock' as const : /instock|in_stock|in stock|ready within|pickup today|delivery (as soon as|today)/.test(a) ? 'in_stock' as const : /limited/.test(a) ? 'limited' as const : 'unknown' as const;
  const priceCents = Number.isFinite(price) && price > 0 ? Math.round(price * 100) : undefined;
  return {
    status: blocked ? 'blocked' : facts.name && priceCents != null ? 'verified' : facts.name ? 'partial' : 'failed', method: 'kernel', checkedAt,
    name: facts.name ?? undefined, brand: facts.brand ?? undefined, sku: facts.sku ? String(facts.sku) : undefined, gtin: facts.gtin ? String(facts.gtin) : undefined,
    priceCents: blocked ? undefined : priceCents, currency: facts.currency ?? undefined, availability: blocked ? 'unknown' : availability,
    sizeText: facts.size ?? undefined, url: facts.url,
    // The store a retailer shows is chosen from the browser's network location, not the person's address.
    storeLocation: facts.shownStore ? `${facts.shownStore} (picked by the store for the browser's location)` : facts.store ?? undefined,
    note: blocked ? 'The store blocked the automated check' : priceCents == null ? 'The page did not publish a machine-readable price' : availability === 'unknown' ? 'The page did not say whether it is in stock' : undefined,
  };
}

/** Opens each product page in one stealth Kernel browser, reads its structured facts, and always deletes the session. */
export async function verifyPages(urls: string[], now: () => string): Promise<Map<string, Verification>> {
  const client = kernel();
  const results = new Map<string, Verification>();
  if (!client || !urls.length) return results;
  // Headful: headless renderers crashed on Target product pages during the live check.
  const browser = await withProvider('Kernel', () => client.browsers.create({ stealth: true, headless: false, timeout_seconds: 120 }));
  try {
    for (const url of urls) {
      try {
        const run = await client.browsers.playwright.execute(browser.session_id, { code: extractScript(url), timeout_sec: 50 });
        results.set(url, run.success ? toVerification(run.result as PageFacts, now()) : toVerification(null, now(), run.error));
      } catch (error) { results.set(url, toVerification(null, now(), (error as Error).message)); }
    }
  } finally { await client.browsers.deleteByID(browser.session_id).catch(() => undefined); }
  return results;
}

/**
 * Live multi-store offers: Exa per need restricted to the chosen merchants, then the top page per merchant is read
 * at the retailer. Fees, tax, tip and distance are not published on product pages, so they stay unknown.
 */
export async function liveOffers(needs: ShoppingNeed[], domains: string[], now: () => string, id: () => string): Promise<{ offers: Offer[]; quotes: StoreQuote[] }> {
  const found = await Promise.all(needs.slice(0, 8).map(async need => ({ need, hits: await discoverProducts(`${need.brand ?? ''} ${need.name} grocery product`.trim(), domains, 1).catch(() => []) })));
  const urls = found.flatMap(f => f.hits.map(h => h.url));
  const verified = await verifyPages(urls, now);
  const offers: Offer[] = found.flatMap(({ need, hits }) => hits.map(hit => {
    const v = verified.get(hit.url);
    const ok = v?.status === 'verified';
    return {
      id: id(), needId: need.id, merchant: merchantName(hit.merchant), title: v?.name ?? hit.title, url: hit.url, brand: v?.brand,
      packSize: parsePackSize(v?.sizeText ?? v?.name ?? hit.title) ?? undefined, priceCents: ok ? v!.priceCents! : null,
      inStock: v?.availability === 'in_stock' || v?.availability === 'limited' ? true : v?.availability === 'out_of_stock' ? false : null,
      capturedAt: v?.checkedAt ?? now(), source: ok ? 'kernel' as const : 'exa' as const, verified: ok,
    };
  }));
  const quotes: StoreQuote[] = domains.map(domain => ({
    merchant: merchantName(domain), fulfillment: 'delivery', deliveryFeeCents: null, serviceFeeCents: null, minimumOrderCents: null, smallOrderFeeCents: null,
    taxRate: null, tipCents: null, distanceMiles: null, distanceMeasure: null, etaMinutes: null, capturedAt: now(), source: 'kernel',
  }));
  return { offers, quotes };
}

export type CartLine = { itemId: string; name: string; amount: number; unit: string; packs: number; productUrl?: string };
export type PreparedCart = { url: string; liveViewUrl?: string; sessionId?: string; note: string; mode: 'manual' | 'kernel'; lines: Array<{ itemId: string; result: 'added' | 'unavailable' | 'substituted' | 'uncertain'; detail?: string }> };

const addScript = (url: string) => `
await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
if (/sign ?in|log ?in|captcha|access denied/i.test(await page.title())) return { result: 'uncertain', detail: 'The store asked for sign-in or a check' };
const button = page.getByRole('button', { name: /add to (cart|bag|basket)|^add$|add for (delivery|pickup|shipping)/i }).first();
if (!(await button.count())) return { result: /out of stock|sold out|unavailable/i.test(await page.locator('body').innerText()) ? 'unavailable' : 'uncertain', detail: 'No add-to-cart button found' };
if (await button.isDisabled().catch(() => false)) return { result: 'unavailable', detail: 'Add to cart is disabled' };
await button.click({ timeout: 10000 });
await page.waitForTimeout(2500);
const text = (await page.locator('body').innerText()).slice(0, 6000);
return /added to (your )?(cart|bag|basket)|in (your )?cart|view cart|item added/i.test(text) ? { result: 'added' } : { result: 'uncertain', detail: 'Clicked add, but the page did not confirm it' };`;

/**
 * Prepares the store cart for exactly the approved lines. With Kernel, product pages that are known get one deterministic
 * add-to-cart click each; the page must confirm before a line counts as added. It never opens checkout or payment.
 * Without Kernel, the person adds the items at the store themselves.
 */
export async function prepareMerchantCart(storeUrl: string, lines: CartLine[]): Promise<PreparedCart> {
  const host = new URL(storeUrl).hostname.replace(/^www\./, '');
  const client = kernel();
  if (!client) return { url: storeUrl, mode: 'manual', lines: [], note: `Aeri opened ${host}. Add the ${lines.length} approved items there and check out yourself.` };
  const browser = await withProvider('Kernel', () => client.browsers.create({ stealth: true, timeout_seconds: 1200 }));
  const results: PreparedCart['lines'] = [];
  try {
    for (const line of lines) {
      if (!line.productUrl) continue;
      const run = await client.browsers.playwright.execute(browser.session_id, { code: addScript(line.productUrl), timeout_sec: 50 }).catch(error => ({ success: false, error: (error as Error).message, result: undefined }));
      const outcome = run.success ? run.result as { result: 'added' | 'unavailable' | 'uncertain'; detail?: string } : { result: 'uncertain' as const, detail: scrub(String(run.error ?? 'Browser step failed')).slice(0, 100) };
      results.push({ itemId: line.itemId, result: outcome.result, detail: outcome.result === 'added' && line.packs > 1 ? `Added 1; set quantity to ${line.packs} in the cart` : outcome.detail });
    }
    const unlinked = lines.filter(line => !line.productUrl);
    if (unlinked.length) results.push(...await agentAdd(client, browser.session_id, storeUrl, unlinked));
    // Leave the live view on the store's cart so the person reviews what is actually in it.
    await client.browsers.playwright.execute(browser.session_id, { code: `await page.goto(${JSON.stringify(new URL('/cart', storeUrl).toString())}, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined); return page.url();`, timeout_sec: 40 }).catch(() => null);
  } catch (error) {
    await client.browsers.deleteByID(browser.session_id).catch(() => undefined);
    throw error instanceof ProviderError ? error : new ProviderError('Kernel', (error as Error).message);
  }
  const added = results.filter(r => r.result === 'added').length;
  const note = results.length
    ? `Aeri added ${added} of ${lines.length} items at ${host}${added < lines.length ? '; check the rest in the store' : ''}. Review the real cart, then pay there yourself.`
    : `A private browser is open at ${host}. Add the ${lines.length} approved items, review the cart, and pay there yourself.`;
  return { url: storeUrl, liveViewUrl: browser.browser_live_view_url ?? undefined, sessionId: browser.session_id, note, mode: 'kernel', lines: results };
}

/** For lines without a product page, a bounded Mastra agent may search and click add (Gateway required). */
async function agentAdd(client: Kernel, sessionId: string, storeUrl: string, lines: CartLine[]): Promise<PreparedCart['lines']> {
  const key = process.env.NEON_AI_GATEWAY_API_KEY || process.env.NEON_AI_GATEWAY_TOKEN, base = process.env.NEON_AI_GATEWAY_BASE_URL;
  if (!key || !base) return lines.map(line => ({ itemId: line.itemId, result: 'uncertain' as const, detail: `Search for ${line.name} in the store` }));
  const origin = new URL(storeUrl).hostname;
  await client.browsers.playwright.execute(sessionId, { code: `await page.goto(${JSON.stringify(storeUrl)}); return page.url();`, timeout_sec: 40 });
  const snapshot = `return { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 4500), buttons: await page.getByRole('button').allTextContents().then(xs => xs.slice(0, 25)) };`;
  const browserAction = createTool({
    id: 'retailerBrowser', description: 'Inspect the retailer page, fill a search box, or click a visible product/add button. Never place an order or pay.',
    inputSchema: z.object({ action: z.enum(['inspect', 'fill', 'click']), label: z.string().optional(), value: z.string().optional() }),
    execute: async ({ action, label, value }) => {
      if (action !== 'inspect' && !label) throw new Error('A visible label is required');
      if (action === 'click' && /checkout|place order|pay|purchase|subscribe|sign in|login/i.test(label!)) throw new Error('That action is reserved for the user in live view');
      const operation = action === 'fill' ? `const field = page.getByPlaceholder(${JSON.stringify(label ?? '')}, { exact: false }).first(); if (await field.count()) await field.fill(${JSON.stringify(value ?? '')}); else await page.getByRole('textbox', { name: ${JSON.stringify(label ?? '')}, exact: false }).first().fill(${JSON.stringify(value ?? '')}); await page.keyboard.press('Enter');`
        : action === 'click' ? `const button = page.getByRole('button', { name: ${JSON.stringify(label ?? '')}, exact: false }).first(); if (await button.count()) await button.click(); else await page.getByRole('link', { name: ${JSON.stringify(label ?? '')}, exact: false }).first().click(); await page.waitForTimeout(1500);` : '';
      const result = await client.browsers.playwright.execute(sessionId, { code: `${operation} ${snapshot}`, timeout_sec: 35 });
      if (!result.success) return { error: String(result.error ?? 'Browser action failed') };
      const page = result.result as { url?: string };
      if (page.url && new URL(page.url).hostname !== origin && !new URL(page.url).hostname.endsWith(`.${origin.replace(/^www\./, '')}`)) throw new Error('Retailer browser navigated outside the store');
      return page;
    },
  });
  const agent = new Agent({
    id: 'retailer-cart-agent', name: 'Retailer cart assistant',
    instructions: 'Use retailerBrowser to add only the exact approved items to the store cart. Inspect first. If sign-in or a delivery location is required, stop. Never click checkout, pay, place order, or choose unapproved substitutes. Reply with JSON only: {"lines":[{"name": string, "result": "added"|"unavailable"|"uncertain", "detail": string}]}; say added only when the page confirmed it.',
    model: { id: `neon/${process.env.NEON_AI_GATEWAY_MODEL ?? 'gpt-5-mini'}`, url: `${base.replace(/\/$/, '')}/v1`, apiKey: key, api: 'chat' },
    tools: { retailerBrowser: browserAction },
  });
  try {
    const mastra = new Mastra({ agents: { retailer: agent }, logger: false, workers: false });
    const answer = await mastra.getAgent('retailer').generate(`Approved items: ${JSON.stringify(lines.map(l => ({ name: l.name, amount: l.amount, unit: l.unit })))}`, { maxSteps: 16 });
    const parsed = z.object({ lines: z.array(z.object({ name: z.string(), result: z.enum(['added', 'unavailable', 'uncertain']), detail: z.string().optional() })) }).safeParse(JSON.parse(answer.text.replace(/^```(json)?|```$/g, '')));
    return lines.map(line => {
      const found = parsed.success ? parsed.data.lines.find(l => normalizeName(l.name) === normalizeName(line.name)) : undefined;
      return { itemId: line.itemId, result: found?.result ?? 'uncertain', detail: found?.detail ?? 'Check this item in the store' };
    });
  } catch (error) { return lines.map(line => ({ itemId: line.itemId, result: 'uncertain' as const, detail: `Aeri stopped: ${scrub((error as Error).message).slice(0, 80)}` })); }
}

/** Is the hosted browser still running? Used before re-showing a live view. */
export async function sessionAlive(sessionId: string): Promise<boolean> {
  const client = kernel();
  if (!client) return false;
  try { const browser = await client.browsers.retrieve(sessionId); return !browser.deleted_at; } catch { return false; }
}
export async function closeSession(sessionId?: string) {
  const client = kernel();
  if (client && sessionId) await client.browsers.deleteByID(sessionId).catch(() => undefined);
}
