import { describe, expect, it } from 'vitest';
import { buildVideoMap, confirmScan, formatTimestamp, isClearSighting, parseTimestamp, reconcile, whereIs, type InventoryItem, type RawVideoMap, type Scan } from './index';

let n = 0; const id = () => `id${++n}`;
// Shaped like a real Gemini reply for a 31-second fridge-and-pantry walkthrough.
const raw: RawVideoMap = {
  summary: 'Fridge, then pantry shelf.', durationSec: '0:31',
  places: [{ id: 'p1', name: 'Fridge', kind: 'fridge', start: '0:00', end: '0:14' }, { id: 'p2', name: 'Pantry shelf', kind: 'pantry', start: '0:15', end: '0:31' }],
  items: [
    { name: 'milk', brand: 'Organic Valley', variant: '2%', place: 'p1', position: 'door', count: 1, unit: 'each', evidence: 'label', evidenceNote: 'label legible', timestamps: ['0:04'], confidence: 0.92 },
    { name: 'Milk', brand: 'Organic Valley', variant: '2%', place: 'Fridge', count: 1, evidence: 'visual', timestamps: ['0:09'], confidence: 0.7 },
    { name: 'Eggs', place: 'Fridge', count: 6, evidence: 'visual', timestamps: ['0:06'], confidence: 0.8 },
    { name: 'Eggs', place: 'Fridge', count: 8, evidence: 'visual', timestamps: ['0:11'], confidence: 0.8 },
    { name: 'Chickpeas', brand: 'Goya', place: 'Pantry shelf', count: 2, unit: 'cans', evidence: 'label', timestamps: ['0:18', '0:20'], confidence: 0.9 },
    { name: 'Rice', place: 'Pantry shelf', count: null, evidence: 'visual', timestamps: ['0:24'], confidence: 0.6, countCertain: false },
    { name: 'Hidden sauce', place: 'Pantry shelf', count: 1, evidence: 'guess', timestamps: [], confidence: 0.3 },
    { name: 'Yogurt', place: 'Fridge', count: 1, evidence: 'inferred', timestamps: ['0:40'], confidence: 0.9 },
  ],
  unclear: [{ description: 'white tubs at the back', place: 'Fridge', timestamp: '0:12', ask: null }],
};

describe('video map', () => {
  it('reads timestamps in the forms models return', () => {
    expect(parseTimestamp('0:12')).toBe(12); expect(parseTimestamp('01:05')).toBe(65); expect(parseTimestamp('1:02:03')).toBe(3723);
    expect(parseTimestamp('7s')).toBe(7); expect(parseTimestamp(4.5)).toBe(4.5); expect(parseTimestamp('soon')).toBeNull();
    expect(formatTimestamp(65)).toBe('1:05');
  });

  it('builds places, merges duplicate sightings and never invents untimed items', () => {
    const map = buildVideoMap(raw, id);
    expect(map.places.map(p => [p.name, p.kind])).toEqual([['Fridge', 'fridge'], ['Pantry shelf', 'pantry']]);
    expect(map.observations.map(o => o.name)).toEqual(['Milk', 'Eggs', 'Chickpeas', 'Rice', 'Yogurt']);
    const milk = map.observations[0];
    expect(milk.sightings.map(s => s.startSec)).toEqual([4, 9]);
    expect(milk.quantity).toEqual({ amount: 1, unit: 'each' });
    expect(milk.evidence).toBe('label');
    const eggs = map.observations[1];
    expect(eggs.quantity?.amount).toBe(8);
    expect(eggs.countCertain).toBe(false);
    expect(eggs.closeUp).toMatch(/6 at one moment and 8/);
    const rice = map.observations[3];
    expect(rice.quantity).toBeUndefined();
    expect(rice.closeUp).toBeTruthy();
    const yogurt = map.observations[4];
    expect(yogurt.sightings[0].startSec).toBe(31); // clamped to the clip
    expect(yogurt.confidence).toBeLessThanOrEqual(0.5); // a guess never looks certain
    expect(map.unclear[0]).toMatchObject({ description: 'white tubs at the back', atSec: 12 });
    expect(isClearSighting(milk)).toBe(true);
    expect(isClearSighting(eggs)).toBe(false);
  });

  it('compares a new clip with confirmed memory and lists unseen items in covered places', () => {
    const map = buildVideoMap(raw, id);
    const inventory: InventoryItem[] = [
      { id: 'm', name: 'Milk', quantity: { amount: 2, unit: 'each' }, confidence: 'confirmed', updatedAt: '2026-10-01', location: 'Fridge', evidence: [] },
      { id: 'b', name: 'Butter', quantity: { amount: 1, unit: 'each' }, confidence: 'confirmed', updatedAt: '2026-10-01', location: 'Fridge', evidence: [] },
      { id: 'j', name: 'Jacket', quantity: { amount: 1, unit: 'each' }, confidence: 'confirmed', updatedAt: '2026-10-01', location: 'Closet', evidence: [] },
    ];
    const { observations, unseen } = reconcile(map.observations, map.places, inventory);
    expect(observations[0].change).toMatchObject({ kind: 'fewer', inventoryId: 'm', previous: { amount: 2 } });
    expect(observations[2].change?.kind).toBe('new');
    expect(unseen.map(u => u.name)).toEqual(['Butter']);
  });

  it('commits only accepted sightings, applies corrections, and needs a count for unclear ones', () => {
    const map = buildVideoMap(raw, id);
    const scan: Scan = { id: 'scan1', status: 'needs_review', source: 'gemini', createdAt: 'now', observations: map.observations, places: map.places, unclear: [], unseen: [{ inventoryId: 'b', name: 'Butter', previous: { amount: 1, unit: 'each' } }] };
    const butter: InventoryItem = { id: 'b', name: 'Butter', quantity: { amount: 1, unit: 'each' }, confidence: 'confirmed', updatedAt: 'then', location: 'Fridge', evidence: [] };
    const [milk, eggs, chickpeas, rice, yogurt] = map.observations;
    const base = { [milk.id]: 'accepted', [eggs.id]: 'rejected', [chickpeas.id]: 'accepted', [yogurt.id]: 'rejected' } as const;
    expect(() => confirmScan(scan, { ...base, [rice.id]: 'accepted' }, [butter], '2026-10-04T12:00:00Z', id)).toThrow(/how many rice/);
    const result = confirmScan(scan, { ...base, [chickpeas.id]: { decision: 'accepted', brand: 'Bush’s', amount: 3 }, [rice.id]: { decision: 'accepted', amount: 2, unit: 'lb' } }, [butter], '2026-10-04T12:00:00Z', id, { b: 'gone' });
    expect(result.inventory.map(i => [i.name, i.quantity.amount, i.quantity.unit, i.location])).toEqual([['Milk', 1, 'each', 'Fridge'], ['Chickpeas', 3, 'each', 'Pantry shelf'], ['Rice', 2, 'lb', 'Pantry shelf']]);
    expect(result.inventory[1].brand).toBe('Bush’s');
    expect(result.inventory[0].evidence[0]).toMatchObject({ sourceType: 'video', sourceId: 'scan1', atSec: 4 });
    expect(result.events.map(e => e.type)).toEqual(['inventory.confirmed', 'inventory.corrected', 'inventory.corrected', 'inventory.removed']);
    expect(result.scan.status).toBe('confirmed');
  });

  it('answers where something was last seen from confirmed memory', () => {
    const inventory: InventoryItem[] = [{ id: 'j', name: 'Jacket', variant: 'blue', quantity: { amount: 1, unit: 'each' }, confidence: 'confirmed', updatedAt: '2026-10-04T12:00:00Z', location: 'Closet', position: 'top shelf', evidence: [{ sourceType: 'video', sourceId: 's', atSec: 21, at: '2026-10-04T12:00:00Z' }] }];
    const answer = whereIs('Where did I last see the blue jacket?', inventory, []);
    expect(answer?.answer).toMatch(/in the closet \(top shelf\)/);
    expect(answer?.answer).toMatch(/0:21/);
    expect(whereIs('where is the passport', inventory, [])).toBeNull();
  });
});
