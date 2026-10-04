import { appStateSchema, emptyState, type AppState } from '@personal-agent/core';

export const entityKeys = ['inventory', 'recipes', 'carts', 'scans', 'messages', 'tasks', 'events', 'photoSearches', 'proposals'] as const;
export type EntityKey = typeof entityKeys[number];
export type EntityRow = { id: string; position: number; body: unknown };
export type RetentionLimits = { events: number; messages: number; completedTasks: number };
export const defaultRetention: RetentionLimits = { events: 2000, messages: 500, completedTasks: 200 };

/** Keep actionable work, while bounding the histories returned to phones and the agent. */
export function retainState(input: AppState, limits: RetentionLimits = defaultRetention): AppState {
  const state = appStateSchema.parse(input);
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Retention limits must be nonnegative integers');
  const newest = <T>(items: T[], count: number) => count ? items.slice(-count) : [];
  state.events = newest(state.events, limits.events);
  state.messages = newest(state.messages, limits.messages);
  const completed = state.tasks.filter(task => task.status === 'done' || task.status === 'failed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const keep = new Set(completed.slice(0, limits.completedTasks).map(task => task.id));
  state.tasks = state.tasks.filter(task => task.status === 'running' || task.status === 'needs_review' || keep.has(task.id));
  return state;
}

export function entityRows(state: AppState, key: EntityKey): EntityRow[] {
  const ids = new Set<string>();
  return state[key].map((body, position) => {
    if (ids.has(body.id)) throw new Error(`Duplicate ${key} identifier`);
    ids.add(body.id);
    return { id: body.id, position, body };
  });
}

export function stateFromRows(rows: Partial<Record<EntityKey, EntityRow[]>>, preferences: Record<string, string>): AppState {
  const state: Record<string, unknown> = { ...emptyState(), preferences };
  for (const key of entityKeys) state[key] = [...(rows[key] ?? [])].sort((a, b) => a.position - b.position).map(row => row.body);
  return appStateSchema.parse(state);
}

/** Independent queryable records for offers, approved line snapshots and orders. */
export function relatedRows(state: AppState): Record<'offers' | 'approvals' | 'cart_approvals' | 'orders' | 'inventory_events', EntityRow[]> {
  const offers: EntityRow[] = [];
  for (const proposal of state.proposals) for (const offer of proposal.offers) offers.push({ id: `${proposal.id}:${offer.id}`, position: offers.length, body: { proposalId: proposal.id, cartId: proposal.cartId, ...offer } });
  const cart_approvals = state.carts.filter(cart => cart.approvedAt).map((cart, position) => ({ id: cart.id, position, body: { cartId: cart.id, approvedAt: cart.approvedAt, merchant: cart.merchant, items: cart.items.map(item => ({ itemId: item.id, quantity: item.quantity, offer: item.offer })) } }));
  const approvals = state.carts.filter(cart => cart.purchaseApproval).map((cart, position) => ({ id: cart.purchaseApproval!.id, position, body: cart.purchaseApproval! }));
  const orders = state.carts.filter(cart => cart.status === 'ordered' && cart.orderReference).map((cart, position) => ({ id: cart.id, position, body: { cartId: cart.id, merchant: cart.merchant, orderReference: cart.orderReference, receivedAt: cart.receivedAt, items: cart.items } }));
  const inventory_events = state.events.filter(event => /^(inventory|scan)\./.test(event.type)).map((body, position) => ({ id: body.id, position, body }));
  return { offers, approvals, cart_approvals, orders, inventory_events };
}
