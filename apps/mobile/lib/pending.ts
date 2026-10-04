import type { AppState, Cart } from '@personal-agent/core';

export type Tab = 'agent' | 'memory' | 'tasks';
export type Pending = { key: string; tab: Tab; title: string; detail: string };

const recipeTitle = (state: AppState, cart: Cart) => state.recipes.find(recipe => recipe.id === cart.recipeId)?.title ?? 'Shopping list';
const items = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;
export const isReceived = (state: AppState, cart: Cart) => !!cart.receivedAt || state.events.some(event => event.type === 'order.received' && (event.data as { cartId?: string }).cartId === cart.id);

/** Everything waiting on the person, most important first. */
export function pendingFor(state: AppState | null): Pending[] {
  if (!state) return [];
  const list: Pending[] = [];
  for (const scan of state.scans.filter(s => s.status === 'needs_review')) {
    list.push({ key: scan.id, tab: 'memory', title: 'Check what I saw', detail: scan.observations.length ? `${items(scan.observations.length)} from your kitchen video` : 'Your kitchen video is ready' });
  }
  const order: Cart['status'][] = ['draft', 'checkout_ready', 'approved', 'ordered'];
  const carts = state.carts.filter(cart => order.includes(cart.status) && !isReceived(state, cart)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  for (const cart of carts) {
    const name = recipeTitle(state, cart);
    if (cart.status === 'draft') list.push({ key: cart.id, tab: 'tasks', title: 'Approve your shopping list', detail: `${name}, ${items(cart.items.length)}` });
    if (cart.status === 'approved') list.push({ key: cart.id, tab: 'tasks', title: 'Ready to open the store', detail: name });
    if (cart.status === 'checkout_ready') list.push({ key: cart.id, tab: 'tasks', title: 'Add your order number', detail: `After you pay for ${name}` });
    if (cart.status === 'ordered') list.push({ key: cart.id, tab: 'tasks', title: 'Waiting for delivery', detail: `Tap when ${name} arrives` });
  }
  return list;
}

/** Tabs that should carry the attention dot. A delivery in transit is not urgent. */
export function attentionTabs(state: AppState | null): Set<Tab> {
  return new Set(pendingFor(state).filter(item => !item.title.startsWith('Waiting')).map(item => item.tab));
}
