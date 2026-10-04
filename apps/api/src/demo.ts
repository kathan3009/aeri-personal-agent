import { normalizeName, parsePackSize, type Candidate, type Ingredient, type Offer, type ProductSpec, type Recipe, type RawVideoMap, type ShoppingNeed, type StoreQuote } from '@personal-agent/core';

/**
 * Labeled samples used when no perception or retailer key is configured. Every caller marks the result as a sample
 * (`source: 'demo'` / `'fixture'`) so the app never presents it as something read from the person's media or a store.
 */
export const demoRecipe = (id: string, now: string, sourceUrl?: string, title = 'Creamy tomato pasta'): Recipe => ({
  id, createdAt: now, sourceUrl, title, servings: 2, source: 'demo', sourceKind: sourceUrl ? 'youtube' : 'video_file',
  ingredients: [
    { name: 'Pasta', quantity: { amount: 250, unit: 'g' }, optional: false },
    { name: 'Tomatoes', quantity: { amount: 4, unit: 'each' }, optional: false },
    { name: 'Garlic', quantity: { amount: 3, unit: 'each' }, optional: false },
    { name: 'Cream', quantity: { amount: 150, unit: 'ml' }, optional: false },
    { name: 'Olive oil', quantity: { amount: 2, unit: 'tbsp' }, optional: false },
  ],
  instructions: ['Boil the pasta until tender.', 'Cook chopped tomatoes and garlic in olive oil.', 'Stir in cream, toss with pasta and serve.'],
});

/** A sample walkthrough in the same raw shape Gemini returns, so samples exercise the real normalization path. */
export const demoHouseholdMap = (): RawVideoMap => ({
  summary: 'Sample walkthrough: fridge, then a pantry shelf.', durationSec: 32,
  places: [{ id: 'fridge', name: 'Fridge', kind: 'fridge', start: '0:00', end: '0:15' }, { id: 'pantry', name: 'Pantry shelf', kind: 'pantry', start: '0:16', end: '0:32' }],
  items: [
    { name: 'Milk', brand: 'Organic Valley', variant: 'whole', size: 'half gallon', place: 'fridge', position: 'door', category: 'grocery', perishable: true, count: 1, unit: 'each', countCertain: true, evidence: 'label', evidenceNote: 'Label reads “Organic Valley Whole”', timestamps: ['0:03', '0:12'], confidence: 0.93 },
    { name: 'Eggs', place: 'fridge', position: 'middle shelf', category: 'grocery', perishable: true, count: 6, unit: 'each', countCertain: true, evidence: 'visual', evidenceNote: 'Open carton, six eggs visible', timestamps: ['0:06'], confidence: 0.86 },
    { name: 'Tomatoes', place: 'fridge', position: 'crisper drawer', category: 'grocery', perishable: true, count: 2, unit: 'each', countCertain: false, evidence: 'visual', evidenceNote: 'Two visible; more may be under the bag', timestamps: ['0:09'], confidence: 0.7, closeUp: 'Open the crisper drawer fully so I can count the tomatoes.' },
    { name: 'Greek yogurt', place: 'fridge', position: 'top shelf', category: 'grocery', perishable: true, count: 1, unit: 'each', countCertain: true, evidence: 'visual', evidenceNote: 'White tub, label turned away', timestamps: ['0:11'], confidence: 0.55, closeUp: 'Turn the tub so the label faces the camera.' },
    { name: 'Chickpeas', brand: 'Goya', size: '15.5 oz', place: 'pantry', position: 'middle shelf', category: 'grocery', perishable: false, count: 2, unit: 'each', countCertain: true, evidence: 'label', evidenceNote: 'Two cans, “Goya Chick Peas” legible', timestamps: ['0:19', '0:21'], confidence: 0.9 },
    { name: 'Spaghetti', brand: 'Barilla', size: '16 oz', place: 'pantry', category: 'grocery', perishable: false, count: 1, unit: 'each', countCertain: true, evidence: 'spoken', evidenceNote: 'You said “one box of Barilla spaghetti”', timestamps: ['0:24'], confidence: 0.82 },
    { name: 'Olive oil', place: 'pantry', category: 'grocery', perishable: false, count: 1, unit: 'each', countCertain: true, evidence: 'inferred', evidenceNote: 'Dark bottle shaped like olive oil; no label visible', timestamps: ['0:28'], confidence: 0.4 },
  ],
  unclear: [{ description: 'two jars behind the cereal', place: 'pantry', timestamp: '0:26', ask: 'Move the cereal box and show the two jars behind it.' }],
});

export const demoProductSpec = (): ProductSpec => ({
  category: 'grocery', name: 'Greek yogurt', brand: 'Fage', productLine: 'Total', variant: 'plain 2%', size: '32 oz',
  visibleText: ['FAGE', 'Total 2%', 'Plain Greek strained yogurt', '32 OZ'], uncertain: [], confidence: 0.88,
});

export const demoCandidates = (at: string, id: () => string): Candidate[] => [
  { id: id(), title: 'Fage Total 2% Plain Greek Yogurt, 32 oz', url: 'https://example.com/sample/fage-total-2-32oz', merchant: 'Sample Valley Grocery', source: 'fixture', discoveredAt: at, match: 'similar', reasons: [], warnings: [],
    verification: { status: 'verified', method: 'fixture', checkedAt: at, name: 'Fage Total 2% Plain Greek Yogurt', brand: 'Fage', sizeText: '32 oz', priceCents: 649, availability: 'in_stock', storeLocation: 'Sample Valley Grocery' } },
  { id: id(), title: 'Fage Total 2% Plain Greek Yogurt, 17.6 oz', url: 'https://example.com/sample/fage-total-2-17oz', merchant: 'Sample Corner Market', source: 'fixture', discoveredAt: at, match: 'similar', reasons: [], warnings: [],
    verification: { status: 'verified', method: 'fixture', checkedAt: at, name: 'Fage Total 2% Plain Greek Yogurt', brand: 'Fage', sizeText: '17.6 oz', priceCents: 449, availability: 'in_stock', storeLocation: 'Sample Corner Market' } },
  { id: id(), title: 'Store-brand Plain Greek Yogurt 2%, 32 oz', url: 'https://example.com/sample/store-greek-32oz', merchant: 'Sample Corner Market', source: 'fixture', discoveredAt: at, match: 'similar', reasons: [], warnings: [],
    verification: { status: 'verified', method: 'fixture', checkedAt: at, name: 'Plain Greek Yogurt 2%', brand: 'Corner Market', sizeText: '32 oz', priceCents: 499, availability: 'in_stock' } },
  { id: id(), title: 'Fage Total Plain Greek Yogurt 32 oz', url: 'https://example.com/sample/fage-total-32oz-listing', merchant: 'Sample Fresh Mart', source: 'fixture', discoveredAt: at, match: 'similar', reasons: [], warnings: [] },
];

// Sample shelf prices: [price in cents, pack size]. Unknown items get a stable made-up price, labeled as a sample.
const catalog: Record<string, [number, string]> = {
  pasta: [149, '16 oz'], spaghetti: [149, '16 oz'], tomato: [69, '1 each'], garlic: [50, '1 each'], cream: [299, '16 fl oz'], 'olive oil': [899, '500 ml'],
  milk: [349, 'half gallon'], egg: [399, '12 ct'], 'greek yogurt': [649, '32 oz'], chickpea: [129, '15.5 oz'], onion: [89, '1 each'], butter: [499, '16 oz'],
  rice: [299, '2 lb'], parmesan: [599, '8 oz'], basil: [249, '0.75 oz'], lemon: [79, '1 each'], 'chicken breast': [899, '1.5 lb'], bread: [349, '1 each'],
};
const stablePrice = (name: string) => 199 + ([...normalizeName(name)].reduce((sum, ch) => sum * 31 + ch.charCodeAt(0), 7) % 400);
const stores = [
  { merchant: 'Sample Corner Market', factor: 1.0, quote: { fulfillment: 'delivery' as const, deliveryFeeCents: 399, serviceFeeCents: 199, minimumOrderCents: 1000, smallOrderFeeCents: 200, taxRate: 0, tipCents: 300, distanceMiles: 2.1, distanceMeasure: 'straight_line' as const, etaMinutes: 75 } },
  { merchant: 'Sample Valley Grocery', factor: 0.92, quote: { fulfillment: 'pickup' as const, deliveryFeeCents: null, serviceFeeCents: 0, minimumOrderCents: null, smallOrderFeeCents: null, taxRate: 0, tipCents: null, distanceMiles: 3.4, distanceMeasure: 'straight_line' as const, etaMinutes: 120 } },
  { merchant: 'Sample Fresh Mart', factor: 0.85, quote: { fulfillment: 'delivery' as const, deliveryFeeCents: 0, serviceFeeCents: null, minimumOrderCents: null, smallOrderFeeCents: null, taxRate: 0, tipCents: null, distanceMiles: 5.8, distanceMeasure: 'straight_line' as const, etaMinutes: 180 } },
];
/** Three sample stores for rehearsal: one delivery, one cheaper pickup, one whose fees are unknown. */
export function fixtureMarket(needs: ShoppingNeed[], now: string, id: () => string): { offers: Offer[]; quotes: StoreQuote[] } {
  const offers: Offer[] = [];
  for (const need of needs) {
    const key = normalizeName(need.name);
    const [price, pack] = catalog[key] ?? [stablePrice(need.name), need.quantity.unit === 'each' ? '1 each' : '16 oz'];
    stores.forEach((store, index) => {
      if (index === 2 && key === 'cream') return; // one store is out of an item, to show how gaps are handled
      offers.push({ id: id(), needId: need.id, merchant: store.merchant, title: `${need.brand ? `${need.brand} ` : ''}${need.name} (${pack})`, url: `https://example.com/sample/${encodeURIComponent(key)}`, brand: need.brand,
        packSize: parsePackSize(pack) ?? undefined, priceCents: Math.round(price * store.factor), inStock: true, capturedAt: now, source: 'fixture', verified: true });
    });
  }
  return { offers, quotes: stores.map(store => ({ merchant: store.merchant, ...store.quote, capturedAt: now, source: 'fixture' as const })) };
}

const amountWord = (value: string) => ({ a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, a_dozen: 12 } as Record<string, number>)[value.toLowerCase().replace(' ', '_')] ?? Number(value);
export type Command = { kind: 'inventory' | 'consume' | 'preference' | 'recipe' | 'where' | 'link' | 'unknown'; key?: string; value?: string };
export function parseShoppingCommand(text: string): Command {
  const s = text.trim();
  const quantity = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|a dozen)';
  const used = s.match(new RegExp(`(?:we used|i used|we ate|i ate|we finished|i finished)\\s+${quantity}\\s+(.+?)(?:\\s+from (?:the )?(?:fridge|pantry|kitchen))?[.!]?$`, 'i'));
  if (used) return { kind: 'consume', key: used[2].replace(/[.!]$/, ''), value: String(amountWord(used[1])) };
  const have = s.match(new RegExp(`(?:i have|we have|i've got|we've got|add)\\s+${quantity}\\s+(.+?)(?:\\s+in (?:the )?(?:fridge|pantry|kitchen|closet))?[.!]?$`, 'i'));
  if (have) return { kind: 'inventory', key: have[2].replace(/[.!]$/, ''), value: String(amountWord(have[1])) };
  if (/^(where(?:'s| is| are| did i (?:last )?(?:see|put|leave))|do i have|have i got)\b/i.test(s)) return { kind: 'where', key: s };
  const size = s.match(/(?:my|i wear|i use)\s+(.+?)\s+(?:size is|size)\s+(.+?)[.!]?$/i);
  if (size) return { kind: 'preference', key: `${size[1]} size`, value: size[2].replace(/[.!]$/, '') };
  const clothing = s.match(/i (?:wear|use)\s+(?:a\s+)?(.+?)\s+(?:in|for)\s+(.+?)[.!]?$/i);
  if (clothing) return { kind: 'preference', key: `${clothing[2]} size`, value: clothing[1].replace(/[.!]$/, '') };
  const zip = s.match(/(?:my zip(?: code)? is|i live (?:in|near))\s+(.+?)[.!]?$/i);
  if (zip) return { kind: 'preference', key: 'location', value: zip[1] };
  const budget = s.match(/(?:my )?(weekly |monthly )?(?:grocery )?budget is\s+\$?(\d+(?:\.\d+)?)/i);
  if (budget) return { kind: 'preference', key: `${budget[1]?.trim() ? `${budget[1].trim()} ` : ''}budget`, value: `$${budget[2]}` };
  const preference = s.match(/(?:remember that|remember)\s+(.+?)[.!]?$/i);
  if (preference) return { kind: 'preference', key: 'note', value: preference[1].replace(/[.!]$/, '') };
  if (/https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//i.test(s)) return { kind: 'recipe' };
  if (/https?:\/\/\S+/i.test(s)) return { kind: 'link' };
  return { kind: 'unknown' };
}

export function parseIngredients(value: unknown): Ingredient[] {
  if (!Array.isArray(value)) throw new Error('Ingredients must be an array');
  return value.map((entry: unknown) => {
    const item = entry as Record<string, unknown>;
    return { name: String(item.name), quantity: { amount: Number(item.amount ?? 1), unit: String(item.unit ?? 'each') as Ingredient['quantity']['unit'] }, optional: Boolean(item.optional) };
  });
}
