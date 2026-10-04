import { z } from 'zod';

export const unitSchema = z.enum(['each', 'g', 'kg', 'ml', 'l', 'oz', 'lb', 'cup', 'tbsp', 'tsp']);
export type Unit = z.infer<typeof unitSchema>;
export const quantitySchema = z.object({ amount: z.number().positive(), unit: unitSchema });
export type Quantity = z.infer<typeof quantitySchema>;
export const inventoryItemSchema = z.object({
  id: z.string(), name: z.string().min(1), quantity: quantitySchema,
  confidence: z.enum(['confirmed', 'estimated']).default('confirmed'),
  updatedAt: z.string(), note: z.string().optional(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;
export const ingredientSchema = z.object({ name: z.string().min(1), quantity: quantitySchema, optional: z.boolean().default(false) });
export type Ingredient = z.infer<typeof ingredientSchema>;
export const recipeSchema = z.object({
  id: z.string(), title: z.string(), sourceUrl: z.string().url().optional(), servings: z.number().int().positive(),
  ingredients: z.array(ingredientSchema), instructions: z.array(z.string()), createdAt: z.string(),
  source: z.enum(['demo', 'gemini', 'manual']),
});
export type Recipe = z.infer<typeof recipeSchema>;
export const cartItemSchema = ingredientSchema.extend({
  id: z.string(), estimatedPriceCents: z.number().int().nonnegative().nullable(),
  retailerProductUrl: z.string().url().optional(), status: z.enum(['needed', 'found', 'unavailable']).default('needed'),
});
export type CartItem = z.infer<typeof cartItemSchema>;
export const cartSchema = z.object({
  id: z.string(), recipeId: z.string(), items: z.array(cartItemSchema),
  status: z.enum(['draft', 'approved', 'checkout_ready', 'ordered', 'cancelled']),
  approvedAt: z.string().optional(), checkoutUrl: z.string().url().optional(), orderReference: z.string().optional(),
  // How the store was opened: `manual` means the user adds items themselves; `kernel` is a hosted browser session.
  checkout: z.object({ mode: z.enum(['manual', 'kernel']), note: z.string(), sessionId: z.string().optional(), openedAt: z.string() }).optional(),
  receivedAt: z.string().optional(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Cart = z.infer<typeof cartSchema>;
export const observationSchema = z.object({
  id: z.string(), name: z.string(), quantity: quantitySchema.optional(), confidence: z.number().min(0).max(1),
  decision: z.enum(['pending', 'accepted', 'rejected']).default('pending'),
});
export type Observation = z.infer<typeof observationSchema>;
export const scanSchema = z.object({
  id: z.string(), status: z.enum(['processing', 'needs_review', 'confirmed', 'failed']),
  source: z.enum(['demo', 'gemini']).default('demo'),
  observations: z.array(observationSchema), createdAt: z.string(), error: z.string().optional(),
});
export type Scan = z.infer<typeof scanSchema>;
export const messageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), content: z.string(), createdAt: z.string(),
  taskId: z.string().optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const taskSchema = z.object({
  id: z.string(), kind: z.enum(['recipe', 'scan', 'cart', 'voice', 'receipt']), title: z.string(),
  status: z.enum(['running', 'needs_review', 'done', 'failed']),
  createdAt: z.string(), updatedAt: z.string(), detail: z.string().optional(),
  // The cart or scan this task is about, so finishing that work closes the right task.
  subjectId: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const appStateSchema = z.object({
  inventory: z.array(inventoryItemSchema), recipes: z.array(recipeSchema), carts: z.array(cartSchema),
  scans: z.array(scanSchema), messages: z.array(messageSchema), tasks: z.array(taskSchema),
  preferences: z.record(z.string(), z.string()), events: z.array(z.object({ id: z.string(), type: z.string(), at: z.string(), data: z.unknown() })),
});
export type AppState = z.infer<typeof appStateSchema>;
export const emptyState = (): AppState => ({ inventory: [], recipes: [], carts: [], scans: [], messages: [], tasks: [], preferences: {}, events: [] });

const aliases: Record<string, string> = { tomatoes: 'tomato', potatoes: 'potato', onions: 'onion', eggs: 'egg', cloves: 'clove' };
export const normalizeName = (name: string): string => {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return aliases[cleaned] ?? cleaned;
};

const toBase = (q: Quantity): { amount: number; dimension: string } => {
  switch (q.unit) {
    case 'kg': return { amount: q.amount * 1000, dimension: 'mass' };
    case 'g': return { amount: q.amount, dimension: 'mass' };
    case 'lb': return { amount: q.amount * 453.592, dimension: 'mass' };
    case 'oz': return { amount: q.amount * 28.3495, dimension: 'mass' };
    case 'l': return { amount: q.amount * 1000, dimension: 'volume' };
    case 'ml': return { amount: q.amount, dimension: 'volume' };
    case 'cup': return { amount: q.amount * 236.588, dimension: 'volume' };
    case 'tbsp': return { amount: q.amount * 14.7868, dimension: 'volume' };
    case 'tsp': return { amount: q.amount * 4.92892, dimension: 'volume' };
    case 'each': return { amount: q.amount, dimension: 'count' };
  }
};

export function missingIngredients(recipe: Recipe, inventory: InventoryItem[]): Ingredient[] {
  return recipe.ingredients.filter(ingredient => {
    if (ingredient.optional) return false;
    const needed = toBase(ingredient.quantity);
    const available = inventory.filter(item => item.confidence === 'confirmed' && normalizeName(item.name) === normalizeName(ingredient.name))
      .map(item => toBase(item.quantity))
      .filter(value => value.dimension === needed.dimension)
      .reduce((total, value) => total + value.amount, 0);
    return available + 0.00001 < needed.amount;
  }).map(ingredient => {
    const needed = toBase(ingredient.quantity);
    const available = inventory.filter(item => item.confidence === 'confirmed' && normalizeName(item.name) === normalizeName(ingredient.name))
      .map(item => toBase(item.quantity)).filter(value => value.dimension === needed.dimension)
      .reduce((total, value) => total + value.amount, 0);
    const fraction = Math.max(0, (needed.amount - available) / needed.amount);
    const shortage = ingredient.quantity.amount * fraction;
    const amount = ingredient.quantity.unit === 'each' ? Math.max(1, Math.ceil(shortage)) : Math.max(.01, Math.ceil(shortage * 100) / 100);
    return { ...ingredient, quantity: { ...ingredient.quantity, amount } };
  });
}

export function createCart(recipe: Recipe, inventory: InventoryItem[], now: string, id: () => string): Cart {
  return { id: id(), recipeId: recipe.id, items: missingIngredients(recipe, inventory).map(item => ({
    ...item, id: id(), estimatedPriceCents: null, status: 'needed' as const,
  })), status: 'draft', createdAt: now, updatedAt: now };
}

export function scaleRecipe(recipe: Recipe, servings: number): Recipe {
  if (!Number.isInteger(servings) || servings < 1 || servings > 24) throw new Error('Servings must be between 1 and 24');
  const factor = servings / recipe.servings;
  return { ...recipe, servings, ingredients: recipe.ingredients.map(item => ({ ...item, quantity: { ...item.quantity, amount: Math.max(.01, Math.round(item.quantity.amount * factor * 100) / 100) } })) };
}

export function approveCart(cart: Cart, now: string): Cart {
  if (cart.status !== 'draft') throw new Error('Only a draft cart can be approved');
  return { ...cart, status: 'approved', approvedAt: now, updatedAt: now };
}

export function confirmScan(scan: Scan, decisions: Record<string, 'accepted' | 'rejected'>, inventory: InventoryItem[], now: string, id: () => string): { scan: Scan; inventory: InventoryItem[] } {
  if (scan.status !== 'needs_review') throw new Error('Scan is not ready for review');
  if (scan.observations.some(item => !decisions[item.id])) throw new Error('Every observation needs a decision');
  const next = [...inventory];
  for (const observation of scan.observations) {
    if (decisions[observation.id] !== 'accepted') continue;
    const existing = next.find(item => normalizeName(item.name) === normalizeName(observation.name));
    if (existing) { existing.confidence = 'confirmed'; existing.quantity = observation.quantity ?? existing.quantity; existing.updatedAt = now; }
    else next.push({ id: id(), name: observation.name, quantity: observation.quantity ?? { amount: 1, unit: 'each' }, confidence: 'confirmed', updatedAt: now });
  }
  return { scan: { ...scan, status: 'confirmed', observations: scan.observations.map(item => ({ ...item, decision: decisions[item.id] })) }, inventory: next };
}
