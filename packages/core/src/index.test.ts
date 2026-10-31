import { describe, expect, it } from 'vitest';
import { approveCart, confirmScan, createCart, missingIngredients, scaleRecipe, type Recipe, type InventoryItem, type Scan } from './index';

const recipe: Recipe = { id: 'r', title: 'Pasta', servings: 2, source: 'manual', createdAt: 'now', instructions: [], ingredients: [
  { name: 'Tomatoes', quantity: { amount: 4, unit: 'each' }, optional: false },
  { name: 'Milk', quantity: { amount: 500, unit: 'ml' }, optional: false },
] };
const inventory: InventoryItem[] = [
  { id: 'i', name: 'tomato', quantity: { amount: 2, unit: 'each' }, confidence: 'confirmed', updatedAt: 'now', evidence: [] },
  { id: 'u', name: 'milk', quantity: { amount: 1, unit: 'l' }, confidence: 'estimated', updatedAt: 'now', evidence: [] },
];
describe('shopping state', () => {
  it('subtracts confirmed pantry quantity and ignores uncertain observations', () => {
    expect(missingIngredients(recipe, inventory)).toMatchObject([
      { name: 'Tomatoes', quantity: { amount: 2, unit: 'each' } },
      { name: 'Milk', quantity: { amount: 500, unit: 'ml' } },
    ]);
  });
  it('rounds up a partial count so a cart never buys a fraction of an item', () => {
    const slightlyShort = [{ ...inventory[0], quantity: { amount: 2.7, unit: 'each' as const } }];
    expect(missingIngredients(recipe, slightlyShort)[0].quantity).toEqual({ amount: 2, unit: 'each' });
  });
  it('requires approval before checkout', () => {
    const cart = createCart(recipe, inventory, 'now', () => 'id');
    expect(cart.status).toBe('draft');
    expect(approveCart(cart, 'later').status).toBe('approved');
    expect(() => approveCart(approveCart(cart, 'later'), 'later')).toThrow();
  });
  it('scales ingredient quantities by serving count', () => {
    const four = scaleRecipe(recipe, 4);
    expect(four.ingredients[0].quantity.amount).toBe(8);
    expect(four.ingredients[1].quantity.amount).toBe(1000);
    expect(recipe.servings).toBe(2);
  });
  it('only commits accepted scan observations', () => {
    const sighting = { evidence: 'visual' as const, countCertain: true, sightings: [{ startSec: 3 }] };
    const scan: Scan = { id: 's', status: 'needs_review', source: 'gemini', createdAt: 'now', places: [], unclear: [], unseen: [], observations: [
      { id: 'a', name: 'Eggs', quantity: { amount: 6, unit: 'each' }, confidence: .8, decision: 'pending', ...sighting },
      { id: 'b', name: 'Cheese', confidence: .4, decision: 'pending', ...sighting },
    ] };
    expect(() => confirmScan(scan, { a: 'accepted' }, [], 'now', () => 'id')).toThrow();
    const result = confirmScan(scan, { a: 'accepted', b: 'rejected' }, [], 'now', () => 'id');
    expect(result.inventory.map(i => i.name)).toEqual(['Eggs']);
  });
});
