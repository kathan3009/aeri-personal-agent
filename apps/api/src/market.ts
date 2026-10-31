import Kernel from '@onkernel/sdk';
import { normalizeName, parsePackSize, type BlockReason, type Offer, type ShoppingNeed, type StoreQuote, type TraceStep, type Verification } from '@personal-agent/core';
import { ProviderError, researchProducts, scrub, withProvider } from './providers.js';
import { merchantBrowserOptions, registrableDomain, retailerDomain } from './merchant-auth.js';
import { botCheck, launchOptions, recordOutcome, siteSetup } from './site-config.js';
import { storeBrowser } from './kernel-pools.js';
import { selectStore, type StoreSelection } from './merchant-store.js';
import { readMerchantSummary as readSummary, type MerchantSummary } from './merchant-summary.js';

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
export function merchantDomainsFor(preferred: string[], fallback: string[] = ['walmart.com', 'target.com']): string[] {
  const domains = preferred.flatMap(name => /^[\w-]+(\.[\w-]+)+$/.test(name.trim()) ? [registrableDomain(name.trim())].filter((d): d is string => !!d)
    : merchantDomains.filter(([pattern]) => pattern.test(name)).map(([, domain]) => domain));
  return [...new Set(domains.length ? domains : fallback)].slice(0, 3);
}
export const merchantName = (host: string) => host.replace(/^www\./, '').replace(/\.(com|us|net|co)$/, '').replace(/^\w/, c => c.toUpperCase());

const productPath = /\/(p|ip|dp|pd|product|products|prod|item|items)\/|-p-|\/sku\//i;
// Sites that write about products but don't sell them.
const notStores = /^(youtube\.com|youtu\.be|pinterest\.com|reddit\.com|wikipedia\.org|facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|quora\.com|medium\.com|allrecipes\.com|foodnetwork\.com|nytimes\.com|seriouseats\.com|bonappetit\.com|epicurious\.com|delish\.com|thekitchn\.com|healthline\.com|webmd\.com|nih\.gov|google\.com|bing\.com|yelp\.com|tripadvisor\.com|consumerreports\.org|rtings\.com|wirecutter\.com)$/;

export type StoreDiscovery = { domains: string[]; coverage: Record<string, number>; preferred: string[]; searched: boolean };
/**
 * Which stores actually sell these items: one open web search per item, keeping only product pages at shops.
 * Preferred stores are always checked; the rest are the stores that carry the most of the list. Avoided stores
 * are dropped. Store choice comes from search, not from a fixed list.
 */
export async function discoverStores(needs: Array<Pick<ShoppingNeed, 'id' | 'name' | 'brand'>>, options: { prefer?: string[]; avoid?: string[]; limit?: number; brand?: string } = {}): Promise<StoreDiscovery> {
  const limit = options.limit ?? 4;
  const preferred = merchantDomainsFor(options.prefer ?? [], []);
  const avoided = (options.avoid ?? []).map(word => normalizeName(word)).filter(Boolean);
  const coverage = new Map<string, Set<string>>();
  const searches = await Promise.all(needs.slice(0, 8).map(async need => ({ need, hits: await researchProducts(`${need.brand ?? ''} ${need.name} buy online`.trim(), { numResults: 10 }).catch(() => []) })));
  for (const { need, hits } of searches) for (const hit of hits) {
    let url: URL; try { url = new URL(hit.url); } catch { continue; }
    if (!productPath.test(url.pathname)) continue;
    const domain = registrableDomain(url.hostname);
    // Searches are for US delivery; country-specific shops (amazon.ca, tesco.co.uk) can't deliver here.
    if (!domain || notStores.test(domain) || !/\.(com|us|net|org|shop|store)$/.test(domain) || avoided.some(word => normalizeName(merchantName(domain)).includes(word))) continue;
    coverage.set(domain, (coverage.get(domain) ?? new Set()).add(need.id));
  }
  // General retailers get a small edge over single-brand shops that carry the same number of items.
  const general = new Set([...merchantDomains.map(([, domain]) => domain), 'samsclub.com', 'bjs.com', 'meijer.com', 'albertsons.com', 'stopandshop.com', 'giantfood.com', 'wegmans.com', 'foodlion.com', 'shoprite.com', 'freshdirect.com', 'thrivemarket.com', 'boxed.com', 'bestbuy.com', 'homedepot.com', 'lowes.com', 'ikea.com', 'staples.com', 'officedepot.com']);
  // A brand's own shop (foundr.com for a foundr. cap) is the surest place to find that exact product.
  const brand = (options.brand ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const ownShop = (domain: string) => brand.length >= 3 && domain.replace(/[^a-z0-9.]/g, '').split('.')[0].startsWith(brand);
  const score = (domain: string, count: number) => count + (general.has(domain) ? 0.5 : 0) + (ownShop(domain) ? 2 : 0);
  // A specialist shop that carries one or two things on a long list isn't worth a separate order.
  const enough = (domain: string, count: number) => general.has(domain) || ownShop(domain) || count >= Math.max(2, Math.ceil(needs.length * 0.3));
  const ranked = [...coverage].filter(([domain, set]) => enough(domain, set.size)).sort((a, b) => score(b[0], b[1].size) - score(a[0], a[1].size)).map(([domain]) => domain);
  // Whatever stores the web search finds best come first. Only when it finds fewer than two are big general stores
  // added, so there is still a real choice.
  const fallback = ranked.length >= 2 ? [] : ['walmart.com', 'target.com', 'amazon.com'];
  const domains = [...new Set([...preferred, ...ranked, ...fallback])].slice(0, Math.max(limit, preferred.length));
  return { domains, coverage: Object.fromEntries([...coverage].map(([d, set]) => [d, set.size])), preferred, searched: searches.some(s => s.hits.length) };
}
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
for (let i = 0; i < 9 && rules.price.length && !shownPrice; i++) { const t = await firstText(rules.price, 1200); const m = t?.match(/\\$\\s?(\\d+(?:\\.\\d{2})?)/); if (m) shownPrice = m[1]; else await page.waitForTimeout(600); }
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
  const blocked = facts.status === 403 || facts.status === 429 || /access denied|robot or human|captcha|are you a human|verify you are human|blocked/i.test(`${facts.title ?? ''} ${facts.text ?? ''}`.slice(0, 400));
  const missing = facts.status === 404 || /product not found|page not found|no longer available|404/i.test(`${facts.title ?? ''} ${facts.name ?? ''}`);
  if (blocked || missing) return { status: blocked ? 'blocked' : 'failed', method: 'kernel', checkedAt, availability: 'unknown', url: facts.url, note: blocked ? 'The store showed a bot check instead of the product' : 'The product page no longer exists' };
  // Structured data first; otherwise the price the retailer's own page displays.
  const raw = facts.price ?? facts.shownPrice;
  const price = raw == null ? NaN : Number(String(raw).replace(/[^\d.]/g, ''));
  // The page's structured availability wins; visible fulfillment text is the fallback.
  const a = (facts.availability?.trim() ? facts.availability : facts.stockText ?? '').toLowerCase();
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

/** Reads product pages with one stealth Kernel browser per store, stores in parallel; every session is deleted. */
export async function verifyPages(urls: string[], now: () => string, context: Pick<MerchantContext, 'zip'> = {}): Promise<Map<string, Verification>> {
  const client = kernel();
  const results = new Map<string, Verification>();
  if (!client || !urls.length) return results;
  const byHost = new Map<string, string[]>();
  for (const url of urls) { const host = new URL(url).hostname; byHost.set(host, [...(byHost.get(host) ?? []), url]); }
  await Promise.all([...byHost.values()].slice(0, 4).map(async group => {
    // Each store gets its own working setup (proxy, stealth, window); headful because headless renderers crashed on Target.
    const setup = await siteSetup(client, group[0]).catch(() => null);
    const browser = await withProvider('Kernel', async () => client.browsers.create(setup ? await launchOptions(client, setup, { timeout_seconds: 120 }) : { stealth: true, headless: false, timeout_seconds: 120 }));
    try {
      let selected: StoreSelection | undefined;
      if (context.zip) {
        await client.browsers.playwright.execute(browser.session_id, { code: `await page.goto(${JSON.stringify(new URL(group[0]).origin)}, { waitUntil: 'domcontentloaded' }); return page.url();`, timeout_sec: 35 });
        selected = await selectStore(client, browser.session_id, group[0], context.zip);
      }
      for (const url of group) {
        try {
          const run = await client.browsers.playwright.execute(browser.session_id, { code: extractScript(url), timeout_sec: 50 });
          const v = run.success ? toVerification(run.result as PageFacts, now()) : toVerification(null, now(), run.error);
          if (selected?.status === 'selected') v.storeLocation = `${selected.storeName} (selected for ZIP ${selected.requestedZip})`;
          else if (selected && (v.status === 'verified' || v.status === 'partial')) { v.status = 'partial'; v.note = selected.note; }
          results.set(url, v);
        } catch (error) { results.set(url, toVerification(null, now(), (error as Error).message)); }
      }
    } finally {
      await client.browsers.deleteByID(browser.session_id).catch(() => undefined);
      if (setup) await recordOutcome(setup.domain, setup.label, group.some(url => results.get(url)?.status === 'blocked')).catch(() => undefined);
    }
  }));
  return results;
}

/**
 * Live multi-store offers: Exa per need restricted to the chosen merchants, then the top page per merchant is read
 * at the retailer. Fees, tax, tip and distance are not published on product pages, so they stay unknown.
 */
export async function liveOffers(needs: ShoppingNeed[], domains: string[], now: () => string, id: () => string, context: Pick<MerchantContext, 'zip'> = {}): Promise<{ offers: Offer[]; quotes: StoreQuote[] }> {
  // Only real product pages become offers; articles and category pages are skipped.
  const found = await Promise.all(needs.slice(0, 8).map(async need => ({ need, hits: (await discoverProducts(`${need.brand ?? ''} ${need.name}${need.quantity.unit === 'each' ? '' : ` ${need.quantity.amount} ${need.quantity.unit}`} grocery`.trim(), domains, 2).catch(() => []))
    .filter(hit => productPath.test(new URL(hit.url).pathname)).filter((hit, i, all) => all.findIndex(h => h.merchant === hit.merchant) === i) })));
  const urls = found.flatMap(f => f.hits.map(h => h.url));
  const verified = await verifyPages(urls, now, context);
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
export type MerchantContext = { zip?: string; connectionId?: string; /** Called as lines are tried, and once the live view exists, so the phone can follow along. */ progress?: (update: { lines: PreparedCart['lines']; liveViewUrl?: string; sessionId: string }) => Promise<void> };
export type PreparedCart = { url: string; liveViewUrl?: string; sessionId?: string; note: string; mode: 'manual' | 'kernel'; signedIn?: boolean; cartUrl?: string; storeSelection?: StoreSelection; lines: Array<{ itemId: string; result: 'added' | 'unavailable' | 'substituted' | 'uncertain'; detail?: string; confirmedPacks?: number; reason?: BlockReason }>; runId?: string; trace?: TraceStep[] };

export const addScript = (url: string, packs = 1) => {
if (!Number.isInteger(packs) || packs < 1 || packs > 99) throw new Error('Approved pack count must be between 1 and 99');
return `
await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForTimeout(2000);
const expectedDomain = ${JSON.stringify(retailerDomain(url))}, actual = new URL(page.url());
if (actual.protocol !== 'https:' || !(actual.hostname === expectedDomain || actual.hostname.endsWith('.' + expectedDomain))) return { result: 'uncertain', detail: 'The product page left the approved retailer' };
const path = actual.pathname.toLowerCase(), segments = path.split('/');
if (segments.some(s => ['checkout', 'payment', 'review-order', 'place-order', 'login', 'signin'].includes(s))) return { result: 'uncertain', detail: 'Checkout and account actions are reserved for the user' };
if (!segments.some(s => ['p', 'ip', 'dp', 'pd', 'product', 'products', 'prod', 'item', 'items', 'sku'].includes(s)) && !path.includes('-p-')) return { result: 'uncertain', detail: 'The store did not open the approved product page' };
if (/captcha|access denied|robot|verification/i.test(await page.title())) return { result: 'uncertain', detail: 'The store asked to confirm you’re a person' };
if (/sign ?in|log ?in/i.test(await page.title())) return { result: 'uncertain', detail: 'The store asked for sign-in or a check' };
if (/quick verification|press (&|and) hold|robot or human|verify you are (a )?human|are you a robot|access denied|pardon our interruption/i.test((await page.locator('body').innerText().catch(() => '')).slice(0, 3000))) return { result: 'uncertain', detail: 'The store asked to confirm you’re a person' };
const packs = ${packs};
const quantity = page.locator('select[aria-label*="uantity"], input[aria-label*="uantity"]').first();
const hasQuantity = !!(await quantity.count());
if (packs > 1 && !hasQuantity) return { result: 'uncertain', detail: 'Set the approved quantity of ' + packs + ' in the live cart; this page has no supported quantity control' };
if (hasQuantity) {
 const tag = await quantity.evaluate(e => e.tagName.toLowerCase());
 try { if (tag === 'select') await quantity.selectOption(String(packs)); else await quantity.fill(String(packs)); } catch { return { result: 'uncertain', detail: 'The store refused the approved quantity' }; }
 if (Number(await quantity.inputValue()) !== packs) return { result: 'uncertain', detail: 'The store did not confirm the approved quantity' };
}
// The page's own "Add to cart" / "Add" button. Some stores label it with the product ("Add to cart - Lipton Black Tea"),
// and the same page lists other products' buttons too, so a labelled button counts only if it names this page's product.
let button = page.getByRole('button', { name: /^(add|add to cart|add to bag|add to basket)$/i }).first();
await button.waitFor({ state: 'visible', timeout: 12000 }).catch(() => undefined);
if (!(await button.count())) {
  const heading = (await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '')).toLowerCase().split(/[,:|(]/)[0].replace(/\s+/g, ' ').trim();
  const labels = await page.getByRole('button', { name: /^add to (cart|bag|basket)\s*(-|for)\s/i }).evaluateAll(els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim()));
  const own = heading.length >= 6 ? labels.find(label => label.toLowerCase().includes(heading)) : undefined;
  if (own) button = page.getByRole('button', { name: own, exact: true }).first();
}
// Signed in with a store chosen, Target hides "Add to cart" until you pick how to get it (Delivery, then Shipping, then
// Pickup); some pages then show "Deliver it" / "Ship it" / "Pick it up" instead of "Add to cart".
if (!(await button.count())) {
  for (const way of [/^delivery\b/i, /^shipping\b/i, /^pickup\b/i]) {
    const choice = page.getByRole('button', { name: way }).first();
    if (!(await choice.count())) continue;
    await choice.click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(2000);
    button = page.getByRole('button', { name: /^(add|add to cart|add to bag|add to basket)$/i }).first();
    await button.waitFor({ state: 'visible', timeout: 6000 }).catch(() => undefined);
    for (const go of [/^deliver it$/i, /^ship it$/i, /^pick it up$/i]) { if (await button.count()) break; const option = page.getByRole('button', { name: go }).first(); if (await option.count()) button = option; }
    if (await button.count()) break;
  }
}
// (already waited for the page's own button above)
if (!(await button.count())) return { result: /out of stock|sold out|unavailable/i.test(await page.locator('body').innerText()) ? 'unavailable' : 'uncertain', detail: 'No add-to-cart button found' };
if (await button.isDisabled().catch(() => false)) return { result: 'unavailable', detail: 'Add to cart is disabled' };
const before = (await page.locator('body').innerText()).slice(0, 6000);
await button.click({ timeout: 10000 });
await page.waitForTimeout(2500);
const text = (await page.locator('body').innerText()).slice(0, 6000);
const confirms = /added to (your )?(cart|bag|basket)|item added/i;
return confirms.test(text) && !confirms.test(before) ? { result: 'added', ...(hasQuantity ? { confirmedPacks: packs } : {}) } : { result: 'uncertain', detail: 'Clicked add, but the page did not show a new addition confirmation' };`;
};

const PERSON_CHECK = 'The store asked to confirm you’re a person';
/**
 * Tries to get past a bot check without the person: first give Kernel's CAPTCHA solver a moment (stealth setups),
 * then press and hold the challenge button with real OS-level mouse input, which page scripts can't tell from a
 * person. Returns true when the check is gone.
 */
export async function clearChallenge(client: Kernel, sessionId: string): Promise<boolean> {
  const look = `const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 3000);
const box = await page.locator('#px-captcha').boundingBox().catch(() => null);
const frame = await page.evaluate(() => ({ x: window.screenX + (window.outerWidth - window.innerWidth) / 2, y: window.screenY + (window.outerHeight - window.innerHeight) }));
return { text, box, frame };`;
  const read = async () => { const r = await client.browsers.playwright.execute(sessionId, { code: look, timeout_sec: 20 }).catch(() => null); return r?.success ? r.result as { text: string; box: { x: number; y: number; width: number; height: number } | null; frame: { x: number; y: number } } : null; };
  const pass = (state: Awaited<ReturnType<typeof read>>) => !!state && !state.box && !botCheck.test(state.text);
  await new Promise(done => setTimeout(done, 6000));
  let state = await read();
  if (pass(state)) return true;
  if (state?.box) {
    const x = Math.round(state.frame.x + state.box.x + state.box.width / 2 + (Math.random() * 16 - 8)), y = Math.round(state.frame.y + state.box.y + state.box.height / 2 + (Math.random() * 6 - 3));
    await client.browsers.computer.batch(sessionId, { actions: [
      { type: 'move_mouse', move_mouse: { x, y, duration_ms: 700 + Math.round(Math.random() * 600) } },
      { type: 'sleep', sleep: { duration_ms: 250 + Math.round(Math.random() * 250) } },
      { type: 'click_mouse', click_mouse: { x, y, click_type: 'down' } },
      { type: 'sleep', sleep: { duration_ms: 8500 + Math.round(Math.random() * 2000) } },
      { type: 'click_mouse', click_mouse: { x, y, click_type: 'up' } },
    ] } as never).catch(() => undefined);
    await new Promise(done => setTimeout(done, 5000));
    state = await read();
  }
  return pass(state);
}

// Typing a store's cart address directly looks automated (Target challenges a bare /cart visit), so Aeri clicks the
// store's own cart icon from the page it's on, and only opens the cart address if there's no icon.
/** The store's own cart page (opens the store's app on a phone when it has one). Instacart carts belong to a shop. */
export function storeCartUrl(domain: string, lastUrl?: string) {
  if (domain === 'instacart.com') { const shop = lastUrl?.match(/instacart\.com\/store\/([a-z0-9-]+)\//)?.[1]; return shop && shop !== 's' ? `https://www.instacart.com/store/${shop}/storefront` : 'https://www.instacart.com/store'; }
  return `https://www.${domain}${domain === 'target.com' ? '/cart' : cartPages[domain] ?? '/cart'}`;
}
const cartPages: Record<string, string> = { 'walmart.com': '/cart', 'amazon.com': '/gp/cart/view.html', 'kroger.com': '/cart', 'costco.com': '/CheckoutCartView', 'wholefoodsmarket.com': '/cart' };
export const cartScript = (storeUrl: string) => {
  const domain = retailerDomain(storeUrl), path = cartPages[domain];
  // Target guards its cart page with its strongest bot check; leave the person on the product page and let them
  // open the cart in the live view, where a real person passes.
  if (domain === 'target.com') return `return page.url();`;
  return path ? `await page.goto(${JSON.stringify(new URL(path, storeUrl).toString())}, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined); return page.url();`
    : `if (!/^https:\\/\\/([^/]+\\.)?${domain.replace(/\./g, '\\.')}\\//.test(page.url())) await page.goto(${JSON.stringify(new URL('/', storeUrl).toString())}, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined);
const cart = page.getByRole('button', { name: /^(view )?(your )?(shopping )?cart\\b|^items in cart|^\\d+ items? in cart/i }).first();
if (await cart.count().catch(() => 0)) await cart.click({ timeout: 5000 }).catch(() => undefined);
return page.url();`;
};

/**
 * Fallback when no AI model is configured (the shopping agent does this otherwise). Prepares the store cart for exactly the approved lines. With Kernel, product pages that are known get one deterministic
 * add-to-cart click each; the page must confirm before a line counts as added. It never opens checkout or payment.
 * Without Kernel, the person adds the items at the store themselves.
 */
export async function prepareMerchantCart(storeUrl: string, lines: CartLine[], context: MerchantContext = {}): Promise<PreparedCart> {
  const host = new URL(storeUrl).hostname.replace(/^www\./, '');
  const domain = retailerDomain(storeUrl);
  for (const line of lines) if (line.productUrl && retailerDomain(line.productUrl) !== domain) throw new Error('An approved product belongs to another retailer');
  const client = kernel();
  if (!client) return { url: storeUrl, mode: 'manual', lines: [], note: `Aeri opened ${host}. Add the ${lines.length} approved items there and check out yourself.` };
  const setup = await siteSetup(client, storeUrl).catch(() => null);
  const options = await merchantBrowserOptions(client, storeUrl, context.connectionId, setup ? await launchOptions(client, setup) : undefined);
  // A warm browser from the store's pool when available (already on the right setup and sign-in).
  const browser = await withProvider('Kernel', () => storeBrowser(client, setup, options, options.profile?.name));
  const results: PreparedCart['lines'] = [];
  let storeSelection: StoreSelection | undefined;
  let blocked = false;
  await context.progress?.({ lines: [], liveViewUrl: browser.browser_live_view_url ?? undefined, sessionId: browser.session_id }).catch(() => undefined);
  try {
    if (context.zip) {
      await client.browsers.playwright.execute(browser.session_id, { code: `await page.goto(${JSON.stringify(storeUrl)}, { waitUntil: 'domcontentloaded' }); return page.url();`, timeout_sec: 35 });
      storeSelection = await selectStore(client, browser.session_id, storeUrl, context.zip);
      // No mutation at a store whose requested location has not been confirmed.
      if (storeSelection.status !== 'selected') {
        return { url: storeUrl, liveViewUrl: browser.browser_live_view_url ?? undefined, sessionId: browser.session_id, mode: 'kernel', storeSelection,
          lines: lines.map(l => ({ itemId: l.itemId, result: 'uncertain', detail: storeSelection!.note })), note: `${storeSelection.note}. Review the location before adding items.` };
      }
    }
    for (const line of lines) {
      if (!line.productUrl) continue;
      const attempt = async () => {
        const run = await client.browsers.playwright.execute(browser.session_id, { code: addScript(line.productUrl!, line.packs), timeout_sec: 50 }).catch(error => ({ success: false, error: (error as Error).message, result: undefined }));
        return run.success ? run.result as { result: 'added' | 'unavailable' | 'uncertain'; detail?: string; confirmedPacks?: number } : { result: 'uncertain' as const, detail: scrub(String(run.error ?? 'Browser step failed')).slice(0, 100) };
      };
      let outcome = await attempt();
      // A bot check on the way: try to clear it once (Kernel's solver, then a real press-and-hold), then retry the item.
      if (outcome.detail === PERSON_CHECK && await clearChallenge(client, browser.session_id)) outcome = await attempt();
      if (outcome.detail === PERSON_CHECK) blocked = true;
      results.push({ itemId: line.itemId, result: outcome.result, detail: outcome.detail, confirmedPacks: outcome.confirmedPacks });
      await context.progress?.({ lines: results, liveViewUrl: browser.browser_live_view_url ?? undefined, sessionId: browser.session_id }).catch(() => undefined);
    }
    const unlinked = lines.filter(line => !line.productUrl);
    // Without the shopping agent (no AI model configured), items lacking a product page are left for the person.
    for (const line of lines.filter(entry => !entry.productUrl)) results.push({ itemId: line.itemId, result: 'uncertain', detail: `Search for “${line.name.toLowerCase()}” in the store and add it` });
    // Leave the live view on the store's cart so the person reviews what is actually in it. Known cart pages are
    // opened directly; elsewhere Aeri opens the store and taps its cart button (never checkout).
    await client.browsers.playwright.execute(browser.session_id, { code: cartScript(storeUrl), timeout_sec: 40 }).catch(() => undefined);
  } catch (error) {
    await client.browsers.deleteByID(browser.session_id).catch(() => undefined);
    throw error instanceof ProviderError ? error : new ProviderError('Kernel', (error as Error).message);
  }
  // Teach the site setup what happened, so a store that keeps blocking this setup moves to the next one.
  if (setup && !context.connectionId) await recordOutcome(setup.domain, setup.label, blocked).catch(() => undefined);
  const note = fillNote(results, lines.length, merchantName(domain));
  return { url: storeUrl, liveViewUrl: browser.browser_live_view_url ?? undefined, sessionId: browser.session_id, note, mode: 'kernel', storeSelection, lines: results };
}

/** What happened, in the person's terms: how many items are in the cart and what's left for them to do. */
export function fillNote(results: PreparedCart['lines'], total: number, store: string): string {
  if (!results.length) return `Your ${store} cart is open. Add the ${total} items, review the cart, and pay there yourself.`;
  const done = results.filter(r => r.result === 'added' || r.detail?.startsWith('Aeri added')).length;
  if (results.some(r => r.detail === 'The store asked to confirm you’re a person')) return `${store} asked to confirm you’re a person. Open the live view, complete the check once, and Aeri’s session can continue.${done ? ` ${done} of ${total} items were added before that.` : ''}`;
  if (!done) return `Aeri couldn’t add these at ${store} by itself. Your ${store} cart is open: search for each item below and add it, then pay there yourself.`;
  return `Aeri added ${done} of ${total} items at ${store}. ${done < total ? 'Add the rest from the list below, check the cart,' : 'Check the cart,'} then pay there yourself.`;
}

export async function readMerchantSummary(sessionId: string, storeUrl: string, now?: () => string): Promise<MerchantSummary> {
  const client = kernel();
  if (!client) throw new Error('Kernel is required to read the hosted merchant cart');
  return readSummary(client, sessionId, storeUrl, now);
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
