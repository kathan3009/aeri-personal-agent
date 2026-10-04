import { describe, expect, it } from 'vitest';
import { buildConstraints, classifyCandidate, compareBaskets, createCart, packsFor, rankCandidates, type Candidate, type Offer, type ProductSpec, type Recipe, type StoreQuote } from './index';

let n = 0; const id = () => `b${++n}`;
const needs = [
  { id: 'tom', name: 'Tomatoes', quantity: { amount: 4, unit: 'each' as const } },
  { id: 'pasta', name: 'Pasta', quantity: { amount: 500, unit: 'g' as const } },
];
const at = '2026-10-04T12:00:00Z';
const offer = (o: Partial<Offer> & Pick<Offer, 'needId' | 'merchant' | 'priceCents'>): Offer => ({ id: `${o.merchant}-${o.needId}`, title: o.needId, inStock: true, capturedAt: at, source: 'fixture', verified: true, ...o });
const quote = (q: Partial<StoreQuote> & Pick<StoreQuote, 'merchant' | 'fulfillment'>): StoreQuote => ({ deliveryFeeCents: 0, serviceFeeCents: 0, minimumOrderCents: null, smallOrderFeeCents: null, taxRate: 0, tipCents: 0, distanceMiles: 2, distanceMeasure: 'straight_line', etaMinutes: 60, capturedAt: at, source: 'fixture', ...q });

describe('basket comparison', () => {
  it('counts packs from pack sizes', () => {
    expect(packsFor({ amount: 500, unit: 'g' }, { amount: 1, unit: 'lb' })).toEqual({ packs: 2 });
    expect(packsFor({ amount: 4, unit: 'each' })).toEqual({ packs: 4 });
    expect(packsFor({ amount: 1, unit: 'cup' }, { amount: 1, unit: 'lb' }).note).toMatch(/different units/);
  });

  it('ranks by all-in cost, so a cheaper shelf price can lose to fees', () => {
    const offers = [
      offer({ needId: 'tom', merchant: 'A', priceCents: 50 }), offer({ needId: 'pasta', merchant: 'A', priceCents: 150, packSize: { amount: 500, unit: 'g' } }),
      offer({ needId: 'tom', merchant: 'B', priceCents: 70 }), offer({ needId: 'pasta', merchant: 'B', priceCents: 180, packSize: { amount: 500, unit: 'g' } }),
    ];
    const quotes = [quote({ merchant: 'A', fulfillment: 'delivery', deliveryFeeCents: 399, serviceFeeCents: 100, distanceMiles: 2.1 }), quote({ merchant: 'B', fulfillment: 'pickup', distanceMiles: 3.4 })];
    const result = compareBaskets(needs, offers, quotes, { optimize: 'lowest_total', fulfillment: 'either', substitutions: 'ask', preferredMerchants: [], avoid: [] }, id);
    const [best, other] = result.baskets;
    expect(best.merchants).toEqual(['B']);
    expect(best.totalCents).toBe(460);
    expect(other.totalCents).toBe(849);
    expect(result.explanation).toMatch(/B pickup is the lowest all-in cost: \$4.60 all-in, 3.4 mi straight-line/);
    expect(result.explanation).toMatch(/costs \$3.89 more/);
  });

  it('never ranks a basket with unknown fees or missing items above a complete one', () => {
    const offers = [offer({ needId: 'tom', merchant: 'A', priceCents: 10 }), offer({ needId: 'pasta', merchant: 'A', priceCents: 10 }),
      offer({ needId: 'tom', merchant: 'B', priceCents: 100 }), offer({ needId: 'pasta', merchant: 'B', priceCents: 100 }), offer({ needId: 'tom', merchant: 'C', priceCents: 1 })];
    const quotes = [quote({ merchant: 'A', fulfillment: 'delivery', serviceFeeCents: null }), quote({ merchant: 'B', fulfillment: 'pickup' }), quote({ merchant: 'C', fulfillment: 'pickup' })];
    const result = compareBaskets(needs, offers, quotes, { optimize: 'lowest_total', fulfillment: 'either', substitutions: 'ask', preferredMerchants: [], avoid: [] }, id);
    expect(result.baskets.map(b => b.merchants[0])).toEqual(['B', 'A', 'C']);
    expect(result.baskets[1]).toMatchObject({ complete: false, totalCents: null, unknowns: ['A service fee'] });
    expect(result.baskets[2].missing).toBe(1);
  });

  it('proposes a two-store split only when it beats both single stores after fees', () => {
    const offers = [offer({ needId: 'tom', merchant: 'A', priceCents: 100 }), offer({ needId: 'pasta', merchant: 'A', priceCents: 900 }),
      offer({ needId: 'tom', merchant: 'B', priceCents: 900 }), offer({ needId: 'pasta', merchant: 'B', priceCents: 100 })];
    const quotes = [quote({ merchant: 'A', fulfillment: 'pickup' }), quote({ merchant: 'B', fulfillment: 'pickup' })];
    const result = compareBaskets(needs, offers, quotes, { optimize: 'lowest_total', fulfillment: 'either', substitutions: 'ask', preferredMerchants: [], avoid: [] }, id);
    expect(result.baskets[0].merchants).toEqual(['A', 'B']);
    expect(result.baskets[0].totalCents).toBe(500);
    const close = compareBaskets(needs, [...offers.slice(0, 1), offer({ needId: 'pasta', merchant: 'A', priceCents: 200 }), ...offers.slice(2)], quotes, { optimize: 'lowest_total', fulfillment: 'either', substitutions: 'ask', preferredMerchants: [], avoid: [] }, id);
    expect(close.baskets.every(b => b.merchants.length === 1)).toBe(true);
  });

  it('honors pickup-only, distance limits, and the nearest goal with its measure', () => {
    const offers = [offer({ needId: 'tom', merchant: 'A', priceCents: 10 }), offer({ needId: 'pasta', merchant: 'A', priceCents: 10 }), offer({ needId: 'tom', merchant: 'B', priceCents: 50 }), offer({ needId: 'pasta', merchant: 'B', priceCents: 50 })];
    const quotes = [quote({ merchant: 'A', fulfillment: 'pickup', distanceMiles: 5 }), quote({ merchant: 'B', fulfillment: 'pickup', distanceMiles: 1 }), quote({ merchant: 'D', fulfillment: 'delivery' })];
    const result = compareBaskets(needs, offers, quotes, { optimize: 'nearest', fulfillment: 'pickup', maxMiles: 4, substitutions: 'ask', preferredMerchants: [], avoid: [] }, id);
    expect(result.baskets.map(b => b.merchants[0])).toEqual(['B']);
    expect(result.rejected).toEqual([{ merchant: 'A', reason: '5.0 mi is beyond your 4 mi limit' }, { merchant: 'D', reason: 'delivery only' }]);
    expect(result.explanation).toMatch(/closest.*1.0 mi straight-line/);
  });
});

describe('stale memory', () => {
  it('keeps an ingredient on the list with a note when the pantry count is stale', () => {
    const recipe: Recipe = { id: 'r', title: 'Latte', servings: 1, source: 'manual', createdAt: at, instructions: [], ingredients: [{ name: 'Milk', quantity: { amount: 250, unit: 'ml' }, optional: false }, { name: 'Coffee', quantity: { amount: 20, unit: 'g' }, optional: false }] };
    const cart = createCart(recipe, [
      { id: 'm', name: 'milk', quantity: { amount: 1, unit: 'l' }, confidence: 'confirmed', updatedAt: '2026-09-20T12:00:00Z', evidence: [] },
      { id: 'c', name: 'coffee', quantity: { amount: 300, unit: 'g' }, confidence: 'confirmed', updatedAt: '2026-09-20T12:00:00Z', evidence: [] },
    ], at, id);
    expect(cart.items.map(i => i.name)).toEqual(['Milk']);
    expect(cart.items[0].check).toMatch(/last checked 14 days ago/);
  });
});

describe('photo search', () => {
  const spec: ProductSpec = { category: 'grocery', name: 'Greek yogurt', brand: 'Fage', productLine: 'Total', variant: 'plain 2%', size: '32 oz', visibleText: ['FAGE', 'Total 2%'], uncertain: [], confidence: 0.9 };
  const candidate = (c: Partial<Candidate>): Candidate => ({ id: 'c', title: 'Fage Total 2% Plain Greek Yogurt 32 oz', url: 'https://store.example/fage', merchant: 'store.example', source: 'exa', discoveredAt: at, match: 'similar', reasons: [], warnings: [], ...c });

  it('applies the instruction and only saved preferences', () => {
    const c = buildConstraints(spec, 'same brand, under $8, no peanuts', { allergies: 'sesame', 'favorite stores': 'Target, Whole Foods', 'shirt size': 'M' });
    expect(c).toMatchObject({ brand: 'Fage', maxPriceCents: 800, avoid: ['peanuts', 'sesame'], preferredMerchants: ['Target', 'Whole Foods'] });
    expect(c.size).toBeUndefined();
    expect(c.applied).toContain('Avoids sesame (saved)');
  });

  it('never calls an unverified search result an exact match', () => {
    const c = buildConstraints(spec, 'same brand', {});
    expect(classifyCandidate(spec, c, candidate({})).match).toBe('likely');
    const verified = classifyCandidate(spec, c, candidate({ verification: { status: 'verified', method: 'kernel', checkedAt: at, name: 'Fage Total 2% Plain Greek Yogurt', brand: 'FAGE', sizeText: '32 oz', priceCents: 649, availability: 'in_stock' } }));
    expect(verified.match).toBe('exact');
    const otherSize = classifyCandidate(spec, c, candidate({ title: 'Fage Total Plain Greek Yogurt 5.3 oz', verification: { status: 'verified', method: 'kernel', checkedAt: at, name: 'Fage Total Plain Greek Yogurt', brand: 'FAGE', sizeText: '5.3 oz', priceCents: 199, availability: 'in_stock' } }));
    expect(otherSize.match).toBe('likely');
    expect(otherSize.warnings).toContain('Different size than 32 oz');
    expect(classifyCandidate(spec, c, candidate({ title: 'Chobani plain greek yogurt 32 oz' })).match).toBe('mismatch');
    const wholeMilk = classifyCandidate(spec, c, candidate({ title: 'FAGE Total Whole Milk Plain Greek Yogurt, 32 oz', verification: { status: 'verified', method: 'kernel', checkedAt: at, name: 'FAGE Total Whole Milk Plain Greek Strained Yogurt, 32 oz', sizeText: undefined, priceCents: 696, availability: 'in_stock' } }));
    expect(wholeMilk.match).toBe('likely');
    expect(wholeMilk.warnings).toContain('Variety not confirmed (plain 2%)');
  });

  it('does not let an unreadable size become exact', () => {
    const blurry = { ...spec, uncertain: ['size' as const] };
    const result = classifyCandidate(blurry, buildConstraints(blurry, '', {}), candidate({ verification: { status: 'verified', method: 'kernel', checkedAt: at, name: 'Fage Total 2% Plain Greek Yogurt', brand: 'FAGE', sizeText: '32 oz', priceCents: 649, availability: 'in_stock' } }));
    expect(result.match).toBe('likely');
    expect(result.warnings).toContain("Your photo doesn't show the size clearly");
  });

  it('ranks exact, in-stock, preferred-store, cheaper candidates first', () => {
    const c = buildConstraints(spec, '', { 'favorite stores': 'Target' });
    const list = rankCandidates([
      candidate({ id: 'a', match: 'likely', merchant: 'walmart.com' }), candidate({ id: 'b', match: 'likely', merchant: 'target.com' }), candidate({ id: 'e', match: 'exact', merchant: 'kroger.com' }),
    ], c);
    expect(list.map(x => x.id)).toEqual(['e', 'b', 'a']);
  });
});
