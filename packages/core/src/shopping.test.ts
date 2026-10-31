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
  const request = { optimize: 'lowest_total' as const, fulfillment: 'either' as const, substitutions: 'ask' as const, preferredMerchants: [], avoid: [] };
  const live = (merchant: string) => quote({ merchant, fulfillment: 'delivery', deliveryFeeCents: null, serviceFeeCents: null, taxRate: null, tipCents: null, distanceMiles: null, distanceMeasure: null });
  const four = [...needs, { id: 'flour', name: 'Flour', quantity: { amount: 1, unit: 'kg' as const } }, { id: 'vanilla', name: 'Vanilla', quantity: { amount: 1, unit: 'each' as const } }];

  it('moves what the first store lacks to another store, even when fees are unknown', () => {
    const offers = [
      offer({ needId: 'tom', merchant: 'Target', priceCents: 300 }), offer({ needId: 'pasta', merchant: 'Target', priceCents: 200 }),
      offer({ needId: 'flour', merchant: 'Walmart', priceCents: 400 }), offer({ needId: 'vanilla', merchant: 'Walmart', priceCents: 600 }), offer({ needId: 'tom', merchant: 'Walmart', priceCents: 350 }),
    ];
    const result = compareBaskets(four, offers, [live('Target'), live('Walmart')], request, id);
    const best = result.baskets.find(b => b.id === result.recommendedId)!;
    expect(best.missing).toBe(0);
    expect(best.merchants).toEqual(['Target', 'Walmart']);
    // Tomatoes stay at Target; only what Target lacks moves.
    expect(best.lines.find(l => l.needId === 'tom')).toMatchObject({ merchant: 'Target' });
    expect(best.lines.filter(l => l.movedFrom).map(l => [l.needId, l.merchant, l.movedFrom])).toEqual([['flour', 'Walmart', 'Target'], ['vanilla', 'Walmart', 'Target']]);
    expect(result.explanation).toMatch(/Target doesn’t have 2 items; Walmart has them\./);
  });

  it('keeps an item no store has as missing and never offers a split that finds nothing extra', () => {
    const offers = [offer({ needId: 'tom', merchant: 'A', priceCents: 300 }), offer({ needId: 'pasta', merchant: 'A', priceCents: 200 }), offer({ needId: 'tom', merchant: 'B', priceCents: 250 })];
    const result = compareBaskets(four, offers, [live('A'), live('B')], request, id);
    expect(result.baskets.every(b => b.merchants.length === 1)).toBe(true);
    expect(result.baskets[0].missing).toBe(2);
  });

  it('does not describe a basket with no readable prices as a $0 total', () => {
    const offers = needs.map(n => offer({ needId: n.id, merchant: 'Target', priceCents: null }));
    const result = compareBaskets(needs, offers, [live('Target')], request, id);
    expect(result.explanation).toMatch(/no prices read yet/);
    expect(result.explanation).not.toMatch(/\$0\.00/);
  });

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

  it('never calls a basket with unknown prices or fees the cheapest', () => {
    const offers = [offer({ needId: 'tom', merchant: 'A', priceCents: 300 }), offer({ needId: 'pasta', merchant: 'A', priceCents: null, verified: false, source: 'exa' })];
    const result = compareBaskets(needs, offers, [quote({ merchant: 'A', fulfillment: 'delivery', deliveryFeeCents: null, serviceFeeCents: null, taxRate: null, tipCents: null, distanceMiles: null, distanceMeasure: null })], { optimize: 'lowest_total', fulfillment: 'either', substitutions: 'ask', preferredMerchants: [], avoid: [] }, id);
    expect(result.explanation).not.toMatch(/lowest all-in cost/);
    expect(result.explanation).toBe('A delivery: 2 of 2 items found, $12.00 so far. Fees, tax and any remaining prices are confirmed at checkout.');
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

describe('owned items cover generic ingredients', () => {
  it('counts a box of spaghetti with a legible size toward a recipe asking for pasta by weight', () => {
    const recipe = (name: string, grams: number): Recipe => ({ id: 'r', title: 'Pasta', servings: 2, source: 'manual', createdAt: at, instructions: [], ingredients: [{ name, quantity: { amount: grams, unit: 'g' }, optional: false }] });
    const box = { id: 's', name: 'Spaghetti', size: '16 oz', quantity: { amount: 1, unit: 'each' as const }, confidence: 'confirmed' as const, updatedAt: at, evidence: [] };
    expect(createCart(recipe('Pasta', 250), [box], at, id).items).toEqual([]);
    expect(createCart(recipe('Spaghetti', 600), [box], at, id).items.map(i => [i.name, i.quantity.amount])).toEqual([['Spaghetti', 146.41]]);
    expect(createCart(recipe('Spaghetti', 250), [{ ...box, name: 'Penne' }], at, id).items).toHaveLength(1);
    expect(createCart(recipe('Pasta', 250), [{ ...box, size: undefined }], at, id).items).toHaveLength(1); // a count with no size can't cover grams
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

describe('recipe lines become a list someone would shop from', () => {
  const line = (name: string, amount: number, unit: string, i: number) => ({ id: String(i), name, quantity: { amount, unit: unit as 'each' }, optional: false, estimatedPriceCents: null, status: 'needed' as const });
  it('drops prep notes, merges the same ingredient across steps and sets water and salt aside', async () => {
    const { shoppable, shoppingName } = await import('./index');
    expect(['Tomatoes (diced and deseeded)', 'Dry mango powder (Amchur)', 'Melted butter', 'Fresh coriander (chopped)', 'Onion petals'].map(shoppingName)).toEqual(['Tomatoes', 'Dry mango powder (Amchur)', 'Butter', 'Coriander', 'Onion']);
    const { items, skipped } = shoppable([['Onion (diced)', 1, 'each'], ['Onion (finely chopped)', 2, 'each'], ['Onion petals', 0.5, 'cup'], ['Cumin seeds (Jeera)', 1, 'tbsp'], ['Cumin seeds (Jeera)', 1, 'tsp'], ['Hot water', 100, 'ml'], ['Salt', 1, 'tsp']].map(([n, a, u], i) => line(n as string, a as number, u as string, i)));
    expect(items.map(i => [i.name, i.quantity.amount, i.quantity.unit])).toEqual([['Onion', 4, 'each'], ['Cumin seeds (Jeera)', 1.33, 'tbsp']]);
    expect(skipped.map(i => i.name)).toEqual(['Water', 'Salt']);
  });
});

describe('saved sizes in photo searches', () => {
  it('uses only the size that fits the item and never types it into the search', async () => {
    const { buildConstraints, searchQuery, sizeFor } = await import('./index');
    const saved = { 'clothing sizes': 'Large size T-shirt, 32 jeans', 'favourite store': 'Target' };
    const cap = { name: 'baseball cap', brand: 'foundr.', category: 'clothing' as const, color: 'beige and black', visibleText: [], uncertain: [], confidence: 0.9 };
    const capConstraints = buildConstraints(cap as never, '', saved);
    expect(capConstraints.size).toBeUndefined();
    expect(searchQuery(cap as never, capConstraints)).toBe('foundr. baseball cap beige and black');
    expect(sizeFor('crew neck t-shirt', saved['clothing sizes'])).toBe('Large');
    expect(sizeFor('slim jeans', saved['clothing sizes'])).toBe('32');
    const shirt = buildConstraints({ ...cap, name: 'crew neck t-shirt' } as never, '', saved);
    expect(shirt.size).toBe('Large');
    expect(searchQuery({ ...cap, name: 'crew neck t-shirt' } as never, shirt)).not.toMatch(/Large|32/);
  });
});
