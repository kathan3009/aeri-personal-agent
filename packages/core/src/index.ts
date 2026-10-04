import { z } from 'zod';
import { freshness, inventoryItemSchema, type InventoryItem } from './inventory';
import { covers, normalizeName } from './names';
import { checkoutSnapshotSchema, purchaseApprovalSchema } from './checkout';
import { candidateSchema, photoSearchSchema, verificationSchema } from './product';
import { proposalSchema } from './shopping';
import { parsePackSize, quantitySchema, toBase, type Quantity } from './units';
import { scanSchema } from './video';

export * from './units';
export * from './names';
export * from './video';
export * from './inventory';
export * from './product';
export * from './shopping';
export * from './checkout';

export const ingredientSchema = z.object({
  name: z.string().min(1), quantity: quantitySchema, optional: z.boolean().default(false),
  /** Moment in the recipe video where the ingredient or amount appears, and whether the amount was estimated. */
  atSec: z.number().nonnegative().optional(), estimated: z.boolean().optional(),
});
export type Ingredient = z.infer<typeof ingredientSchema>;
export const recipeSchema = z.object({
  id: z.string(), title: z.string(), sourceUrl: z.string().url().optional(), servings: z.number().int().positive(),
  ingredients: z.array(ingredientSchema), instructions: z.array(z.string()), createdAt: z.string(),
  source: z.enum(['demo', 'gemini', 'gateway', 'manual']),
  sourceKind: z.enum(['youtube', 'video_file', 'link', 'manual']).optional(), sourceLabel: z.string().optional(),
});
export type Recipe = z.infer<typeof recipeSchema>;

/** The offer an item was approved against, frozen at approval so later changes are visible. */
export const itemOfferSchema = z.object({
  merchant: z.string(), title: z.string(), url: z.string().url().optional(), priceCents: z.number().int().nonnegative().nullable(),
  packs: z.number().int().nonnegative().default(1), verified: z.boolean(), capturedAt: z.string(), match: z.enum(['exact', 'likely', 'similar']).optional(),
  /** Quantity contained in one purchased pack; distinct from the recipe's missing amount. */
  packSize: quantitySchema.optional(),
});
export const cartItemSchema = ingredientSchema.extend({
  id: z.string(), estimatedPriceCents: z.number().int().nonnegative().nullable(),
  retailerProductUrl: z.string().url().optional(),
  status: z.enum(['needed', 'found', 'unavailable', 'added', 'substituted', 'uncertain']).default('needed'),
  /** Why the person should double-check this line, e.g. a stale pantry count. */
  check: z.string().optional(), offer: itemOfferSchema.optional(),
  /** Delivery reconciliation: only `received` lines become inventory. */
  delivery: z.enum(['received', 'missing', 'substituted']).optional(),
});
export type CartItem = z.infer<typeof cartItemSchema>;
/** Received inventory reflects all purchased packs, rather than only the recipe amount they were bought for.
 * Unknown pack contents retain the requested quantity until the user corrects it at delivery review.
 */
export function deliveredQuantity(item: CartItem): Quantity {
  const offer = item.offer;
  return offer?.packSize && offer.packs > 0
    ? { amount: offer.packSize.amount * offer.packs, unit: offer.packSize.unit }
    : { ...item.quantity };
}
export const cartSchema = z.object({
  id: z.string(), recipeId: z.string().optional(), title: z.string().optional(),
  origin: z.enum(['recipe', 'photo', 'request']).default('recipe'), items: z.array(cartItemSchema),
  status: z.enum(['draft', 'approved', 'checkout_ready', 'ordered', 'cancelled']),
  approvedAt: z.string().optional(), checkoutUrl: z.string().url().optional(), orderReference: z.string().optional(),
  merchant: z.string().optional(), proposalId: z.string().optional(), basketId: z.string().optional(),
  estimatedTotalCents: z.number().int().nonnegative().nullable().optional(),
  // How the store was opened: `manual` means the user adds items themselves; `kernel` is a hosted browser session.
  checkout: z.object({
    mode: z.enum(['manual', 'kernel']), note: z.string(), sessionId: z.string().optional(), preparationId: z.string().optional(), openedAt: z.string(),
    status: z.enum(['preparing', 'ready', 'failed']).default('ready'), closedAt: z.string().optional(),
    lines: z.array(z.object({ itemId: z.string(), result: z.enum(['added', 'unavailable', 'substituted', 'uncertain']), detail: z.string().optional() })).default([]),
  }).optional(),
  receivedAt: z.string().optional(),
  checkoutSnapshot: checkoutSnapshotSchema.optional(), purchaseApproval: purchaseApprovalSchema.optional(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type Cart = z.infer<typeof cartSchema>;
export const messageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), content: z.string(), createdAt: z.string(),
  taskId: z.string().optional(),
});
export type Message = z.infer<typeof messageSchema>;
export const taskSchema = z.object({
  id: z.string(), kind: z.enum(['recipe', 'scan', 'cart', 'voice', 'receipt', 'photo', 'compare', 'checkout']), title: z.string(),
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
  photoSearches: z.array(photoSearchSchema).default([]), proposals: z.array(proposalSchema).default([]),
});
export type AppState = z.infer<typeof appStateSchema>;
export const emptyState = (): AppState => ({ inventory: [], recipes: [], carts: [], scans: [], messages: [], tasks: [], preferences: {}, events: [], photoSearches: [], proposals: [] });
export { candidateSchema, verificationSchema };

export type IngredientPlan = { ingredient: Ingredient; have: Quantity | null; buy: Quantity | null; check?: string };
/**
 * Subtracts confirmed, reasonably fresh inventory from a recipe. Stale or expired pantry counts are not trusted
 * silently: the ingredient stays on the list with a note asking the person to check.
 */
export function planIngredients(recipe: Recipe, inventory: InventoryItem[], now?: string): IngredientPlan[] {
  // Reserve fractions of each physical item across ingredients, including when a counted pack is used by weight.
  const remaining = inventory.map(() => 1);
  const ingredients = recipe.ingredients.filter(i => !i.optional);
  const matchesFor = (ingredient: Ingredient) => inventory.map((item, index) => {
    const needed = toBase(ingredient.quantity);
    const pack = item.quantity.unit === 'each' && needed.dimension !== 'count' ? parsePackSize(item.size) : null;
    const amount = toBase(pack ? { amount: pack.amount * item.quantity.amount, unit: pack.unit } : item.quantity);
    return { item, index, amount };
  }).filter(({ item, amount }) => item.confidence === 'confirmed' && covers(item.name, ingredient.name) && amount.dimension === toBase(ingredient.quantity).dimension);
  // Specific needs with fewer possible substitutes claim their inventory before broad needs such as "pasta".
  const order = ingredients.map((ingredient, index) => ({ ingredient, index, matching: matchesFor(ingredient) })).sort((a, b) => a.matching.length - b.matching.length || a.index - b.index);
  const plans: IngredientPlan[] = [];
  for (const { ingredient, index, matching } of order) {
    const needed = toBase(ingredient.quantity);
    const trusted = (now ? matching.filter(({ item }) => freshness(item, now).state === 'fresh') : matching).sort((a, b) => Number(normalizeName(b.item.name) === normalizeName(ingredient.name)) - Number(normalizeName(a.item.name) === normalizeName(ingredient.name)));
    const doubtful = now ? matching.filter(({ item }) => freshness(item, now).state !== 'fresh') : [];
    const available = trusted.reduce((total, entry) => total + entry.amount.amount * remaining[entry.index], 0);
    const haveAll = matching.reduce((total, entry) => total + entry.amount.amount * remaining[entry.index], 0);
    const have = matching.length ? { amount: Math.round(haveAll / (needed.amount / ingredient.quantity.amount) * 100) / 100, unit: ingredient.quantity.unit } : null;
    let toReserve = needed.amount;
    for (const entry of trusted) {
      const reserved = Math.min(toReserve, entry.amount.amount * remaining[entry.index]);
      remaining[entry.index] = Math.max(0, remaining[entry.index] - reserved / entry.amount.amount);
      toReserve = Math.max(0, toReserve - reserved);
    }
    if (available + 0.00001 >= needed.amount) { plans[index] = { ingredient, have, buy: null }; continue; }
    const fraction = Math.max(0, (needed.amount - available) / needed.amount);
    const shortage = ingredient.quantity.amount * fraction;
    const amount = ingredient.quantity.unit === 'each' ? Math.max(1, Math.ceil(shortage)) : Math.max(.01, Math.ceil(shortage * 100) / 100);
    const check = doubtful.length ? `You may have ${doubtful.map(({ item }) => item.name.toLowerCase()).join(', ')}, but it was ${freshness(doubtful[0].item, now!).reason}. Remove it if you still have enough.` : undefined;
    plans[index] = { ingredient, have, buy: { ...ingredient.quantity, amount }, check };
  }
  return plans;
}

export function missingIngredients(recipe: Recipe, inventory: InventoryItem[], now?: string): Ingredient[] {
  return planIngredients(recipe, inventory, now).filter(line => line.buy).map(line => ({ ...line.ingredient, quantity: line.buy! }));
}

export function createCart(recipe: Recipe, inventory: InventoryItem[], now: string, id: () => string): Cart {
  const items = planIngredients(recipe, inventory, now).filter(line => line.buy).map(line => ({
    ...line.ingredient, quantity: line.buy!, id: id(), estimatedPriceCents: null, status: 'needed' as const, ...(line.check ? { check: line.check } : {}),
  }));
  return { id: id(), recipeId: recipe.id, title: recipe.title, origin: 'recipe', items, status: 'draft', createdAt: now, updatedAt: now };
}

export function scaleRecipe(recipe: Recipe, servings: number): Recipe {
  if (!Number.isInteger(servings) || servings < 1 || servings > 24) throw new Error('Servings must be between 1 and 24');
  const factor = servings / recipe.servings;
  return { ...recipe, servings, ingredients: recipe.ingredients.map(item => ({ ...item, quantity: { ...item.quantity, amount: Math.max(.01, Math.round(item.quantity.amount * factor * 100) / 100) } })) };
}

export function approveCart(cart: Cart, now: string): Cart {
  if (cart.status !== 'draft') throw new Error('Only a draft cart can be approved');
  if (!cart.items.length) throw new Error('There is nothing on this list to approve');
  return { ...cart, status: 'approved', approvedAt: now, updatedAt: now };
}
