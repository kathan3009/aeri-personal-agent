import { z } from 'zod';
import { quantitySchema, unitSchema, type Quantity } from './units';
import { normalizeName } from './names';

/** Where a clip came from. Only `recorded`, `library`, `file` and `youtube` are real import paths today. */
export const videoSourceSchema = z.object({
  kind: z.enum(['recorded', 'library', 'file', 'youtube', 'link']),
  label: z.string().optional(),
  url: z.string().url().optional(),
  durationSec: z.number().nonnegative().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
});
export type VideoSource = z.infer<typeof videoSourceSchema>;

export const placeKindSchema = z.enum(['fridge', 'freezer', 'pantry', 'shelf', 'cabinet', 'counter', 'closet', 'drawer', 'other']);
export type PlaceKind = z.infer<typeof placeKindSchema>;
export const placeSchema = z.object({
  id: z.string(), name: z.string().min(1), kind: placeKindSchema.default('other'),
  startSec: z.number().nonnegative().optional(), endSec: z.number().nonnegative().optional(),
});
export type Place = z.infer<typeof placeSchema>;

/**
 * How the model knows about an item. `label` = packaging text was legible, `visual` = recognized by appearance,
 * `spoken` = the person said it while recording, `inferred` = a guess (opaque container, partly hidden).
 */
export const evidenceKindSchema = z.enum(['label', 'visual', 'spoken', 'inferred']);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
export const sightingSchema = z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative().optional(), frame: z.string().optional() });
export type Sighting = z.infer<typeof sightingSchema>;
export const categorySchema = z.enum(['grocery', 'household', 'clothing', 'personal_care', 'other']);
export type Category = z.infer<typeof categorySchema>;

/** How a sighting compares with what the person already confirmed. Computed on the server, never by the model. */
export const changeSchema = z.object({
  kind: z.enum(['new', 'same', 'more', 'fewer', 'different_unit']),
  inventoryId: z.string().optional(), previous: quantitySchema.optional(),
});
export type Change = z.infer<typeof changeSchema>;

export const observationSchema = z.object({
  id: z.string(), name: z.string().min(1), quantity: quantitySchema.optional(), confidence: z.number().min(0).max(1),
  decision: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
  placeId: z.string().optional(), position: z.string().optional(),
  brand: z.string().optional(), variant: z.string().optional(), size: z.string().optional(),
  category: categorySchema.optional(), perishable: z.boolean().optional(),
  evidence: evidenceKindSchema.default('visual'), evidenceNote: z.string().optional(),
  countCertain: z.boolean().default(true),
  sightings: z.array(sightingSchema).default([]),
  /** Set when a label or count cannot be read reliably; the app asks for a close-up instead of guessing. */
  closeUp: z.string().optional(),
  change: changeSchema.optional(),
});
export type Observation = z.infer<typeof observationSchema>;

/** Something the model saw but could not identify, e.g. "white tubs at the back of the second shelf". */
export const unclearSchema = z.object({ id: z.string(), description: z.string(), placeId: z.string().optional(), atSec: z.number().nonnegative().optional(), ask: z.string() });
export type Unclear = z.infer<typeof unclearSchema>;
/** A confirmed item in a place this video covered that the video did not show. */
export const unseenSchema = z.object({ inventoryId: z.string(), name: z.string(), placeId: z.string().optional(), previous: quantitySchema });
export type Unseen = z.infer<typeof unseenSchema>;

export const scanSchema = z.object({
  id: z.string(), status: z.enum(['processing', 'needs_review', 'confirmed', 'failed']),
  /** `demo` is a labeled sample that was not read from the person's video. */
  source: z.enum(['demo', 'gemini', 'gateway']).default('demo'),
  observations: z.array(observationSchema), createdAt: z.string(), error: z.string().optional(),
  video: videoSourceSchema.optional(), places: z.array(placeSchema).default([]),
  unclear: z.array(unclearSchema).default([]), unseen: z.array(unseenSchema).default([]),
  summary: z.string().optional(), model: z.string().optional(), reviewedAt: z.string().optional(),
});
export type Scan = z.infer<typeof scanSchema>;

const timestampPattern = /^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/;
/** Reads "0:12", "01:05", "1:02:03", "12s" or a number of seconds. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/s$/i, '');
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const match = text.match(timestampPattern);
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
export function formatTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600), m = Math.floor((whole % 3600) / 60), s = whole % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Raw model output for a household walkthrough. Loose on purpose; `buildVideoMap` validates and normalizes it. */
export const rawVideoMapSchema = z.object({
  summary: z.string().optional(),
  durationSec: z.union([z.number(), z.string()]).optional(),
  places: z.array(z.object({ id: z.string().optional(), name: z.string(), kind: z.string().optional(), start: z.union([z.number(), z.string()]).optional(), end: z.union([z.number(), z.string()]).optional() })).default([]),
  items: z.array(z.object({
    name: z.string(), brand: z.string().nullish(), variant: z.string().nullish(), size: z.string().nullish(),
    place: z.string().nullish(), position: z.string().nullish(), category: z.string().nullish(), perishable: z.boolean().nullish(),
    count: z.number().nullish(), amount: z.number().nullish(), unit: z.string().nullish(), countCertain: z.boolean().nullish(),
    evidence: z.string().nullish(), evidenceNote: z.string().nullish(),
    timestamps: z.array(z.union([z.number(), z.string()])).default([]),
    confidence: z.number().nullish(), closeUp: z.string().nullish(),
  })).default([]),
  unclear: z.array(z.object({ description: z.string(), place: z.string().nullish(), timestamp: z.union([z.number(), z.string()]).nullish(), ask: z.string().nullish() })).default([]),
});
export type RawVideoMap = z.infer<typeof rawVideoMapSchema>;

const evidenceRank: Record<EvidenceKind, number> = { label: 3, spoken: 2, visual: 1, inferred: 0 };
const asEvidence = (value?: string | null): EvidenceKind => {
  const v = (value ?? '').toLowerCase();
  if (/label|text|read|packag/.test(v)) return 'label';
  if (/spoken|said|narrat|voice|audio/.test(v)) return 'spoken';
  if (/infer|guess|assum|likely|hidden/.test(v)) return 'inferred';
  return 'visual';
};
const asPlaceKind = (value?: string | null, name = ''): PlaceKind => {
  const parsed = placeKindSchema.safeParse((value ?? '').toLowerCase());
  if (parsed.success) return parsed.data;
  const text = `${value ?? ''} ${name}`.toLowerCase();
  for (const kind of placeKindSchema.options) if (text.includes(kind)) return kind;
  if (/wardrobe|closet/.test(text)) return 'closet';
  return 'other';
};
const asCategory = (value?: string | null): Category | undefined => {
  const parsed = categorySchema.safeParse((value ?? '').toLowerCase().replace(/\s+/g, '_'));
  return parsed.success ? parsed.data : undefined;
};
const asUnit = (value?: string | null) => {
  const v = (value ?? '').toLowerCase().trim();
  const map: Record<string, z.infer<typeof unitSchema>> = { count: 'each', item: 'each', items: 'each', pieces: 'each', piece: 'each', liter: 'l', liters: 'l', litre: 'l', gram: 'g', grams: 'g', ounce: 'oz', ounces: 'oz', pound: 'lb', pounds: 'lb', cups: 'cup' };
  const parsed = unitSchema.safeParse(map[v] ?? v);
  return parsed.success ? parsed.data : 'each';
};
const clean = (value?: string | null) => { const text = value?.trim(); return text && !/^(null|none|unknown|n\/a)$/i.test(text) ? text : undefined; };
const placeKey = (value: string) => normalizeName(value).replace(/\b(the|my|top|bottom|middle|left|right)\b/g, '').trim();

/**
 * Turns raw model output into a reviewable map. It drops items with no timestamp (no evidence), clamps times to the
 * clip, resolves places, merges duplicate sightings of the same object, and lowers trust for guesses.
 * Nothing here touches memory; it only proposes.
 */
export function buildVideoMap(raw: RawVideoMap, id: () => string, durationSec?: number): { places: Place[]; observations: Observation[]; unclear: Unclear[]; summary?: string; durationSec?: number } {
  const duration = durationSec ?? parseTimestamp(raw.durationSec) ?? undefined;
  const clamp = (value: number) => duration ? Math.min(value, duration) : value;
  const places: Place[] = [];
  const aliases = new Map<string, string>();
  const placeFor = (name?: string | null, kind?: string | null): Place | undefined => {
    const label = clean(name);
    if (!label) return undefined;
    const key = placeKey(label);
    let place = places.find(p => placeKey(p.name) === key || p.id === label);
    if (!place) { place = { id: id(), name: label.replace(/^\w/, ch => ch.toUpperCase()), kind: asPlaceKind(kind, label) }; places.push(place); }
    return place;
  };
  for (const entry of raw.places) {
    const place = placeFor(entry.name, entry.kind);
    if (!place) continue;
    const start = parseTimestamp(entry.start), end = parseTimestamp(entry.end);
    if (start !== null) place.startSec = clamp(start);
    if (end !== null) place.endSec = clamp(end);
    if (entry.id && entry.id !== place.id) aliases.set(entry.id, place.id);
  }
  // Items and unclear spots may name a place by the model's id ("p1") or by its label ("Fridge").
  const placeRef = (ref?: string | null) => ref && aliases.has(ref) ? places.find(p => p.id === aliases.get(ref)) : placeFor(ref);
  const observations: Observation[] = [];
  for (const item of raw.items) {
    const name = clean(item.name);
    if (!name) continue;
    const times = item.timestamps.map(parseTimestamp).filter((t): t is number => t !== null).map(clamp);
    if (!times.length) continue; // No moment in the clip means no evidence to show the person.
    const place = placeRef(item.place);
    const evidence = asEvidence(item.evidence);
    const unit = asUnit(item.unit);
    const amount = unit === 'each' ? item.count ?? item.amount : item.amount ?? item.count;
    const countCertain = item.countCertain !== false && amount != null && amount > 0;
    const confidence = Math.max(0, Math.min(1, item.confidence ?? (evidence === 'label' ? 0.85 : 0.6)));
    const closeUp = clean(item.closeUp) ?? (!countCertain ? `Show the ${name.toLowerCase()} up close so I can count ${amount ? 'them' : 'how many there are'}.` : undefined);
    observations.push({
      id: id(), name: name.replace(/^\w/, ch => ch.toUpperCase()),
      quantity: amount != null && amount > 0 ? { amount, unit } : undefined,
      confidence: evidence === 'inferred' ? Math.min(confidence, 0.5) : confidence,
      decision: 'pending', placeId: place?.id, position: clean(item.position),
      brand: clean(item.brand), variant: clean(item.variant), size: clean(item.size),
      category: asCategory(item.category), perishable: item.perishable ?? undefined,
      evidence, evidenceNote: clean(item.evidenceNote), countCertain,
      sightings: [...new Set(times)].sort((a, b) => a - b).map(startSec => ({ startSec })), closeUp,
    });
  }
  const unclear = raw.unclear.flatMap(entry => {
    const description = clean(entry.description);
    if (!description) return [];
    const at = parseTimestamp(entry.timestamp);
    return [{ id: id(), description, placeId: placeRef(entry.place)?.id, atSec: at === null ? undefined : clamp(at), ask: clean(entry.ask) ?? `Show me ${description} up close.` }];
  });
  return { places, observations: mergeSightings(observations), unclear, summary: clean(raw.summary), durationSec: duration };
}
/**
 * Merges sightings of the same object within one clip. The same carton seen twice is one carton, so counts take the
 * larger value rather than adding up; disagreeing counts become uncertain and ask for a close-up.
 */
export function mergeSightings(observations: Observation[]): Observation[] {
  const merged: Observation[] = [];
  for (const item of observations) {
    const key = (o: Observation) => `${normalizeName(o.name)}|${normalizeName(o.brand ?? '')}|${normalizeName(o.variant ?? '')}|${o.placeId ?? ''}`;
    const same = merged.find(existing => key(existing) === key(item));
    if (!same) { merged.push({ ...item, sightings: [...item.sightings] }); continue; }
    const a = same.quantity, b = item.quantity;
    if (a && b && a.unit === b.unit && a.amount !== b.amount) {
      same.quantity = { ...a, amount: Math.max(a.amount, b.amount) };
      same.countCertain = false;
      same.closeUp ??= `I counted ${Math.min(a.amount, b.amount)} at one moment and ${Math.max(a.amount, b.amount)} at another. How many ${same.name.toLowerCase()} are there?`;
    } else if (!a && b) same.quantity = b;
    if (evidenceRank[item.evidence] > evidenceRank[same.evidence]) { same.evidence = item.evidence; same.evidenceNote = item.evidenceNote ?? same.evidenceNote; }
    same.confidence = Math.max(same.confidence, item.confidence);
    same.countCertain = same.countCertain && item.countCertain;
    same.closeUp ??= item.closeUp;
    same.position ??= item.position; same.size ??= item.size; same.category ??= item.category; same.perishable ??= item.perishable;
    const seen = new Set(same.sightings.map(s => s.startSec));
    for (const s of item.sightings) if (!seen.has(s.startSec)) same.sightings.push(s);
    same.sightings.sort((x, y) => x.startSec - y.startSec);
  }
  return merged;
}

/** Things worth confirming without a second look: legible or clearly seen, counted, and confident. */
export const isClearSighting = (o: Observation) => o.evidence !== 'inferred' && o.countCertain && !!o.quantity && !o.closeUp && o.confidence >= 0.75;

export type { Quantity };
