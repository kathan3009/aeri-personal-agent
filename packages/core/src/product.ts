import { z } from 'zod';
import { nameOverlap, normalizeName } from './names';
import { parsePackSize, toBase } from './units';

/** What a photo shows about a product. Anything the image cannot settle is listed in `uncertain`. */
export const productSpecSchema = z.object({
  category: z.enum(['grocery', 'household', 'clothing', 'personal_care', 'electronics', 'other']).default('other'),
  name: z.string().min(1), brand: z.string().optional(), productLine: z.string().optional(), variant: z.string().optional(),
  size: z.string().optional(), color: z.string().optional(), material: z.string().optional(),
  visibleText: z.array(z.string()).default([]), barcode: z.string().optional(),
  uncertain: z.array(z.enum(['name', 'brand', 'variant', 'size', 'color'])).default([]),
  closeUp: z.string().optional(), confidence: z.number().min(0).max(1).default(0.5),
});
export type ProductSpec = z.infer<typeof productSpecSchema>;

/** Facts read from the retailer's own product page at a moment in time. Unknown stays unknown. */
export const verificationSchema = z.object({
  status: z.enum(['verified', 'partial', 'failed', 'blocked']), method: z.enum(['kernel', 'fixture']), checkedAt: z.string(),
  name: z.string().optional(), brand: z.string().optional(), sku: z.string().optional(), gtin: z.string().optional(),
  priceCents: z.number().int().nonnegative().optional(), currency: z.string().optional(),
  availability: z.enum(['in_stock', 'out_of_stock', 'limited', 'unknown']).default('unknown'),
  sizeText: z.string().optional(), storeLocation: z.string().optional(), url: z.string().optional(), note: z.string().optional(),
});
export type Verification = z.infer<typeof verificationSchema>;

export const matchSchema = z.enum(['exact', 'likely', 'similar', 'mismatch']);
export type Match = z.infer<typeof matchSchema>;
export const candidateSchema = z.object({
  id: z.string(), title: z.string(), url: z.string().url(), merchant: z.string(), snippet: z.string().optional(),
  source: z.enum(['exa', 'fixture']), discoveredAt: z.string(), verification: verificationSchema.optional(),
  match: matchSchema.default('similar'), reasons: z.array(z.string()).default([]), warnings: z.array(z.string()).default([]),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const constraintsSchema = z.object({
  brand: z.string().optional(), size: z.string().optional(), sizeRule: z.enum(['same', 'smallest', 'largest']).optional(),
  maxPriceCents: z.number().int().positive().optional(), organic: z.boolean().optional(),
  avoid: z.array(z.string()).default([]), diet: z.array(z.string()).default([]), preferredMerchants: z.array(z.string()).default([]),
  fulfillment: z.enum(['delivery', 'pickup', 'either']).default('either'), nearest: z.boolean().optional(), location: z.string().optional(),
  /** Plain-language list of what was applied and why, shown to the person. */
  applied: z.array(z.string()).default([]),
});
export type Constraints = z.infer<typeof constraintsSchema>;

export const photoSearchSchema = z.object({
  id: z.string(), createdAt: z.string(), updatedAt: z.string(), instruction: z.string().default(''),
  status: z.enum(['searching', 'ready', 'failed']), source: z.enum(['demo', 'gemini', 'gateway']),
  spec: productSpecSchema.optional(), query: z.string().optional(), constraints: constraintsSchema.optional(),
  candidates: z.array(candidateSchema).default([]), error: z.string().optional(), cartId: z.string().optional(),
  discovery: z.enum(['exa', 'fixture', 'none']).default('none'),
});
export type PhotoSearch = z.infer<typeof photoSearchSchema>;

const list = (value?: string) => (value ?? '').split(/,|;|\band\b|\//i).map(s => s.trim()).filter(Boolean);
const money = (text: string) => { const m = text.match(/\$\s?(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:dollars|usd|bucks)/i); return m ? Math.round(Number(m[1] ?? m[2]) * 100) : undefined; };

/**
 * Combines a one-time instruction ("same brand, under $20") with confirmed preferences. Preferences only apply when the
 * person saved them; the instruction wins when the two conflict.
 */
const garments: Array<[string, RegExp]> = [
  ['shirt', /\b(t-?shirts?|tees?|shirts?|tops?|hoodies?|sweat\w*|sweaters?|jackets?|coats?|blouses?|polos?)\b/i],
  ['pants', /\b(jeans?|pants?|trousers?|shorts?|chinos?|leggings?|skirts?|joggers?)\b/i],
  ['shoe', /\b(shoes?|sneakers?|boots?|sandals?|trainers?|loafers?|heels?)\b/i],
];
/** Hats, bags and other one-size things have no garment size. */
export const garment = (text: string) => /\b(hats?|caps?|beanies?|bags?|belts?|scarf|scarves|gloves?|socks?|watch\w*|sunglasses)\b/i.test(text) ? undefined : garments.find(([, pattern]) => pattern.test(text))?.[0];
/** The part of a saved size note that fits this item: "Large size T-shirt, 32 jeans" → "Large" for a shirt, "32" for jeans. */
export function sizeFor(item: string, saved: string): string | undefined {
  const kind = garment(item);
  if (!kind) return undefined;
  const part = saved.split(/[,;]|\band\b/).map(p => p.trim()).find(p => garments.find(([k]) => k === kind)![1].test(p));
  if (!part) return undefined;
  return part.replace(garments.find(([k]) => k === kind)![1], '').replace(/\bsize\b/i, '').replace(/\s+/g, ' ').trim() || undefined;
}

export function buildConstraints(spec: ProductSpec, instruction: string, preferences: Record<string, string>): Constraints {
  const text = instruction.toLowerCase();
  const applied: string[] = [];
  const c: Constraints = { avoid: [], diet: [], preferredMerchants: [], fulfillment: 'either', applied };
  if (/same brand|this brand|exact/.test(text) && spec.brand) { c.brand = spec.brand; applied.push(`Same brand: ${spec.brand}`); }
  const under = /(under|below|less than|max|at most|up to|within)\s*\$?\s?\d/.test(text) ? money(text) : undefined;
  if (under) { c.maxPriceCents = under; applied.push(`Under $${(under / 100).toFixed(2).replace(/\.00$/, '')}`); }
  if (/smallest/.test(text)) { c.sizeRule = 'smallest'; applied.push('Smallest size'); }
  else if (/largest|biggest|bulk/.test(text)) { c.sizeRule = 'largest'; applied.push('Largest size'); }
  else if (/same size|this size/.test(text) && spec.size) { c.sizeRule = 'same'; c.size = spec.size; applied.push(`Same size: ${spec.size}`); }
  if (/organic/.test(text)) { c.organic = true; applied.push('Organic only'); }
  if (/pick ?up/.test(text)) c.fulfillment = 'pickup'; else if (/deliver/.test(text)) c.fulfillment = 'delivery';
  if (c.fulfillment !== 'either') applied.push(c.fulfillment === 'pickup' ? 'Pickup' : 'Delivery');
  if (/nearest|closest|nearby|near me/.test(text)) { c.nearest = true; applied.push('Nearest store'); }
  for (const m of text.matchAll(/\b(?:no|without|avoid)\s+([a-z][a-z -]{2,24}?)(?=[,.;]|$|\s+(?:and|or|please)\b)/g)) c.avoid.push(m[1].trim());
  for (const [rawKey, value] of Object.entries(preferences)) {
    const key = normalizeName(rawKey);
    if (/allerg|avoid|never buy/.test(key)) for (const v of list(value)) { if (!c.avoid.includes(v.toLowerCase())) { c.avoid.push(v.toLowerCase()); applied.push(`Avoids ${v} (saved)`); } }
    else if (/^diet|dietary|vegan|vegetarian|gluten/.test(key)) for (const v of list(value)) { c.diet.push(v); applied.push(`${v} (saved)`); }
    else if (/favorite store|preferred store|store/.test(key)) for (const v of list(value)) { c.preferredMerchants.push(v); }
    else if (/^(zip|postal code|address|location|home)$/.test(key)) { c.location = value; applied.push(`Near ${value} (saved)`); }
    else if (spec.category === 'clothing' && /sizes?$/.test(key) && !c.size) {
      const what = key.replace(/\s*sizes?$/, '');
      // "Large T-shirt, 32 jeans" holds several sizes; use only the one for this kind of item (none for a cap).
      const size = (!what || /cloth/.test(what)) ? sizeFor(spec.name, value) : nameOverlap(what, spec.name) > 0 || garment(what) === garment(spec.name) && garment(what) ? value : undefined;
      if (size) { c.size = size; applied.push(`Your ${garment(spec.name) ?? what ?? 'clothing'} size: ${size} (saved)`); }
    } else if (/^(brand|preferred brand|usual brand)\b/.test(key) && !c.brand) {
      const what = key.replace(/^(brand|preferred brand|usual brand)\s*(for)?\s*/, '');
      if (!what || nameOverlap(what, spec.name) > 0) { c.brand = value; applied.push(`Your usual brand: ${value} (saved)`); }
    } else if (/budget/.test(key) && !c.maxPriceCents && !/week|month/.test(key)) { const cents = money(value) ?? Math.round(Number(value.replace(/[^\d.]/g, '')) * 100); if (cents > 0) { c.maxPriceCents = cents; applied.push(`Budget $${(cents / 100).toFixed(2)} (saved)`); } }
  }
  if (c.preferredMerchants.length) applied.push(`Prefers ${c.preferredMerchants.join(', ')} (saved)`);
  return c;
}

/** Search text for discovery. Brand and visible size are included only when the photo shows them. */
export function searchQuery(spec: ProductSpec, constraints: Constraints): string {
  const brand = constraints.brand ?? (spec.uncertain.includes('brand') ? undefined : spec.brand);
  // A saved size is checked on each result, not typed into the search; it would pull in other products ("32 jeans").
  const size = constraints.sizeRule === 'same' ? constraints.size ?? spec.size : undefined;
  return [constraints.organic ? 'organic' : '', brand, spec.productLine, spec.name, spec.variant, size, spec.category === 'clothing' && spec.color ? spec.color : '']
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function sizesMatch(a?: string, b?: string): boolean | null {
  if (!a || !b) return null;
  const x = parsePackSize(a), y = parsePackSize(b);
  if (x && y) {
    const bx = toBase(x), by = toBase(y);
    return bx.dimension === by.dimension && Math.abs(bx.amount - by.amount) / Math.max(bx.amount, by.amount) < 0.03;
  }
  const norm = (s: string) => ({ small: 's', medium: 'm', large: 'l', 'extra large': 'xl', 'x large': 'xl' } as Record<string, string>)[s.toLowerCase().trim()] ?? s.toLowerCase().trim();
  return norm(a) === norm(b) ? true : (b.toLowerCase().includes(a.toLowerCase()) || null);
}

/**
 * Labels a candidate against the photo. "exact" requires the retailer's own page to confirm brand, product, variant,
 * size and price; search snippets alone can never be exact. Hard constraint violations make it a mismatch.
 */
export function classifyCandidate(spec: ProductSpec, constraints: Constraints, candidate: Candidate): Candidate {
  const v = candidate.verification;
  const verified = v?.status === 'verified';
  const name = v?.name ?? candidate.title;
  const text = `${name} ${candidate.snippet ?? ''}`.toLowerCase();
  const reasons: string[] = [], warnings: string[] = [];
  const wantBrand = constraints.brand ?? (spec.uncertain.includes('brand') ? undefined : spec.brand);
  const brandOk = !wantBrand ? null : normalizeName(v?.brand ?? '').includes(normalizeName(wantBrand)) || normalizeName(text).includes(normalizeName(wantBrand));
  const nameScore = nameOverlap([spec.productLine, spec.name].filter(Boolean).join(' '), name);
  // Every distinctive word or number in the variety must appear: "plain 2%" is not "plain whole milk".
  const variantTokens = (spec.variant ?? '').toLowerCase().match(/\d+(?:\.\d+)?%?|[a-z]{3,}/g) ?? [];
  const variantOk = !variantTokens.length || spec.uncertain.includes('variant') ? null : variantTokens.every(token => text.includes(token) || normalizeName(text).split(' ').includes(normalizeName(token)));
  const wantSize = constraints.size ?? (spec.uncertain.includes('size') ? undefined : spec.size);
  const sizeOk = wantSize ? sizesMatch(wantSize, v?.sizeText ?? name) : null;
  let violation = false;
  for (const word of constraints.avoid) if (word && text.includes(word.toLowerCase())) { warnings.push(`Mentions ${word}, which you avoid`); violation = true; }
  if (constraints.organic && !/organic/.test(text)) warnings.push('Not labeled organic');
  if (constraints.maxPriceCents && v?.priceCents != null && v.priceCents > constraints.maxPriceCents) warnings.push(`$${(v.priceCents / 100).toFixed(2)} is over your $${(constraints.maxPriceCents / 100).toFixed(2)} limit`);
  if (v?.availability === 'out_of_stock') warnings.push('Out of stock at the time it was checked');
  if (brandOk === true) reasons.push(`Brand matches (${wantBrand})`); else if (brandOk === false) warnings.push(`Different or unconfirmed brand (wanted ${wantBrand})`);
  if (variantOk === true) reasons.push(`Same ${spec.category === 'clothing' ? 'style' : 'variety'}: ${spec.variant}`); else if (variantOk === false) warnings.push(`Variety not confirmed (${spec.variant})`);
  if (sizeOk === true) reasons.push(`Size matches (${wantSize})`); else if (wantSize) warnings.push(sizeOk === false ? `Different size than ${wantSize}` : `Size not confirmed (${wantSize})`);
  for (const field of spec.uncertain) if (field === 'size' || field === 'variant' || field === 'brand') warnings.push(`Your photo doesn't show the ${field} clearly`);
  if (!verified) warnings.push(v?.status === 'blocked' ? 'The store blocked the check; price and stock unknown' : 'Price, stock and variant not checked at the store yet');
  let match: Match;
  if (violation || (brandOk === false && !!constraints.brand) || sizeOk === false && constraints.sizeRule === 'same') match = 'mismatch';
  else if (verified && brandOk !== false && nameScore >= 0.6 && variantOk !== false && (sizeOk === true || (!wantSize && !spec.uncertain.includes('size'))) && v?.priceCents != null && v.availability !== 'out_of_stock' && !spec.uncertain.length) match = 'exact';
  else if (brandOk !== false && nameScore >= 0.5) match = 'likely';
  else if (nameScore >= 0.3) match = 'similar';
  else match = 'mismatch';
  return { ...candidate, match, reasons, warnings: [...new Set(warnings)] };
}

const order: Record<Match, number> = { exact: 0, likely: 1, similar: 2, mismatch: 3 };
export function rankCandidates(candidates: Candidate[], constraints: Constraints): Candidate[] {
  const preferred = (c: Candidate) => constraints.preferredMerchants.some(m => normalizeName(c.merchant).includes(normalizeName(m).replace(/\s+/g, '')) || normalizeName(c.title).includes(normalizeName(m))) ? 0 : 1;
  return [...candidates].sort((a, b) => order[a.match] - order[b.match]
    || Number(a.verification?.availability === 'out_of_stock') - Number(b.verification?.availability === 'out_of_stock')
    || preferred(a) - preferred(b)
    || (a.verification?.priceCents ?? Infinity) - (b.verification?.priceCents ?? Infinity));
}
