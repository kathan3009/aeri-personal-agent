import type Kernel from '@onkernel/sdk';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { blockReasonSchema, type AppState, type BlockReason, type Cart, type TraceStep } from '@personal-agent/core';
import { agentRun, refundGatewayRequests, reserveGatewayRequests } from './gateway-budget.js';
import { storeBrowser } from './kernel-pools.js';
import { findSignInCode, mailboxConfigured } from './mailbox.js';
import { addScript, cartScript, clearChallenge, discoverProducts, discoverStores, fillNote, storeCartUrl, merchantName, verifyPages, type PreparedCart } from './market.js';
import { merchantBrowserOptions, retailerDomain } from './merchant-auth.js';
import { logEvent } from './monitoring.js';
import { scrub } from './providers.js';
import { launchOptions, recordOutcome, siteSetup } from './site-config.js';
import type { Store } from './store.js';

/**
 * Aeri's shopping agent. One Mastra agent runs the whole store visit with tools: it checks prices, picks the store
 * (the person's favourite first, moving on when a store puts up a wall), gets each store's working Kernel setup,
 * checks sign-in, opens the store, reads and works the pages, clears bot checks, reads codes from the person's own
 * inbox, searches the web for another store when every candidate fails, and records what actually landed in the
 * cart. Nothing here is a store-specific script.
 *
 * What it can never do is enforced in code, not in the prompt: only the approved items, only stores from the
 * comparison, the person's favourites or Aeri's own web search (never a link from a page), no checkout, payment, account or address pages, and "added" needs the store's own
 * evidence.
 */

const searchPages: Record<string, string> = { 'instacart.com': '/store/s?k=', 'target.com': '/s?searchTerm=', 'walmart.com': '/search?q=', 'amazon.com': '/s?k=', 'kroger.com': '/search?query=', 'costco.com': '/s?keyword=' };
const forbidden = /check ?out|place (your )?order|pay(ment)?\b|buy now|sign ?out|log ?out|address|credit|debit|card number|gift card|subscribe|delete|remove account|apply for|redcard|registry/i;
const offLimitsPath = /\/(checkout|payment|place-order|review-order|account|signin|login|addresses|wallet)(\/|$|\?)/i;
// Walls only the person can get past, read from the page itself (not left to the model to notice).
const GATES: Array<[BlockReason, RegExp]> = [
  ['age_check', /\b(21\+|must be 21|are you 21|over 21|at least 21|age verification|verify your age|confirm your age|valid (photo )?id\b|government[- ]issued( photo)? id|legal drinking age|id (is )?required|alcohol delivery)/i],
  ['sign_in', /\b(sign|log) in to (continue|add|shop|see|use)\b/i],
  ['address', /\b(enter|add|set) (your|a) (delivery )?address\b|\bwe don['’]?t (currently )?deliver to\b/i],
  ['minimum_order', /\b(order|basket|cart) minimum\b|\bminimum (order|subtotal|basket)\b/i],
];
// Controls that would confirm the person's age. Only pressed when the person has confirmed it in Aeri.
const AGE_CONFIRM = /\b(i['’]?m|i am) (over |at least )?21\b|\byes,? i['’]?m (over |at least )?21|\bconfirm (my )?age\b|\bof legal (drinking )?age\b/i;
/** The first wall a page shows, if any. */
export const gateIn = (text: string): BlockReason | null => GATES.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
/** Whether pressing this control would confirm the person's age (on an age prompt, a bare "Yes" counts too). */
export const confirmsAge = (name: string, gate: BlockReason | null) => AGE_CONFIRM.test(name) || (gate === 'age_check' && /^(yes|confirm|continue|i agree|enter)$/i.test(name.trim()));
// Products that need an adult (and ID at delivery) in the US.
const ALCOHOL = /\b(beer|lager|ale|ipa|stout|porter|wine|champagne|prosecco|ros[eé]|merlot|cabernet|chardonnay|pinot|sauvignon|riesling|vodka|whiskey|whisky|bourbon|scotch|tequila|mezcal|rum|gin|brandy|cognac|liqueur|sake|soju|hard (seltzer|cider|lemonade|kombucha)|seltzer( variety)?( pack)? \d|white claw|truly|high noon|spirits?|alcohol)\b/i;
const reasonLabel: Record<BlockReason, string> = { age_check: 'needs age confirmation (21+, ID at delivery)', sign_in: 'needs the person to sign in', address: 'needs a delivery address', bot_check: 'bot check', store_limited: 'store limited automated shopping', out_of_stock: 'out of stock', not_found: 'not found', minimum_order: 'below the store minimum', quantity_limit: 'quantity limit', other: 'other' };
const PERSON = /quick verification|press (&|and) hold|robot or human|verify (you are|you're) (a )?human|are you a robot|access denied|pardon our interruption/i;

/** Runs in the page: numbers every visible control and returns a compact, readable view plus the cart count. */
export const lookScript = `
const shown = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight * 3; };
const nameOf = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 90);
const nodes = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], [role=option], [role=radio], [role=tab], [role=menuitem], [role=combobox]')].filter(shown);
document.querySelectorAll('[data-aeri-n]').forEach(el => el.removeAttribute('data-aeri-n'));
const elements = [];
for (const el of nodes) {
  const name = nameOf(el); if (!name) continue;
  const n = elements.length; el.setAttribute('data-aeri-n', String(n));
  const role = el.tagName === 'SELECT' ? 'dropdown' : el.tagName === 'INPUT' ? ('input:' + (el.type || 'text')) : (el.getAttribute('role') || (el.tagName === 'A' ? 'link' : 'button'));
  elements.push({ n, role, name, ...(el.tagName === 'SELECT' ? { options: [...el.options].map(o => o.text.trim()).slice(0, 12) } : {}), ...(el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' ? { selected: true } : {}), ...(el.disabled ? { disabled: true } : {}) });
  if (elements.length >= 120) break;
}
const cartLabel = [...document.querySelectorAll('a, button, [data-test]')].map(el => (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '')).find(t => /cart/i.test(t) && /\\d/.test(t)) || '';
const count = (cartLabel.match(/(\\d+)\\s*(items?|in cart)/i) || cartLabel.match(/cart\\D{0,20}(\\d+)/i) || [])[1];
const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ');
return { url: location.href, title: document.title, cartCount: count === undefined ? null : Number(count), heading: (document.querySelector('h1')?.innerText || '').trim().slice(0, 120), text: text.slice(0, 1200), elements };`;
type Look = { url: string; title: string; cartCount: number | null; heading: string; text: string; note?: string; gate?: BlockReason; elements: Array<{ n: number; role: string; name: string; options?: string[]; selected?: boolean; disabled?: boolean }> };

export type ShoppingRun = {
  cart: Cart; state: AppState; store: Store; client: Kernel;
  /** The store the person approved (from the comparison), if any, and the other compared stores. */
  chosen?: string; alternatives: string[];
  zip?: string;
  /** The person's own Aeri inbox, for sign-in codes a store emails during the visit. */
  inboxId?: string;
  /** Ties this visit's logs together; who it's for (logs show only a hash). */
  runId?: string; userId?: string;
  /** The person confirmed in Aeri that they're 21 or older, so age prompts may be accepted for them. */
  ageConfirmed?: boolean;
  /** Finishing a cart: stay at the chosen store (no switching or web search). */
  stayAt?: boolean;
  /** A guest cart's still-open browser to continue in, instead of starting a new one. */
  resume?: { sessionId: string; liveViewUrl?: string; domain: string };
  progress?: (update: { lines: PreparedCart['lines']; liveViewUrl?: string; sessionId: string; storeUrl: string; note?: string; trace?: TraceStep[] }) => Promise<void>;
};

const SYSTEM = `You are Aeri's shopping agent. The person approved a shopping list in the Aeri app. Your job is to get exactly those items into a real store cart for them, then stop before checkout. They review the cart and pay themselves.

How to work:
1. Read the approved items and the person's preferences in the request. Use recall when you need more context.
2. Choose the store. Aeri shops the whole web, not a fixed list: start with the store the person approved or prefers. Use compare_prices when you need prices or stock to decide. Move to another candidate store only when the current one puts up a wall: it doesn't carry most of the items, it requires a sign-in you don't have, it keeps blocking with a bot check after clear_bot_check, it silently limits you (delivery options or prices never load and add buttons never appear even after waiting), or it has a minimum or restriction that stops the order. When that happens call store_restricted with the reason (don't record the items as unavailable first; that is for items the store truly doesn't carry), then open the next store it suggests and shop the remaining items there. If no candidate is left, or none carries an item, call find_stores to search the web for stores that sell the remaining items and try the best one. Say why when you switch.
3. Before opening a store call store_setup (Kernel's working browser settings for that site) and sign_in_status. A signed-in store is better because the cart follows the person to the store's own app; a guest cart is fine when the store allows it (the person then finishes in Aeri's private browser).
4. open_store, then for each item: if it has a known product page use quick_add first; otherwise or if that fails, work the page yourself with look, results or search, press and choose. Make any choice the store needs before adding (Delivery first, then Shipping, then Pickup; the size or count that matches the item). If no add-to-cart control is listed, the store is usually waiting for that choice: press the Delivery option even if another option already says selected, then look again; check for a size or count choice too. Stores often load delivery options, prices and the add button a few seconds late: if an option shows no details yet or the add control is missing, use wait and look again (up to three times) before deciding. Only give up on an item after you have tried this. Add only the approved product, never a recommended or different one, and set the quantity only if the store shows a quantity control.
If a page shows no controls, wait once and look again; if it is still empty use results (it opens the store's own search page). A store that stays empty or keeps failing is restricting you: call store_restricted and continue at the next store; don't hand items to the person while another candidate store is untried.
Age-restricted items (alcohol, some medicines): if the store asks to confirm the person is 21+ or says ID is required, only confirm it when the request says the person confirmed their age in Aeri. Otherwise don't, record the item as person_needed with reason age_check, and carry on with the rest. Switching stores doesn't help with this.
5. After each item call record_item with what happened. Whenever an item isn't added, give the reason that fits best (age_check, sign_in, address, bot_check, store_limited, out_of_stock, not_found, minimum_order, quantity_limit, other). It checks the store's own evidence; trust its answer.
On marketplaces such as Instacart, a "store" sells from several shops (Raley's, Walmart, Lucky...). Put every item in the same shop's cart: note the shop shown on the page when you add the first item, and before each later add check you are still in that shop; if a search or link moved you to another shop, go back to the first one (or search within it) rather than adding there.
6. If a page says to confirm you're a person, call clear_bot_check once. If a sign-in asks for an emailed code, call email_code.
7. When every item is recorded, call show_cart so the person lands on the real cart, then reply with one or two plain sentences: where the cart is and what, if anything, they need to add themselves.

Never: check out, pay, sign in with a password, change the address, add items that weren't approved, or open a store that isn't a candidate or a find_stores result. Keep going until each item is recorded; don't stop early to ask questions.`;

export async function runShoppingAgent(run: ShoppingRun): Promise<PreparedCart> {
  const key = process.env.NEON_AI_GATEWAY_API_KEY || process.env.NEON_AI_GATEWAY_TOKEN, base = process.env.NEON_AI_GATEWAY_BASE_URL;
  if (!key || !base) throw new Error('The shopping agent needs Neon AI Gateway');
  const { client, cart, state } = run;
  const items = cart.items.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, packs: item.offer?.packs ?? 1, productUrl: item.offer?.url && !item.offer.url.startsWith('https://example.com/') ? item.offer.url : undefined }));
  const candidates = [...new Set([run.chosen, ...run.alternatives].filter((d): d is string => !!d))];

  // The one store session the agent is working in.
  type Session = { id: string; domain: string; liveViewUrl?: string; lastCount: number | null; acted: boolean; pooled: boolean; signedIn: boolean };
  let session = null as Session | null;
  const current = () => session;
  let latest: Look | null = null;
  const lines = new Map<string, PreparedCart['lines'][number]>();
  const tried = new Set<string>();
  // How hard the agent has tried since its last record_item: presses and waits on the current item.
  const effort = { presses: 0, waits: 0, addPressed: false, nudged: new Set<string>() };
  const ADD = /add to (cart|bag|basket|trolley)|^add\b(?! to list| to registry| loyalty)|^\+$/i;
  let blockedAt: string | null = null;
  let searches = run.stayAt ? 2 : 0;
  // Whether any store limited Aeri during this visit (explains items left at the end).
  let limited = false;
  const botChecked = () => trace.some(entry => entry.step === 'clear_bot_check' && !entry.ok);
  // The trace: every step this visit took, kept on the cart for the person and logged with the run id.
  const runId = run.runId ?? randomUUID().slice(0, 8);
  const trace: TraceStep[] = [];
  const step = (name: string, detail: string, ok: boolean, ms?: number) => {
    const clean = scrub(detail).replace(/\s+/g, ' ').slice(0, 300);
    trace.push({ at: new Date().toISOString(), step: name, detail: clean, ok, ...(session ? { store: session.domain } : {}), ...(ms !== undefined ? { ms } : {}) });
    if (trace.length > 120) trace.shift();
    logEvent('agent.step', { run: runId, userId: run.userId, tool: name, ok, ms, store: session?.domain, detail: clean.slice(0, 200) });
  };
  // Walls seen on the pages since the last item was recorded.
  const gates = new Set<BlockReason>();
  let gateNow: BlockReason | null = null;
  const started = new Date();

  const exec = async (code: string, timeout = 45) => {
    if (!session) throw new Error('Open a store first');
    let result: Awaited<ReturnType<typeof client.browsers.playwright.execute>>;
    try { result = await client.browsers.playwright.execute(session.id, { code, timeout_sec: timeout }); }
    catch (error) {
      // Kernel ended the browser (it can take a moment to release a saved sign-in after the previous browser closed).
      if ((error as { status?: number }).status === 410 || /no longer exists|session_gone/i.test((error as Error).message)) { session = null; latest = null; throw new Error('The store browser closed unexpectedly. Call open_store again to continue.'); }
      throw error;
    }
    if (!result.success) throw new Error(scrub(String(result.error ?? 'Browser step failed')).slice(0, 160));
    return result.result;
  };
  const inStore = (url: string) => { try { const u = new URL(url); return !!session && u.protocol === 'https:' && (u.hostname === session.domain || u.hostname.endsWith(`.${session.domain}`)) && !offLimitsPath.test(u.pathname); } catch { return false; } };
  const look = async (): Promise<Look | { blocked: string }> => {
    const view = await exec(`return await page.evaluate(() => { ${lookScript} });`) as Look;
    if (PERSON.test(`${view.title} ${view.text}`)) { blockedAt = session!.domain; gates.add('bot_check'); return { blocked: 'The store is asking to confirm you are a person. Call clear_bot_check.' }; }
    if (!inStore(view.url)) return { blocked: 'This page is outside the store or is checkout, which only the person may use. Go back to the store.' };
    latest = view;
    const seen = `${view.heading} ${view.text} ${view.elements.map(el => el.name).join(' ')}`;
    gateNow = gateIn(seen);
    if (gateNow) gates.add(gateNow);
    if (gateNow === 'age_check') return { ...view, elements: view.elements.filter(el => !forbidden.test(el.name)), gate: gateNow, note: run.ageConfirmed
      ? 'This store asks to confirm the person is 21 or older. They confirmed it in Aeri, so you may confirm it (ID is checked at delivery).'
      : 'This store needs the person to confirm they are 21 or older (ID is checked at delivery). Don’t confirm it: record this item as person_needed with reason age_check, then continue with the other items.' };
    if (gateNow) return { ...view, elements: view.elements.filter(el => !forbidden.test(el.name)), gate: gateNow, note: `The page says this ${reasonLabel[gateNow]}. If it stops you adding an item, record it with reason ${gateNow}.` };
    // A page with nothing to press is a hidden bot check or a page that never loaded; tell the agent what to do.
    if (!view.elements.length) return { ...view, note: 'Nothing usable on this page yet (still loading, or a hidden bot check). Use wait once; then clear_bot_check; if it stays empty, call store_restricted and move on.' };
    // The cart count is only evidence when we know where it started, so take it before Aeri touches anything.
    // Some stores show 0 until the person's account loads, so keep the highest count seen before Aeri acts.
    if (session && !session.acted && view.cartCount !== null) session.lastCount = Math.max(session.lastCount ?? 0, view.cartCount);
    return { ...view, elements: view.elements.filter(el => !forbidden.test(el.name)) };
  };
  const report = async () => run.progress?.({ lines: [...lines.values()], liveViewUrl: session?.liveViewUrl, sessionId: session?.id ?? '', storeUrl: session ? `https://www.${session.domain}/` : '', trace: [...trace] }).catch(() => undefined);
  const closeSession = async () => { if (session) await client.browsers.deleteByID(session.id).catch(() => undefined); session = null; latest = null; };

  const tools = {
    recall: createTool({ id: 'recall', description: 'The person\'s saved preferences (favourite stores, sizes, brands, allergies, location) and what they already have at home.', inputSchema: z.object({}),
      execute: async () => ({ preferences: state.preferences, zip: run.zip ?? null, inventory: state.inventory.slice(0, 60).map(i => ({ name: i.name, quantity: i.quantity, place: i.location })) }) }),
    compare_prices: createTool({ id: 'compare_prices', description: 'Look up current prices and stock for the approved items at one candidate store (reads the store\'s own product pages). Takes about a minute.', inputSchema: z.object({ store: z.string() }),
      execute: async ({ store }) => {
        const domain = candidate(store); if (!domain) return { error: `Only these stores are allowed: ${candidates.join(', ')}` };
        const found = await Promise.all(items.slice(0, 8).map(async item => ({ item, hit: (await discoverProducts(item.name, [domain], 2).catch(() => [])).find(h => /\/(p|ip|dp|pd|product|products)\//.test(new URL(h.url).pathname)) })));
        const verified = await verifyPages(found.flatMap(f => f.hit ? [f.hit.url] : []), () => new Date().toISOString()).catch(() => new Map());
        return { store: domain, items: found.map(({ item, hit }) => { const v = hit ? verified.get(hit.url) : undefined; return { id: item.id, name: item.name, product: hit?.title ?? null, productUrl: hit?.url ?? null, price: v?.priceCents != null ? `$${(v.priceCents / 100).toFixed(2)}` : null, stock: v?.availability ?? 'unknown', blocked: v?.status === 'blocked' }; }) };
      } }),
    store_setup: createTool({ id: 'store_setup', description: 'Kernel\'s working browser settings for a store (proxy, stealth, window) from its Config Registry and Aeri\'s own results.', inputSchema: z.object({ store: z.string() }),
      execute: async ({ store }) => { const domain = candidate(store); if (!domain) return { error: `Only these stores are allowed: ${candidates.join(', ')}` }; const setup = await siteSetup(client, `https://www.${domain}/`); return { store: domain, setup: setup.label, from: setup.source }; } }),
    sign_in_status: createTool({ id: 'sign_in_status', description: 'Whether the person has a saved, working sign-in at this store (Kernel Managed Auth).', inputSchema: z.object({ store: z.string() }),
      execute: async ({ store }) => {
        const domain = candidate(store); if (!domain) return { error: `Only these stores are allowed: ${candidates.join(', ')}` };
        const saved = await run.store.getMerchantConnection(domain);
        if (!saved) return { store: domain, signedIn: false, note: 'No saved sign-in. A guest cart may still work; some stores require sign-in to add items.' };
        const connection = await client.auth.connections.retrieve(saved.connectionId).catch(() => null);
        return { store: domain, signedIn: connection?.status === 'AUTHENTICATED', note: connection?.status === 'AUTHENTICATED' ? 'Signed in.' : 'The saved sign-in expired; the person must sign in again in Aeri.' };
      } }),
    open_store: createTool({ id: 'open_store', description: 'Open a private browser at a candidate store with its working setup and the person\'s sign-in, ready to shop. Returns the page.', inputSchema: z.object({ store: z.string() }),
      execute: async ({ store }) => {
        const domain = candidate(store); if (!domain) return { error: `Only these stores are allowed: ${candidates.join(', ')}` };
        if (session?.domain === domain) return look();
        if (session && [...lines.values()].some(l => l.result === 'added')) return { error: 'Items are already in this store\'s cart. Finish here: record the rest as unavailable or for the person to add.' };
        await closeSession();
        const url = `https://www.${domain}/`;
        if (run.resume?.domain === domain) {
          // Continue in the guest cart's own browser: that's where its cart is.
          session = { id: run.resume.sessionId, domain, liveViewUrl: run.resume.liveViewUrl, lastCount: null, acted: false, pooled: false, signedIn: false };
          await report();
          const view = await look();
          return { ...view, signedIn: false };
        }
        const setup = await siteSetup(client, url).catch(() => null);
        const saved = await run.store.getMerchantConnection(domain);
        const options = await merchantBrowserOptions(client, url, saved?.connectionId, setup ? await launchOptions(client, setup) : undefined).catch(() => merchantBrowserOptions(client, url, undefined, undefined));
        // A saved sign-in can still be held by the browser that just closed; give it a moment and try once more.
        const start = async () => {
          const browser = await storeBrowser(client, setup, options, options.profile?.name);
          const alive = await client.browsers.playwright.execute(browser.session_id, { code: 'return true;', timeout_sec: 20 }).then(() => true, () => false);
          if (alive) return browser;
          await client.browsers.deleteByID(browser.session_id).catch(() => undefined);
          step('open_store', `The ${domain} browser closed while starting; trying again`, false);
          await new Promise(done => setTimeout(done, 15_000));
          return storeBrowser(client, setup, options, options.profile?.name);
        };
        const browser = await start();
        session = { id: browser.session_id, domain, liveViewUrl: browser.browser_live_view_url ?? undefined, lastCount: null, acted: false, pooled: browser.pooled, signedIn: !!options.profile };
        // Always load the store fresh: a saved profile reopens its last tab, and a restored tab of a single-page store
        // (Instacart) never renders.
        await exec(`await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(3000); return page.url();`, 60).catch(() => undefined);
        await report();
        // Some stores render their page a few seconds after load; give them two chances before handing it over.
        let view = await look();
        for (let i = 0; i < 2 && !('blocked' in view) && view.elements.length === 0; i++) {
          await exec('await page.waitForTimeout(4000); return true;', 30).catch(() => undefined);
          view = await look();
        }
        // Read the cart count once more after the account has had time to load.
        if (!('blocked' in view)) { await exec('await page.waitForTimeout(3000); return true;', 20).catch(() => undefined); view = await look(); }
        return { ...view, signedIn: !!options.profile };
      } }),
    look: createTool({ id: 'look', description: 'See the current store page: title, heading, cart count, some text and numbered controls.', inputSchema: z.object({}), execute: async () => look() }),
    wait: createTool({ id: 'wait', description: 'Wait a few seconds for the page to finish loading (prices, delivery options, buttons), then look again.', inputSchema: z.object({ seconds: z.number().int().min(2).max(10).default(5) }),
      execute: async ({ seconds }) => { effort.waits += 1; await exec(`await page.waitForTimeout(${seconds * 1000}); return true;`, seconds + 20).catch(() => undefined); return look(); } }),
    press: createTool({ id: 'press', description: 'Press control number n (button, link, option, tab). Returns the page afterwards.', inputSchema: z.object({ n: z.number().int().min(0) }),
      execute: async ({ n }) => {
        const target = latest?.elements.find(el => el.n === n);
        if (!target || forbidden.test(target.name)) return { error: 'That control is not available. Look again and pick one from the list.' };
        // Confirming someone's age is the person's decision, made in Aeri, never the agent's.
        if (!run.ageConfirmed && confirmsAge(target.name, gateNow))
          return { error: 'Only the person can confirm their age. Record this item as person_needed with reason age_check and continue.' };
        effort.presses += 1; session!.acted = true;
        if (ADD.test(target.name)) effort.addPressed = true;
        await exec(`const el = page.locator('[data-aeri-n="${n}"]').first(); await el.scrollIntoViewIfNeeded().catch(() => undefined); await el.click({ timeout: 8000 }); await page.waitForTimeout(3500); return true;`).catch(error => ({ error: (error as Error).message }));
        return look();
      } }),
    choose: createTool({ id: 'choose', description: 'Pick an option in dropdown n by its visible text (size, count, quantity).', inputSchema: z.object({ n: z.number().int().min(0), option: z.string().min(1).max(80) }),
      execute: async ({ n, option }) => {
        if (!latest?.elements.some(el => el.n === n && el.role === 'dropdown')) return { error: 'That is not a dropdown. Look again.' };
        session!.acted = true;
        await exec(`await page.locator('[data-aeri-n="${n}"]').first().selectOption({ label: ${JSON.stringify(option)} }).catch(async () => page.locator('[data-aeri-n="${n}"]').first().selectOption(${JSON.stringify(option)})); await page.waitForTimeout(2000); return true;`).catch(error => ({ error: (error as Error).message }));
        return look();
      } }),
    search: createTool({ id: 'search', description: 'Type a product search into search box n and press Enter.', inputSchema: z.object({ n: z.number().int().min(0), query: z.string().min(2).max(100) }),
      execute: async ({ n, query }) => {
        const target = latest?.elements.find(el => el.n === n);
        if (!target || !/input|combobox|searchbox|textbox/.test(target.role) || !/search|find|looking for|help you/i.test(target.name)) return { error: 'That isn’t a search box on this page. Use results to open the store’s search page directly.' };
        await exec(`const el = page.locator('[data-aeri-n="${n}"]').first(); await el.fill(${JSON.stringify(query)}); await el.press('Enter'); await page.waitForTimeout(3500); return true;`).catch(error => ({ error: (error as Error).message }));
        return look();
      } }),
    results: createTool({ id: 'results', description: 'Open the store\'s own search results for a product name.', inputSchema: z.object({ query: z.string().min(2).max(100) }),
      execute: async ({ query }) => {
        // Known stores have their own results path; most other shops (including Shopify stores) answer /search?q=.
        const pattern = session ? searchPages[session.domain] ?? '/search?q=' : undefined;
        if (!pattern) return { error: 'Open a store first.' };
        await exec(`await page.goto(${JSON.stringify(`https://www.${session!.domain}${pattern}`)} + encodeURIComponent(${JSON.stringify(query)}), { waitUntil: 'domcontentloaded', timeout: 40000 }); await page.waitForTimeout(3500); return page.url();`, 60).catch(error => ({ error: (error as Error).message }));
        return look();
      } }),
    quick_add: createTool({ id: 'quick_add', description: 'Fast path for an item with a known product page: opens it and presses its add-to-cart button. If it doesn\'t confirm, work the page yourself.', inputSchema: z.object({ item_id: z.string() }),
      execute: async ({ item_id }) => {
        const item = items.find(i => i.id === item_id);
        if (!item?.productUrl || !inStore(item.productUrl)) return { error: 'No product page in this store for that item; search for it instead.' };
        session!.acted = true;
        const outcome = await exec(addScript(item.productUrl, item.packs), 60).catch(error => ({ result: 'uncertain', detail: (error as Error).message })) as { result: string; detail?: string };
        if (outcome.result === 'added') effort.addPressed = true;
        return { ...outcome, page: await look() };
      } }),
    clear_bot_check: createTool({ id: 'clear_bot_check', description: 'Try to get past a "confirm you are a person" check (Kernel\'s solver, then a real press-and-hold).', inputSchema: z.object({}),
      execute: async () => { const ok = session ? await clearChallenge(client, session.id) : false; if (!ok && session) blockedAt = session.domain; return ok ? { cleared: true, page: await look() } : { cleared: false, note: 'The check is still there. Try another store, or leave it for the person in the live view.' }; } }),
    store_restricted: createTool({ id: 'store_restricted', description: 'Tell Aeri this store is limiting you (options or prices never load, add buttons never appear after waiting, repeated checks). Counts against this store\'s setup and returns the next candidate store to try.', inputSchema: z.object({ reason: z.string().max(160) }),
      execute: async ({ reason }) => {
        if (!session) return { error: 'No store is open.' };
        blockedAt = session.domain; limited = true;
        const next = candidates.find(domain => domain !== session!.domain && !tried.has(domain));
        tried.add(session.domain);
        // Anything not added here goes back on the list so the next store gets a fair try.
        if (next) for (const [id, line] of lines) if (line.result !== 'added') lines.delete(id);
        const remaining = items.filter(i => !lines.has(i.id)).map(i => ({ item_id: i.id, name: i.name }));
        if (next) { effort.presses = 0; effort.waits = 0; effort.addPressed = false; effort.nudged.clear(); await report(); }
        return { noted: reason, next: next ?? null, remaining, advice: next ? `Open ${next} and shop the remaining items there.` : 'No other candidate store. Call find_stores to look for one on the web; if that finds nothing usable, record the remaining items for the person.' };
      } }),
    find_stores: createTool({ id: 'find_stores', description: 'Search the web for other stores that sell the items still to buy (US stores with real product pages). Adds them as candidates you may open.', inputSchema: z.object({ item_ids: z.array(z.string()).max(20).optional() }),
      execute: async ({ item_ids }) => {
        if (searches >= 2) return { error: 'You have already searched twice. Use the stores found, or record the remaining items for the person.' };
        searches += 1;
        const wanted = items.filter(i => (item_ids?.length ? item_ids.includes(i.id) : true) && lines.get(i.id)?.result !== 'added');
        if (!wanted.length) return { error: 'Every item is already in a cart.' };
        const found = await discoverStores(wanted.map(i => ({ id: i.id, name: i.name })), { limit: 6 }).catch(() => null);
        if (!found?.searched) return { stores: [], note: 'The web search didn’t answer. Record the remaining items for the person.' };
        const fresh = found.domains.filter(domain => !tried.has(domain) && domain !== session?.domain && !candidates.includes(domain)).slice(0, 4);
        candidates.push(...fresh);
        return { stores: fresh.map(domain => ({ store: domain, carries: `${found.coverage[domain] ?? 0} of ${wanted.length} items` })), all_candidates: candidates };
      } }),
    email_code: createTool({ id: 'email_code', description: 'Read a one-time sign-in code this store emailed to Aeri\'s inbox during this run.', inputSchema: z.object({}),
      execute: async () => { if (!session || !mailboxConfigured() || !run.inboxId) return { code: null, note: run.inboxId ? undefined : 'The person hasn’t set up their Aeri email, so codes can’t be read. Leave the sign-in for them.' }; const found = await findSignInCode(run.inboxId, session.domain, started).catch(() => null); return { code: found?.code ?? null }; } }),
    record_item: createTool({ id: 'record_item', description: 'Record what happened to an approved item at this store. "added" is checked against the store\'s own cart evidence.', inputSchema: z.object({ item_id: z.string(), status: z.enum(['added', 'unavailable', 'person_needed']), reason: blockReasonSchema.optional(), note: z.string().max(160).optional() }),
      execute: async ({ item_id, status, reason, note }) => {
        const item = items.find(i => i.id === item_id);
        if (!item) return { error: 'Unknown item. Use the ids from the request.' };
        // The store's evidence decides, not the agent's account: an item it pressed Add for that is in the cart is added.
        if (status === 'added' || effort.addPressed) {
          // Stores that swap the add button for quantity controls once a product is in the cart (Instacart) show it by name.
          const words = item.name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 3);
          const inCartControl = (name: string) => /^(increment quantity of|increase quantity of|remove|decrement quantity of)\s/i.test(name) && words.some(w => name.toLowerCase().includes(w));
          // The listed controls are capped, so ask the whole page for this product's in-cart controls too.
          const pattern = words.length ? `^(increment quantity of|increase quantity of|decrement quantity of|remove)\\s.*(${words.map(w => w.replace(/[^a-z0-9]/g, '')).join('|')})` : '';
          const evidence = async () => {
            const view = await look();
            const count = 'blocked' in view ? null : view.cartCount;
            const says = !('blocked' in view) && (view.elements.some(el => /^\s*[1-9]\d*\s+in cart\b/i.test(el.name) || inCartControl(el.name)) || /added to (your )?(cart|bag|basket)|item added/i.test(view.text));
            // A bigger count only proves our add when Aeri actually pressed an add control.
            const counted = effort.addPressed && count !== null && session?.lastCount != null && count > session.lastCount;
            // On a product page for this item, a bare "1 in cart" is about this product.
            const onProduct = !('blocked' in view) && /\/(products?|p|ip|dp)\//.test(new URL(view.url).pathname) && words.some(w => view.url.toLowerCase().includes(w));
            const found = !counted && !says && pattern ? Number(await exec(`const named = await page.getByRole('button', { name: new RegExp(${JSON.stringify(pattern)}, 'i') }).count(); const bare = ${onProduct} ? await page.getByText(/^\\s*[1-9]\\d*\\s+in cart\\s*$/i).count() : 0; return named + bare;`, 20).catch(() => 0)) > 0 : false;
            return { view, count, proven: counted || says || found };
          };
          let checked = await evidence();
          // Stores update their cart controls a moment after the click; look once more before calling it unconfirmed.
          if (!checked.proven && effort.addPressed) { await exec('await page.waitForTimeout(2500); return true;', 15).catch(() => undefined); checked = await evidence(); }
          // Last check, for stores with a cart drawer (Instacart can move to another shop's page after an add, so its
          // count isn't comparable): open the drawer, look for this product's own controls, close it again.
          if (!checked.proven && effort.addPressed && pattern) {
            const inDrawer = Number(await exec(`const open = page.getByRole('button', { name: /^view cart/i }).first();
if (!(await open.count())) return 0;
await open.click({ timeout: 5000 }).catch(() => undefined); await page.waitForTimeout(2500);
const scope = page.getByRole('dialog').last();
const hits = await scope.getByRole('button', { name: new RegExp(${JSON.stringify(pattern)}, 'i') }).count().catch(() => 0);
await page.keyboard.press('Escape').catch(() => undefined); await page.waitForTimeout(800);
return hits;`, 25).catch(() => 0));
            if (inDrawer > 0) checked = { ...checked, proven: true };
          }
          // Age-restricted products (alcohol) are added like anything else, but the person needs ID at delivery.
          const restricted = ALCOHOL.test(item.name) || gates.has('age_check') || (!('blocked' in checked.view) && ALCOHOL.test(checked.view.elements.filter(el => inCartControl(el.name)).map(el => el.name).join(' ')));
          if (!checked.proven && status !== 'added') { /* not in the cart: record what the agent said, below */ }
          else if (checked.proven) {
            if (session && checked.count !== null) session.lastCount = checked.count;
            effort.presses = 0; effort.waits = 0; effort.addPressed = false; gates.clear();
            lines.set(item.id, { itemId: item.id, result: 'added', ...(restricted ? { reason: 'age_check' as const, detail: 'Valid ID (21+) needed at delivery.' } : item.packs > 1 ? { detail: `Check that the cart has ${item.packs} packs.` } : {}) });
            await report(); return { recorded: 'added', verified: true };
          }
          if (status === 'added') {
          // No add control was ever pressed, so nothing can have been added: say so instead of hoping.
          if (!effort.addPressed && !effort.nudged.has(`add:${item.id}`)) {
            effort.nudged.add(`add:${item.id}`);
            return { error: 'Nothing was added: you never pressed an add-to-cart control for this item. If the store never shows one after choosing Delivery and waiting, call store_restricted and shop it elsewhere.' };
          }
          lines.set(item.id, { itemId: item.id, result: 'uncertain', detail: `Aeri added this. Check the product and quantity in the cart.${restricted ? ' Valid ID (21+) needed at delivery.' : ''}` });
          effort.addPressed = false; gates.clear();
          await report(); return { recorded: 'check', verified: false, note: 'The store didn\'t show it in the cart yet. If you are sure, move on; the person will check it.' };
          }
        }
        // Diligence is enforced here, not hoped for: before calling something unavailable the agent must have made the
        // store's choices and let the page load at least once.
        // The reason comes from the agent, or from what the pages showed (an age prompt, a sign-in wall, a bot check).
        const why: BlockReason | undefined = reason ?? (['age_check', 'sign_in', 'address', 'bot_check', 'minimum_order'] as const).find(gate => gates.has(gate)) ?? (status === 'unavailable' ? 'out_of_stock' : undefined);
        // Before handing an item back, another store gets a try: an untried candidate, or a web search for one. Only
        // while nothing is in this store's cart yet (a cart can't be split across stores mid-visit). Age checks and
        // addresses are the same everywhere, so those go to the person.
        const untried = candidates.some(domain => domain !== session?.domain && !tried.has(domain));
        const nothingHere = ![...lines.values()].some(line => line.result === 'added');
        if (why !== 'age_check' && why !== 'address' && nothingHere && (untried || searches < 1) && !effort.nudged.has(`switch:${item.id}`)) {
          effort.nudged.add(`switch:${item.id}`);
          return { error: untried ? 'Don’t give up on this item yet: call store_restricted (or simply open the next candidate store) and try it there.' : 'Don’t give up on this item yet: call store_restricted, then find_stores to look for another store that sells it.' };
        }
        if (status === 'unavailable' && (effort.presses < 1 || effort.waits < 1) && !effort.nudged.has(item.id)) {
          effort.nudged.add(item.id);
          return { error: 'Not yet. Press the Delivery option (or Shipping), use wait, and look again; also check for a size or count choice. Then record the result.' };
        }
        effort.presses = 0; effort.waits = 0; effort.addPressed = false; gates.clear();
        lines.set(item.id, status === 'unavailable'
          ? { itemId: item.id, result: 'unavailable', detail: note || 'The store doesn’t seem to carry this', ...(why ? { reason: why } : {}) }
          : { itemId: item.id, result: 'uncertain', detail: note || (why ? `Not added: ${reasonLabel[why]}` : `Search for “${item.name.toLowerCase()}” in the store and add it`), ...(why ? { reason: why } : {}) });
        await report(); return { recorded: status };
      } }),
    show_cart: createTool({ id: 'show_cart', description: 'Open the store\'s real cart so the person can review it. Call once at the end.', inputSchema: z.object({}),
      execute: async () => { if (!session) return { error: 'No store is open.' }; await exec(cartScript(`https://www.${session.domain}/`), 60).catch(() => undefined); return { ok: true }; } }),
  };
  // Every tool call is traced: what Aeri did in words the person can read, whether it worked, and how long it took.
  const itemName = (id: unknown) => items.find(i => i.id === id)?.name ?? 'an item';
  const describe = (name: string, input: Record<string, unknown>, pressed?: string) => ({
    store_setup: `Got the working browser setup for ${input.store}`, sign_in_status: `Checked the sign-in for ${input.store}`, compare_prices: `Checked prices at ${input.store}`,
    open_store: `Opened ${input.store}`, look: 'Read the page', wait: `Waited ${input.seconds ?? 5}s for the page`, press: `Pressed “${pressed ?? `control ${input.n}`}”`,
    choose: `Chose “${input.option}”`, search: `Searched for “${input.query}”`, results: `Opened search results for “${input.query}”`, quick_add: `Tried the product page for ${itemName(input.item_id)}`,
    clear_bot_check: 'Tried to clear a bot check', store_restricted: `Store limited Aeri: ${input.reason}`, find_stores: 'Searched the web for other stores', email_code: 'Looked for an emailed sign-in code',
    record_item: `${itemName(input.item_id)}: ${input.status === 'person_needed' ? 'left for you' : input.status}${input.reason ? ` (${reasonLabel[input.reason as BlockReason]})` : ''}`,
    show_cart: 'Opened the cart', recall: 'Read your preferences',
  } as Record<string, string>)[name] ?? name;
  const outcome = (name: string, result: Record<string, unknown> | undefined) => {
    if (!result || typeof result !== 'object') return '';
    if ('error' in result) return ` — ${result.error}`;
    if ('blocked' in result) return ` — ${result.blocked}`;
    if (name === 'record_item') return result.verified === true ? ', checked in the cart' : result.recorded === 'check' ? ', not confirmed by the store' : '';
    if (name === 'open_store') return ` (${result.signedIn ? 'signed in' : 'guest'})`;
    if (name === 'find_stores' && Array.isArray(result.stores)) return ` — found ${(result.stores as Array<{ store: string }>).map(entry => entry.store).join(', ') || 'none'}`;
    if (name === 'clear_bot_check') return result.cleared ? ' — cleared' : ' — still there';
    const page = ('page' in result ? result.page : result) as { gate?: BlockReason } | undefined;
    return page?.gate ? ` — page ${reasonLabel[page.gate]}` : '';
  };
  for (const [name, entry] of Object.entries(tools)) {
    const original = (entry as { execute?: (input: unknown, context?: unknown) => Promise<unknown> }).execute!;
    (entry as { execute: unknown }).execute = async (input: unknown, context?: unknown) => {
      const args = (input ?? {}) as Record<string, unknown>, started = Date.now();
      const pressed = name === 'press' ? latest?.elements.find(el => el.n === args.n)?.name : undefined;
      let result: Record<string, unknown> | undefined;
      try { result = await original(input, context) as Record<string, unknown> | undefined; }
      catch (error) { step(name, `${describe(name, args, pressed)} — failed: ${(error as Error).message}`, false, Date.now() - started); throw error; }
      const failed = name === 'store_restricted' || (!!result && typeof result === 'object' && ('error' in result || 'blocked' in result || result.cleared === false));
      const said = outcome(name, result);
      // Plain page reads are logged but not kept in the person's trace unless they found something.
      if (name === 'look' && !failed && !said) logEvent('agent.step', { run: runId, userId: run.userId, tool: name, ok: true, ms: Date.now() - started, store: session?.domain });
      else step(name, `${describe(name, args, pressed)}${said}`, !failed, Date.now() - started);
      if (process.env.AERI_AGENT_DEBUG) {
        const view = result && ('elements' in result ? result : (result as { page?: Record<string, unknown> }).page) as { url?: string; elements?: Array<{ name: string }> } | undefined;
        console.warn(`[tool] ${name} ${JSON.stringify(input ?? {}).slice(0, 120)} -> ${view?.url ?? ''} ${view?.elements ? `${view.elements.length} controls, add:${JSON.stringify(view.elements.filter(e => /add to cart|^add\b|delivery|shipping|pickup/i.test(e.name)).map(e => e.name).slice(0, 6))}` : JSON.stringify(result).slice(0, 200)}`);
      }
      return result;
    };
  }
  function candidate(store: string) {
    let domain: string | null = null;
    try { domain = retailerDomain(store.includes('.') ? store : `${store.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`); } catch { return null; }
    return candidates.includes(domain) ? domain : null;
  }

  const prompt = [
    `Approved items (ids are for record_item):`,
    ...items.map(item => `- ${item.id}: ${item.name}, buy ${item.quantity.unit === 'each' ? Math.max(item.quantity.amount, item.packs) : item.packs > 1 ? `${item.packs} packs` : '1 pack'}${item.productUrl ? `, product page: ${item.productUrl}` : ''}`),
    run.chosen ? `The person approved ${run.chosen} in Aeri's comparison.` : 'No store was picked yet.',
    `Candidate stores, in order of preference: ${candidates.join(', ')}.`,
    `Saved preferences: ${Object.entries(state.preferences).map(([k, v]) => `${k}: ${v}`).join('; ') || 'none'}.`,
    run.zip ? `Delivery ZIP: ${run.zip}.` : '',
    run.ageConfirmed ? 'The person confirmed in Aeri that they are 21 or older.' : 'The person hasn’t confirmed their age in Aeri; that only matters if a store asks you to confirm it. Stores that check ID at delivery let you add alcohol like anything else.',
  ].filter(Boolean).join('\n');

  const agent = new Agent({ id: 'aeri-shopping-agent', name: 'Aeri shopping agent', instructions: SYSTEM,
    model: { id: `neon/${process.env.NEON_AI_GATEWAY_MODEL ?? 'gpt-5-4-mini'}`, url: `${base.replace(/\/$/, '')}/v1`, apiKey: key, api: 'chat' }, tools });
  const steps = Math.min(90, 14 + items.length * 12);
  await reserveGatewayRequests(steps);
  let summary = '';
  try {
    const mastra = new Mastra({ agents: { shopper: agent }, logger: false, workers: false });
    const answer = await mastra.getAgent('shopper').generate(prompt, { maxSteps: steps, modelSettings: { maxOutputTokens: 1200 } });
    const done = agentRun(answer, steps);
    await refundGatewayRequests(done.unused);
    summary = done.text;
    if (process.env.AERI_AGENT_DEBUG) console.warn(`[shopping-agent] ${(answer as { steps?: unknown[] }).steps?.length ?? 0} steps: ${summary.slice(0, 400)}`);
  } catch (error) { step('agent', `The agent stopped: ${(error as Error).message}`, false); console.warn(`[shopping-agent] ${runId} ${scrub((error as Error).message).slice(0, 300)}`); }

  // Items the agent never recorded are for the person to add.
  // Items never recorded: say why if the visit showed it (a store limiting Aeri, a bot check), otherwise "other".
  const leftover: BlockReason = gates.has('age_check') ? 'age_check' : botChecked() ? 'bot_check' : limited ? 'store_limited' : 'other';
  for (const item of items) if (!lines.has(item.id)) lines.set(item.id, { itemId: item.id, result: 'uncertain', detail: `Search for “${item.name.toLowerCase()}” in the store and add it`, reason: leftover });
  const results = items.map(item => lines.get(item.id)!);
  const open = current();
  if (open) await recordOutcome(open.domain, (await siteSetup(client, `https://www.${open.domain}/`)).label, blockedAt === open.domain).catch(() => undefined);
  step('done', `${results.filter(line => line.result === 'added').length} of ${items.length} added${open ? ` at ${open.domain}` : ''}`, !!open && results.every(line => line.result === 'added'));
  logEvent('agent.run', { run: runId, userId: run.userId, store: open?.domain, added: results.filter(line => line.result === 'added').length, items: items.length,
    reasons: results.flatMap(line => line.reason ? [line.reason] : []), steps: trace.length });
  if (!open) throw Object.assign(new Error(summary || 'The shopping agent couldn’t open a store'), { trace, runId });
  const storeName = merchantName(open.domain);
  const told = summary && summary.length < 300 && !/[{}]/.test(summary) ? summary : fillNote(results, items.length, storeName);
  // A guest cart exists only in Aeri's private browser; say where it is and that it won't wait forever.
  const guest = !open.signedIn && results.some(line => line.result === 'added') ? ` This ${storeName} cart is a guest cart in Aeri’s private browser: open it from Aeri within 20 minutes to check out.` : '';
  const lastUrl = await exec('return page.url();', 15).catch(() => latest?.url) as string | undefined;
  return { url: `https://www.${open.domain}/`, liveViewUrl: open.liveViewUrl, sessionId: open.id, mode: 'kernel', lines: results, note: `${told}${guest}`,
    signedIn: open.signedIn, cartUrl: storeCartUrl(open.domain, lastUrl), runId, trace };
}
