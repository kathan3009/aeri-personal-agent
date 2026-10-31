import { z } from 'zod';
import { normalizeName, nameOverlap } from './names';
import { quantitySchema, unitSchema, type Quantity } from './units';
import { categorySchema, formatTimestamp, placeKindSchema, type Observation, type Place, type Scan, type Unseen } from './video';

/** Where a remembered fact came from, so the app can show the moment or message behind it. */
export const evidenceRefSchema = z.object({
  sourceType: z.enum(['video', 'voice', 'chat', 'manual', 'order', 'photo']),
  sourceId: z.string().optional(), atSec: z.number().nonnegative().optional(), frame: z.string().optional(), at: z.string(),
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** Every inventory item is a user-confirmed fact. Model sightings stay in a scan until the person confirms them. */
export const inventoryItemSchema = z.object({
  id: z.string(), name: z.string().min(1), quantity: quantitySchema,
  confidence: z.enum(['confirmed', 'estimated']).default('confirmed'),
  updatedAt: z.string(), note: z.string().optional(),
  brand: z.string().optional(), variant: z.string().optional(), size: z.string().optional(),
  location: z.string().optional(), placeKind: placeKindSchema.optional(), position: z.string().optional(),
  category: categorySchema.optional(), perishable: z.boolean().optional(), expiresOn: z.string().optional(),
  lastConfirmedAt: z.string().optional(), evidence: z.array(evidenceRefSchema).default([]),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

const perishableWords = /\b(milk|cream|yogurt|yoghurt|cheese|butter|egg|eggs|bread|tortilla|lettuce|spinach|kale|herb|cilantro|parsley|basil|tomato|tomatoes|berr|banana|apple|avocado|meat|chicken|beef|pork|fish|salmon|tofu|juice|mushroom)/;
export const isPerishable = (item: Pick<InventoryItem, 'name' | 'perishable'>) => item.perishable ?? perishableWords.test(item.name.toLowerCase());

export type Freshness = { state: 'fresh' | 'stale' | 'expired'; reason?: string };
const day = 86_400_000;
/** Perishables need a fresh look after a week; everything else after three months. Past an expiry date is expired. */
export function freshness(item: InventoryItem, now: string): Freshness {
  const today = new Date(now).getTime();
  if (!Number.isFinite(today)) return { state: 'fresh' };
  if (item.expiresOn && new Date(item.expiresOn).getTime() + day <= today) return { state: 'expired', reason: `past its ${item.expiresOn} date` };
  const checked = new Date(item.lastConfirmedAt ?? item.updatedAt).getTime();
  if (!Number.isFinite(checked)) return { state: 'fresh' };
  const days = Math.floor((today - checked) / day);
  const limit = isPerishable(item) ? 7 : 90;
  return days > limit ? { state: 'stale', reason: `last checked ${days} days ago` } : { state: 'fresh' };
}

const locationKey = (value?: string) => normalizeName(value ?? '').replace(/\b(the|my)\b/g, '').trim();
const samePlace = (item: InventoryItem, place?: Place) => !place || !item.location || locationKey(item.location) === locationKey(place.name) || (!!item.placeKind && item.placeKind !== 'other' && item.placeKind === place.kind);

function matchFor(inventory: InventoryItem[], name: string, place?: Place) {
  return inventory.find(item => normalizeName(item.name) === normalizeName(name) && samePlace(item, place));
}

/**
 * Compares a fresh map with confirmed memory: each sighting becomes new/same/more/fewer, and confirmed items in a place
 * the clip covered that were not seen are listed so the person can say whether they are gone.
 */
export function reconcile(observations: Observation[], places: Place[], inventory: InventoryItem[]): { observations: Observation[]; unseen: Unseen[] } {
  const placeOf = (id?: string) => places.find(p => p.id === id);
  const matched = new Set<string>();
  const next = observations.map(observation => {
    const item = matchFor(inventory, observation.name, placeOf(observation.placeId));
    if (!item || item.confidence !== 'confirmed') return { ...observation, change: { kind: 'new' as const } };
    matched.add(item.id);
    const q = observation.quantity;
    const kind = !q ? 'same' : q.unit !== item.quantity.unit ? 'different_unit' : q.amount > item.quantity.amount ? 'more' : q.amount < item.quantity.amount ? 'fewer' : 'same';
    return { ...observation, change: { kind, inventoryId: item.id, previous: item.quantity } as Observation['change'] };
  });
  const unseen: Unseen[] = [];
  for (const item of inventory) {
    if (matched.has(item.id) || item.confidence !== 'confirmed' || !item.location) continue;
    const place = places.find(p => locationKey(p.name) === locationKey(item.location));
    if (place) unseen.push({ inventoryId: item.id, name: item.name, placeId: place.id, previous: item.quantity });
  }
  return { observations: next, unseen };
}

export const correctionSchema = z.object({
  decision: z.enum(['accepted', 'rejected']),
  name: z.string().trim().min(1).max(80).optional(), amount: z.number().positive().max(100000).optional(), unit: unitSchema.optional(),
  brand: z.string().trim().max(80).optional(), variant: z.string().trim().max(80).optional(),
  place: z.string().trim().max(60).optional(), position: z.string().trim().max(80).optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type Correction = z.infer<typeof correctionSchema>;
export type Decision = 'accepted' | 'rejected' | Correction;
export type InventoryEvent = { type: 'inventory.confirmed' | 'inventory.corrected' | 'inventory.removed'; name: string; inventoryId: string; from?: Quantity; to?: Quantity; corrected?: string[] };

/**
 * Applies the person's review of a scan. Only accepted (and possibly corrected) sightings become memory; a sighting
 * whose count is unclear must be given a count. `unseen` answers let the person say a remembered item is gone.
 */
export function confirmScan(scan: Scan, decisions: Record<string, Decision>, inventory: InventoryItem[], now: string, id: () => string, unseen: Record<string, 'gone' | 'keep'> = {}): { scan: Scan; inventory: InventoryItem[]; events: InventoryEvent[] } {
  if (scan.status !== 'needs_review') throw new Error('Scan is not ready for review');
  if (scan.observations.some(item => !decisions[item.id])) throw new Error('Every observation needs a decision');
  const next = inventory.map(item => ({ ...item, quantity: { ...item.quantity }, evidence: [...item.evidence] }));
  const events: InventoryEvent[] = [];
  const placeOf = (pid?: string) => scan.places.find(p => p.id === pid);
  const observations = scan.observations.map(observation => {
    const raw = decisions[observation.id];
    const decision = typeof raw === 'string' ? { decision: raw } as Correction : correctionSchema.parse(raw);
    if (decision.decision !== 'accepted') return { ...observation, decision: 'rejected' as const };
    // An unclear count is never confirmed by default; the person has to state it.
    const amount = decision.amount ?? (observation.countCertain ? observation.quantity?.amount : undefined);
    if (!amount) throw new Error(`Say how many ${observation.name.toLowerCase()} there are, or skip it`);
    const quantity: Quantity = { amount, unit: decision.unit ?? observation.quantity?.unit ?? 'each' };
    const place = decision.place ? scan.places.find(p => locationKey(p.name) === locationKey(decision.place)) ?? { id: '', name: decision.place, kind: 'other' as const } : placeOf(observation.placeId);
    const name = decision.name ?? observation.name;
    const corrected = (['name', 'amount', 'unit', 'brand', 'variant', 'place', 'position', 'expiresOn'] as const).filter(key => decision[key] !== undefined);
    const ref = { sourceType: 'video' as const, sourceId: scan.id, atSec: observation.sightings[0]?.startSec, frame: observation.sightings[0]?.frame, at: now };
    const existing = observation.change?.inventoryId && !decision.name ? next.find(item => item.id === observation.change!.inventoryId) : matchFor(next, name, place);
    const facts = {
      brand: decision.brand ?? observation.brand, variant: decision.variant ?? observation.variant, size: observation.size,
      location: place?.name, placeKind: place?.kind, position: decision.position ?? observation.position,
      category: observation.category, perishable: observation.perishable, expiresOn: decision.expiresOn,
    };
    const defined = Object.fromEntries(Object.entries(facts).filter(([, v]) => v !== undefined));
    if (existing) {
      const from = existing.quantity;
      Object.assign(existing, defined, { name: decision.name ?? existing.name, quantity, confidence: 'confirmed', updatedAt: now, lastConfirmedAt: now, evidence: [ref, ...existing.evidence].slice(0, 5) });
      events.push({ type: corrected.length ? 'inventory.corrected' : 'inventory.confirmed', name, inventoryId: existing.id, from, to: quantity, corrected });
    } else {
      const item = inventoryItemSchema.parse({ id: id(), name, quantity, confidence: 'confirmed', updatedAt: now, lastConfirmedAt: now, evidence: [ref], ...defined });
      next.push(item);
      events.push({ type: corrected.length ? 'inventory.corrected' : 'inventory.confirmed', name, inventoryId: item.id, to: quantity, corrected });
    }
    return { ...observation, decision: 'accepted' as const, name, quantity, brand: facts.brand, variant: facts.variant };
  });
  let kept = next;
  for (const entry of scan.unseen) {
    const answer = unseen[entry.inventoryId];
    const item = kept.find(i => i.id === entry.inventoryId);
    if (!item || !answer) continue;
    if (answer === 'gone') { kept = kept.filter(i => i.id !== item.id); events.push({ type: 'inventory.removed', name: item.name, inventoryId: item.id, from: item.quantity }); }
    else { item.lastConfirmedAt = now; item.updatedAt = now; }
  }
  return { scan: { ...scan, status: 'confirmed', reviewedAt: now, observations }, inventory: kept, events };
}

/** "Where is the blue jacket?" from confirmed memory and the video moment it was confirmed from. */
export function whereIs(query: string, inventory: InventoryItem[], scans: Scan[]): { item: InventoryItem; answer: string; scanId?: string; atSec?: number } | null {
  const target = query.replace(/^(where(?:'s| is| are| did i (?:last )?(?:see|put|leave))|have i got|do i have)\s+/i, '').replace(/^(the|my|our|a|an|some)\s+/i, '').replace(/[?.!]+$/, '').trim();
  if (!target) return null;
  const ranked = inventory.filter(item => item.confidence === 'confirmed')
    .map(item => ({ item, score: Math.max(nameOverlap(target, item.name), nameOverlap(target, [item.variant, item.brand, item.name].filter(Boolean).join(' '))) }))
    .filter(entry => entry.score >= 0.5).sort((a, b) => b.score - a.score);
  const best = ranked[0]?.item;
  if (!best) return null;
  const video = best.evidence.find(ref => ref.sourceType === 'video');
  const scan = video?.sourceId ? scans.find(s => s.id === video.sourceId) : undefined;
  const where = best.location ? `${best.location.toLowerCase()}${best.position ? ` (${best.position})` : ''}` : 'no place saved';
  const when = video ? `seen at ${formatTimestamp(video.atSec ?? 0)} in your video from ${new Date(video.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : `confirmed ${new Date(best.lastConfirmedAt ?? best.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
  const label = [best.brand, best.variant?.toLowerCase(), best.name.toLowerCase()].filter(Boolean).join(' ');
  return { item: best, scanId: scan?.id, atSec: video?.atSec, answer: best.location ? `Your ${label} ${best.quantity.amount === 1 || best.quantity.unit !== 'each' ? 'is' : 'are'} in the ${where} (${when}).` : `I remember ${label}, but not where it is (${when}).` };
}
