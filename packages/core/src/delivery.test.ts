import { describe, expect, it } from 'vitest';
import { deliveredQuantity, itemOfferSchema, type CartItem } from './index';

const item: CartItem = { id: 'pasta', name: 'Pasta', quantity: { amount: 700, unit: 'g' }, optional: false, estimatedPriceCents: 600, status: 'added' };
const offer = { merchant: 'Mock Market', title: 'Pasta 500 g', priceCents: 600, packs: 2, verified: true, capturedAt: '2026-10-04T12:00:00Z' };

describe('delivered purchased quantities', () => {
  it('records two 500 g packs as 1 kg instead of the recipe shortage of 700 g', () => {
    const delivered = deliveredQuantity({ ...item, offer: { ...offer, packSize: { amount: 500, unit: 'g' } } });
    expect(delivered).toEqual({ amount: 1000, unit: 'g' });
    expect(item.quantity).toEqual({ amount: 700, unit: 'g' });
  });
  it('records all eggs in a purchased carton instead of only the eggs needed for a recipe', () => {
    expect(deliveredQuantity({ ...item, name: 'Eggs', quantity: { amount: 3, unit: 'each' }, offer: { ...offer, packs: 1, title: 'Eggs 12 ct', packSize: { amount: 12, unit: 'each' } } })).toEqual({ amount: 12, unit: 'each' });
  });
  it('supports different pack units while preserving the purchased quantity unit', () => {
    expect(deliveredQuantity({ ...item, quantity: { amount: 1500, unit: 'ml' }, offer: { ...offer, packSize: { amount: 1, unit: 'l' } } })).toEqual({ amount: 2, unit: 'l' });
  });
  it('keeps the requested amount when pack contents are unknown, without aliasing the original object', () => {
    const delivered = deliveredQuantity(item); delivered.amount = 1;
    expect(item.quantity.amount).toBe(700);
    expect(deliveredQuantity({ ...item, offer })).toEqual(item.quantity);
    expect(deliveredQuantity({ ...item, offer: { ...offer, packs: 0, packSize: { amount: 500, unit: 'g' } } })).toEqual(item.quantity);
  });
  it('persists pack contents on frozen offers while preserving older offers without that field', () => {
    expect(itemOfferSchema.parse({ ...offer, packSize: { amount: 500, unit: 'g' } }).packSize).toEqual({ amount: 500, unit: 'g' });
    expect(itemOfferSchema.parse(offer).packSize).toBeUndefined();
  });
});
