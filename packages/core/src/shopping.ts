import { z } from 'zod';
import { normalizeName } from './names';
import { quantitySchema, toBase, type Quantity } from './units';

export const shoppingNeedSchema = z.object({ id: z.string(), name: z.string().min(1), quantity: quantitySchema, brand: z.string().optional() });
export type ShoppingNeed = z.infer<typeof shoppingNeedSchema>;
export const shoppingRequestSchema = z.object({
  optimize: z.enum(['lowest_total', 'nearest', 'fastest', 'preferred_store']).default('lowest_total'),
  fulfillment: z.enum(['delivery', 'pickup', 'either']).default('either'),
  budgetCents: z.number().int().positive().optional(), maxMiles: z.number().positive().optional(),
  substitutions: z.enum(['ask', 'allow', 'none']).default('ask'),
  preferredMerchants: z.array(z.string()).default([]), avoid: z.array(z.string()).default([]),
});
export type ShoppingRequest = z.infer<typeof shoppingRequestSchema>;

/** One product at one store, with the time it was read. `verified` means it came from the store's own page or API. */
export const offerSchema = z.object({
  id: z.string(), needId: z.string(), merchant: z.string(), title: z.string(), url: z.string().url().optional(),
  brand: z.string().optional(), packSize: quantitySchema.optional(), priceCents: z.number().int().nonnegative().nullable(),
  inStock: z.boolean().nullable(), capturedAt: z.string(), source: z.enum(['kernel', 'exa', 'fixture']), verified: z.boolean(),
});
export type Offer = z.infer<typeof offerSchema>;
export const storeQuoteSchema = z.object({
  merchant: z.string(), storeName: z.string().optional(), fulfillment: z.enum(['delivery', 'pickup']),
  deliveryFeeCents: z.number().int().nonnegative().nullable(), serviceFeeCents: z.number().int().nonnegative().nullable(),
  minimumOrderCents: z.number().int().nonnegative().nullable().default(null), smallOrderFeeCents: z.number().int().nonnegative().nullable().default(null),
  taxRate: z.number().min(0).max(0.2).nullable(), tipCents: z.number().int().nonnegative().nullable(),
  distanceMiles: z.number().nonnegative().nullable(), distanceMeasure: z.enum(['straight_line', 'driving']).nullable(),
  etaMinutes: z.number().int().nonnegative().nullable(), capturedAt: z.string(), source: z.enum(['kernel', 'exa', 'fixture']),
});
export type StoreQuote = z.infer<typeof storeQuoteSchema>;

export const basketLineSchema = z.object({
  needId: z.string(), name: z.string(), offerId: z.string().optional(), merchant: z.string().optional(), title: z.string().optional(),
  packs: z.number().int().nonnegative(), lineCents: z.number().int().nonnegative().nullable(),
  status: z.enum(['matched', 'unavailable', 'price_unknown']), note: z.string().optional(),
  /** Set when the first store didn't have this item and it was moved to `merchant`. */
  movedFrom: z.string().optional(),
});
export type BasketLine = z.infer<typeof basketLineSchema>;
export const basketSchema = z.object({
  id: z.string(), merchants: z.array(z.string()), label: z.string(), fulfillment: z.enum(['delivery', 'pickup']),
  lines: z.array(basketLineSchema), subtotalCents: z.number().int().nonnegative(), feesCents: z.number().int().nonnegative(),
  taxCents: z.number().int().nonnegative().nullable(), tipCents: z.number().int().nonnegative().nullable(),
  totalCents: z.number().int().nonnegative().nullable(), knownTotalCents: z.number().int().nonnegative(),
  complete: z.boolean(), missing: z.number().int().nonnegative(), unknowns: z.array(z.string()),
  distanceMiles: z.number().nonnegative().nullable(), distanceMeasure: z.enum(['straight_line', 'driving']).nullable(),
  etaMinutes: z.number().int().nonnegative().nullable(), overBudget: z.boolean(), verified: z.boolean(),
});
export type Basket = z.infer<typeof basketSchema>;
export const proposalSchema = z.object({
  id: z.string(), cartId: z.string(), createdAt: z.string(), expiresAt: z.string(), request: shoppingRequestSchema,
  baskets: z.array(basketSchema), recommendedId: z.string().nullable(), explanation: z.string(),
  rejected: z.array(z.object({ merchant: z.string(), reason: z.string() })).default([]),
  source: z.enum(['fixture', 'live']), chosenId: z.string().optional(),
  offers: z.array(offerSchema).default([]), quotes: z.array(storeQuoteSchema).default([]),
  status: z.enum(['searching', 'ready', 'failed']).default('ready'), error: z.string().optional(),
  /** Which stores were checked and why, so the choice of stores is visible rather than assumed. */
  stores: z.array(z.object({ merchant: z.string(), reason: z.string() })).optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** How many packs of an offer cover a need. Unknown pack size or mismatched units means one pack, flagged. */
export function packsFor(need: Quantity, pack?: Quantity): { packs: number; note?: string } {
  if (!pack) return need.unit === 'each' ? { packs: Math.max(1, Math.ceil(need.amount)) } : { packs: 1, note: 'pack size unknown' };
  const a = toBase(need), b = toBase(pack);
  if (a.dimension !== b.dimension) return { packs: 1, note: 'pack size in different units' };
  return { packs: Math.max(1, Math.ceil(a.amount / b.amount - 1e-9)) };
}

const blocked = (offer: Offer, need: ShoppingNeed, request: ShoppingRequest) =>
  offer.inStock === false
  || (need.brand && !normalizeName(`${offer.brand ?? ''} ${offer.title}`).includes(normalizeName(need.brand)))
  || request.avoid.some(word => offer.title.toLowerCase().includes(word.toLowerCase()));

function single(needs: ShoppingNeed[], offers: Offer[], quote: StoreQuote, request: ShoppingRequest, id: () => string, assign?: Map<string, string>): Basket {
  const lines = needs.map((need): BasketLine | null => {
    if (assign && assign.get(need.id) !== quote.merchant) return null;
    const options = offers.filter(o => o.needId === need.id && o.merchant === quote.merchant && !blocked(o, need, request));
    if (!options.length) return { needId: need.id, name: need.name, packs: 0, lineCents: null, status: 'unavailable' as const, merchant: quote.merchant, note: offers.some(o => o.needId === need.id && o.merchant === quote.merchant && o.inStock === false) ? 'out of stock' : 'not found' };
    const priced = options.filter(o => o.priceCents != null).map(o => { const p = packsFor(need.quantity, o.packSize); return { o, ...p, cents: o.priceCents! * p.packs }; }).sort((a, b) => a.cents - b.cents);
    if (!priced.length) return { needId: need.id, name: need.name, offerId: options[0].id, merchant: quote.merchant, title: options[0].title, packs: 1, lineCents: null, status: 'price_unknown' as const };
    const best = priced[0];
    return { needId: need.id, name: need.name, offerId: best.o.id, merchant: quote.merchant, title: best.o.title, packs: best.packs, lineCents: best.cents, status: 'matched' as const, note: best.note };
  }).filter((line): line is BasketLine => !!line);
  return totals(lines, [quote], request, id, offers);
}

function totals(lines: BasketLine[], quotes: StoreQuote[], request: ShoppingRequest, id: () => string, offers: Offer[]): Basket {
  const unknowns: string[] = [];
  const subtotal = lines.reduce((sum, l) => sum + (l.lineCents ?? 0), 0);
  let fees = 0, tax: number | null = 0, tip: number | null = 0;
  for (const q of quotes) {
    const own = lines.filter(l => l.merchant === q.merchant).reduce((s, l) => s + (l.lineCents ?? 0), 0);
    if (q.deliveryFeeCents == null && q.fulfillment === 'delivery') unknowns.push(`${q.merchant} delivery fee`); else fees += q.deliveryFeeCents ?? 0;
    if (q.serviceFeeCents == null) unknowns.push(`${q.merchant} service fee`); else fees += q.serviceFeeCents;
    if (q.minimumOrderCents && own < q.minimumOrderCents) { if (q.smallOrderFeeCents == null) unknowns.push(`${q.merchant} small-order fee`); else fees += q.smallOrderFeeCents; }
    if (q.taxRate == null) { unknowns.push(`${q.merchant} tax`); tax = null; } else if (tax !== null) tax += Math.round(own * q.taxRate);
    if (q.fulfillment === 'delivery') { if (q.tipCents == null) { unknowns.push(`${q.merchant} tip`); tip = null; } else if (tip !== null) tip += q.tipCents; }
  }
  const missing = lines.filter(l => l.status === 'unavailable').length;
  const unpriced = lines.filter(l => l.status === 'price_unknown').length;
  if (unpriced) unknowns.unshift(`${unpriced} ${unpriced === 1 ? 'price' : 'prices'}`);
  const complete = !missing && !unpriced && !unknowns.length;
  const known = subtotal + fees + (tax ?? 0) + (tip ?? 0);
  const distances = quotes.map(q => q.distanceMiles);
  const etas = quotes.map(q => q.etaMinutes);
  const used = new Set(lines.map(l => l.offerId).filter(Boolean));
  return {
    id: id(), merchants: quotes.map(q => q.merchant), label: quotes.map(q => `${q.storeName ?? q.merchant} ${q.fulfillment}`).join(' + '),
    fulfillment: quotes[0].fulfillment, lines, subtotalCents: subtotal, feesCents: fees, taxCents: tax, tipCents: tip,
    totalCents: complete ? known : null, knownTotalCents: known, complete, missing, unknowns,
    distanceMiles: distances.some(d => d == null) ? null : Math.max(...(distances as number[])),
    distanceMeasure: quotes.every(q => q.distanceMeasure === 'driving') ? 'driving' : quotes.some(q => q.distanceMeasure) ? 'straight_line' : null,
    etaMinutes: etas.some(e => e == null) ? null : Math.max(...(etas as number[])),
    overBudget: !!request.budgetCents && known > request.budgetCents,
    verified: offers.filter(o => used.has(o.id)).every(o => o.verified),
  };
}

const SPLIT_PENALTY_CENTS = 300;
const MAX_STORES = 3;

/**
 * Baskets that get the whole list: start at one store, then take what it lacks from whichever other store has the
 * most of the rest (up to three stores). Items stay at the first store whenever it has them, so fewer orders are split.
 */
function coverage(needs: ShoppingNeed[], offers: Offer[], usable: StoreQuote[], singles: Basket[], request: ShoppingRequest, id: () => string): Basket[] {
  const has = (basket: Basket, needId: string) => basket.lines.some(l => l.needId === needId && l.status !== 'unavailable');
  const found = new Map<string, Basket>();
  usable.forEach((primary, index) => {
    const start = singles[index];
    if (!start.missing) return;
    const assign = new Map(needs.map(need => [need.id, primary.merchant]));
    const stores = [primary];
    let left = needs.filter(need => !has(start, need.id));
    while (left.length && stores.length < MAX_STORES) {
      const next = usable.map((quote, j) => ({ quote, basket: singles[j], gain: left.filter(need => has(singles[j], need.id)).length }))
        .filter(option => !stores.includes(option.quote) && option.gain > 0 && option.quote.fulfillment === primary.fulfillment)
        .sort((a, b) => b.gain - a.gain || a.basket.knownTotalCents - b.basket.knownTotalCents)[0];
      if (!next) break;
      stores.push(next.quote);
      for (const need of left) if (has(next.basket, need.id)) assign.set(need.id, next.quote.merchant);
      left = left.filter(need => !has(next.basket, need.id));
    }
    if (stores.length < 2) return;
    const order = new Map(needs.map((need, i) => [need.id, i]));
    const lines = stores.flatMap(quote => single(needs, offers, quote, request, id, assign).lines.map(line => quote === primary ? line : { ...line, movedFrom: primary.merchant }))
      .sort((a, b) => order.get(a.needId)! - order.get(b.needId)!);
    const basket = totals(lines, stores, request, id, offers);
    const key = [...basket.merchants].sort().join('|');
    const prior = found.get(key);
    if (!prior || basket.missing < prior.missing || (basket.missing === prior.missing && basket.knownTotalCents < prior.knownTotalCents)) found.set(key, basket);
  });
  return [...found.values()];
}
/**
 * Builds one basket per store and, where it actually saves money after both stores' fees plus a small inconvenience
 * allowance, one two-store split. Ranks by the person's goal; incomplete or over-budget baskets never outrank a
 * complete one on price.
 */
export function compareBaskets(needs: ShoppingNeed[], offers: Offer[], quotes: StoreQuote[], request: ShoppingRequest, id: () => string): { baskets: Basket[]; rejected: Array<{ merchant: string; reason: string }>; recommendedId: string | null; explanation: string } {
  const rejected: Array<{ merchant: string; reason: string }> = [];
  const usable = quotes.filter(q => {
    if (request.fulfillment !== 'either' && q.fulfillment !== request.fulfillment) { rejected.push({ merchant: q.merchant, reason: `${q.fulfillment} only` }); return false; }
    if (request.maxMiles && q.distanceMiles != null && q.distanceMiles > request.maxMiles) { rejected.push({ merchant: q.merchant, reason: `${q.distanceMiles.toFixed(1)} mi is beyond your ${request.maxMiles} mi limit` }); return false; }
    return true;
  });
  const baskets = usable.map(q => single(needs, offers, q, request, id));
  for (let i = 0; i < usable.length; i++) for (let j = i + 1; j < usable.length; j++) {
    const [a, b] = [usable[i], usable[j]];
    if (a.fulfillment !== b.fulfillment) continue;
    const [ba, bb] = [baskets[i], baskets[j]];
    if (!ba.complete || !bb.complete) continue;
    const assign = new Map<string, string>();
    for (const need of needs) {
      const la = ba.lines.find(l => l.needId === need.id)!, lb = bb.lines.find(l => l.needId === need.id)!;
      assign.set(need.id, (la.lineCents ?? Infinity) <= (lb.lineCents ?? Infinity) ? a.merchant : b.merchant);
    }
    if (new Set(assign.values()).size < 2) continue;
    const lines = [...single(needs, offers, a, request, id, assign).lines, ...single(needs, offers, b, request, id, assign).lines];
    const split = totals(lines, [a, b], request, id, offers);
    const bestSingle = Math.min(ba.totalCents!, bb.totalCents!);
    if (split.complete && split.totalCents! + SPLIT_PENALTY_CENTS < bestSingle) baskets.push(split);
  }
  const singles = baskets.slice(0, usable.length);
  const fewestMissing = Math.min(...singles.map(b => b.missing));
  // Only offer a multi-store basket when it actually finds more of the list than any one store.
  baskets.push(...coverage(needs, offers, usable, singles, request, id).filter(b => b.missing < fewestMissing));
  const goal = (x: Basket) => request.optimize === 'nearest' ? x.distanceMiles ?? Infinity
    : request.optimize === 'fastest' ? x.etaMinutes ?? Infinity
    : request.optimize === 'preferred_store' ? (x.merchants.some(m => request.preferredMerchants.some(p => normalizeName(m).includes(normalizeName(p)))) ? 0 : 1) * 1e9 + x.knownTotalCents
    : x.knownTotalCents;
  baskets.sort((x, y) => x.missing - y.missing || Number(x.overBudget) - Number(y.overBudget) || Number(!x.complete) - Number(!y.complete) || goal(x) - goal(y) || x.merchants.length - y.merchants.length);
  const recommended = baskets[0] ?? null;
  return { baskets, rejected, recommendedId: recommended?.id ?? null, explanation: explain(baskets, request, rejected) };
}

const miles = (b: Basket) => b.distanceMiles == null ? 'distance unknown' : `${b.distanceMiles.toFixed(1)} mi${b.distanceMeasure === 'straight_line' ? ' straight-line' : b.distanceMeasure === 'driving' ? ' driving' : ''}`;
const total = (b: Basket) => b.complete ? `${dollars(b.totalCents!)} all-in`
  : b.knownTotalCents === 0 && b.lines.every(l => l.status !== 'matched') ? 'no prices read yet' : `${dollars(b.knownTotalCents)} so far`;
const count = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
/** "Target doesn't have 4 items; Walmart has 3 and Kroger has 1." */
function moves(b: Basket): string | null {
  const moved = b.lines.filter(l => l.movedFrom);
  if (!moved.length) return null;
  const by = new Map<string, number>();
  for (const line of moved) by.set(line.merchant!, (by.get(line.merchant!) ?? 0) + 1);
  const parts = [...by].map(([merchant, n]) => `${merchant} has ${n === moved.length && by.size === 1 ? (n === 1 ? 'it' : 'them') : n}`);
  return `${moved[0].movedFrom} doesn’t have ${count(moved.length)}; ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}.`;
}
/** A short, checkable explanation built only from the numbers in the baskets. */
export function explain(baskets: Basket[], request: ShoppingRequest, rejected: Array<{ merchant: string; reason: string }> = []): string {
  if (!baskets.length) return rejected.length ? `No store fits: ${rejected.map(r => `${r.merchant} (${r.reason})`).join('; ')}.` : 'No store options were found.';
  const [best, next] = baskets;
  const parts: string[] = [];
  const goal = request.optimize === 'nearest' ? 'closest' : request.optimize === 'fastest' ? 'fastest' : request.optimize === 'preferred_store' ? 'your preferred store' : 'lowest all-in cost';
  const moved = moves(best);
  if (moved) parts.push(moved);
  // A basket with unknown prices or fees is never called the cheapest.
  if (best.complete || request.optimize !== 'lowest_total') parts.push(`${best.label} is the ${goal}: ${total(best)}${best.distanceMiles != null ? `, ${miles(best)}` : ''}.`);
  else parts.push(`${best.label}: ${best.lines.filter(l => l.status !== 'unavailable').length} of ${best.lines.length} items found, ${total(best)}.`);
  if (next && best.complete && next.complete) {
    const diff = next.totalCents! - best.totalCents!;
    parts.push(diff > 0 ? `${next.label} costs ${dollars(diff)} more.` : `${next.label} is the same price.`);
    if (best.merchants.length > 1 && !moved) parts.push(`Splitting saves more than ${dollars(SPLIT_PENALTY_CENTS)} after both stores' fees.`);
  }
  if (!best.complete) parts.push('Fees, tax and any remaining prices are confirmed at checkout.');
  if (best.overBudget && request.budgetCents) parts.push(`Every option is over your ${dollars(request.budgetCents)} budget.`);
  return parts.join(' ');
}

export const QUOTE_TTL_MS = 30 * 60_000;
export const isStale = (proposal: Pick<Proposal, 'expiresAt'>, now: string) => new Date(now).getTime() >= new Date(proposal.expiresAt).getTime();
