import { describe, expect, it, vi } from 'vitest';
import { checkoutSnapshotHash, checkoutSnapshotSchema, controlledMockSubmit, createPurchaseApproval, invalidateChangedApproval, matchCartCheckout, planIngredients, validatePurchaseApproval, type Cart, type CheckoutSnapshot, type InventoryItem, type PurchaseApproval, type Recipe } from './index';

const now = '2026-10-04T12:00:00.000Z';
const later = '2026-10-04T12:01:00.000Z';
const snapshot: CheckoutSnapshot = {
  id: 'snapshot', cartId: 'cart', merchant: 'Mock Market', checkoutUrl: 'https://mock.example/checkout', capturedAt: now,
  source: 'mock', currency: 'USD', fulfillment: 'pickup', locationKey: 'store:94103',
  lines: [{ itemId: 'milk', title: 'Organic Whole Milk 1 L', productUrl: 'https://mock.example/milk', quantity: 2, unitPriceCents: 399, lineTotalCents: 798 }],
  subtotalCents: 798, feesCents: 100, taxCents: 50, tipCents: 0, discountCents: 25, totalCents: 923,
};
const cart: Cart = {
  id: 'cart', origin: 'request', status: 'checkout_ready', merchant: 'Mock Market', createdAt: now, updatedAt: now,
  items: [{ id: 'milk', name: 'Milk', quantity: { amount: 2, unit: 'each' }, optional: false, status: 'added', estimatedPriceCents: 399,
    offer: { merchant: 'Mock Market', title: 'Organic Whole Milk 1 L', url: 'https://mock.example/milk', priceCents: 798, packs: 2, verified: true, capturedAt: now } }],
};
const approve = (value = snapshot) => createPurchaseApproval(value, { id: 'approval', now, maximumTotalCents: 1000 });

describe('final checkout purchase boundary', () => {
  it('requires all charges and checks totals and duplicate lines', () => {
    expect(checkoutSnapshotSchema.safeParse({ ...snapshot, taxCents: undefined }).success).toBe(false);
    expect(checkoutSnapshotSchema.safeParse({ ...snapshot, totalCents: 1 }).success).toBe(false);
    expect(checkoutSnapshotSchema.safeParse({ ...snapshot, lines: [...snapshot.lines, ...snapshot.lines] }).success).toBe(false);
    expect(checkoutSnapshotSchema.safeParse({ ...snapshot, lines: [{ ...snapshot.lines[0], quantity: 3 }] }).success).toBe(false);
  });
  it('matches frozen approved products, quantities and prices and refuses a different cart', () => {
    expect(matchCartCheckout(cart, snapshot)).toEqual({ matches: true, discrepancies: [] });
    expect(matchCartCheckout({ ...cart, status: 'draft' }, snapshot).matches).toBe(false);
    expect(matchCartCheckout(cart, { ...snapshot, cartId: 'other' }).discrepancies).toContain('The checkout belongs to a different cart.');
    const changed = { ...snapshot, lines: [{ ...snapshot.lines[0], quantity: 1, lineTotalCents: 399 }], subtotalCents: 399, totalCents: 524 };
    expect(matchCartCheckout(cart, changed).discrepancies).toContain('Milk has a different quantity.');
    expect(matchCartCheckout(cart, { ...snapshot, lines: [{ ...snapshot.lines[0], title: 'Organic Skim Milk 1 L' }] }).discrepancies).toContain('Milk is a different product or variant.');
    expect(matchCartCheckout(cart, { ...snapshot, lines: [{ ...snapshot.lines[0], productUrl: undefined }] }).matches).toBe(false);
  });
  it('hashes stable parsed fields and binds location, product and all final charges', async () => {
    expect(await checkoutSnapshotHash(snapshot)).toMatch(/^[a-f0-9]{64}$/);
    expect(await checkoutSnapshotHash({ ...snapshot })).toBe(await checkoutSnapshotHash(snapshot));
    expect(await checkoutSnapshotHash({ ...snapshot, locationKey: 'store:10001' })).not.toBe(await checkoutSnapshotHash(snapshot));
    expect(await checkoutSnapshotHash({ ...snapshot, lines: [{ ...snapshot.lines[0], size: 'different' }] })).not.toBe(await checkoutSnapshotHash(snapshot));
  });
  it('rejects stale snapshots, totals over the cap and expiry beyond the snapshot lifetime', async () => {
    await expect(createPurchaseApproval(snapshot, { id: 'a', now: '2026-10-04T12:05:00.000Z', maximumTotalCents: 1000 })).rejects.toThrow(/fresh/);
    await expect(createPurchaseApproval(snapshot, { id: 'a', now, maximumTotalCents: 900 })).rejects.toThrow(/maximum/);
    await expect(createPurchaseApproval(snapshot, { id: 'a', now, maximumTotalCents: 1000, expiresAt: '2026-10-04T12:06:00.000Z' })).rejects.toThrow(/outlive/);
  });
  it('invalidates on any checkout change, including a cheaper total, and rejects expired/used approvals', async () => {
    const approval = await approve();
    expect(await validatePurchaseApproval(approval, snapshot, later)).toEqual({ valid: true });
    const changed = { ...snapshot, feesCents: 50, totalCents: 873 };
    expect(await invalidateChangedApproval(approval, changed, later)).toMatchObject({ status: 'invalidated', invalidationReason: expect.stringMatching(/changed/) });
    expect((await validatePurchaseApproval(approval, snapshot, '2026-10-04T12:05:00.000Z')).valid).toBe(false);
    expect((await validatePurchaseApproval({ ...approval, status: 'used', usedAt: later }, snapshot, later)).valid).toBe(false);
  });
  it('atomically consumes before mock submission and prevents concurrent double submit', async () => {
    let saved = await approve();
    const approval = saved;
    const submit = vi.fn(async () => { expect(saved.status).toBe('used'); return { orderReference: 'mock-order-1' }; });
    const claim = async (expected: PurchaseApproval, consumed: PurchaseApproval) => {
      if (saved.status !== 'active' || saved.snapshotHash !== expected.snapshotHash) return false;
      saved = consumed; return true;
    };
    const results = await Promise.allSettled([1, 2].map(() => controlledMockSubmit({ approval, snapshot, now: later, claim, submit })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe('used');
  });
  it('keeps approval consumed when the merchant response fails and refuses all real merchant submissions', async () => {
    const approval = await approve();
    let saved = approval;
    await expect(controlledMockSubmit({ approval, snapshot, now: later, claim: async (_, consumed) => { saved = consumed; return true; }, submit: async () => { throw new Error('Timeout after merchant accepted'); } })).rejects.toThrow(/Timeout/);
    expect(saved.status).toBe('used');
    const submit = vi.fn(); const claim = vi.fn();
    await expect(controlledMockSubmit({ approval, snapshot: { ...snapshot, source: 'merchant' }, now: later, claim, submit })).rejects.toThrow(/mock/);
    expect(claim).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
});

const recipe = (ingredients: Recipe['ingredients']): Recipe => ({ id: 'recipe', title: 'Pasta', servings: 2, source: 'manual', instructions: [], createdAt: now, ingredients });
const stock = (name: string, amount: number, unit: InventoryItem['quantity']['unit'], extra: Partial<InventoryItem> = {}): InventoryItem => ({ id: name, name, quantity: { amount, unit }, confidence: 'confirmed', updatedAt: now, evidence: [], ...extra });
describe('inventory reservation across recipe ingredients', () => {
  it('never uses the same pasta quantity twice across generic and specific names', () => {
    const plan = planIngredients(recipe([{ name: 'Pasta', quantity: { amount: 200, unit: 'g' }, optional: false }, { name: 'Spaghetti', quantity: { amount: 200, unit: 'g' }, optional: false }]), [stock('Spaghetti', 300, 'g')], now);
    expect(plan.filter(line => line.buy).reduce((sum, line) => sum + line.buy!.amount, 0)).toBe(100);
  });
  it('reserves specific ingredients first so broad ingredients can use other stock', () => {
    const plan = planIngredients(recipe([{ name: 'Pasta', quantity: { amount: 200, unit: 'g' }, optional: false }, { name: 'Spaghetti', quantity: { amount: 200, unit: 'g' }, optional: false }]), [stock('Spaghetti', 200, 'g'), stock('Penne', 200, 'g')], now);
    expect(plan.every(line => !line.buy)).toBe(true);
    expect(plan.map(line => line.ingredient.name)).toEqual(['Pasta', 'Spaghetti']);
  });
  it('tracks counted pack fractions when the same inventory is requested by mass and by count', () => {
    const plan = planIngredients(recipe([{ name: 'Spaghetti', quantity: { amount: 500, unit: 'g' }, optional: false }, { name: 'Spaghetti', quantity: { amount: 1, unit: 'each' }, optional: false }]), [stock('Spaghetti', 1, 'each', { size: '500 g' })], now);
    expect(plan[0].buy).toBeNull(); expect(plan[1].buy).toEqual({ amount: 1, unit: 'each' });
  });
  it('ignores optional and stale stock without mutating inventory', () => {
    const inventory = [stock('Eggs', 2, 'each', { updatedAt: '2026-09-01T00:00:00Z' })];
    const before = JSON.stringify(inventory);
    const plan = planIngredients(recipe([{ name: 'Eggs', quantity: { amount: 1, unit: 'each' }, optional: true }, { name: 'Egg', quantity: { amount: 2, unit: 'each' }, optional: false }]), inventory, now);
    expect(plan).toHaveLength(1); expect(plan[0].buy?.amount).toBe(2); expect(plan[0].check).toMatch(/last checked/);
    expect(JSON.stringify(inventory)).toBe(before);
  });
});
