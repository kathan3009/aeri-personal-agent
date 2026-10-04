import type { AppState, Cart } from '@personal-agent/core';

export type Tab = 'agent' | 'memory' | 'tasks';
export type Pending = { key: string; tab: Tab; title: string; detail: string; quiet?: boolean };

export const cartTitle = (state: AppState, cart: Cart) => cart.title ?? state.recipes.find(recipe => recipe.id === cart.recipeId)?.title ?? 'Shopping list';
const items = (count: number) => `${count} ${count === 1 ? 'item' : 'items'}`;
export const isReceived = (state: AppState, cart: Cart) => !!cart.receivedAt || state.events.some(event => event.type === 'order.received' && (event.data as { cartId?: string }).cartId === cart.id);

/** Everything waiting on the person (or on Aeri), most important first. Quiet entries don't earn an attention dot. */
export function pendingFor(state: AppState | null): Pending[] {
  if (!state) return [];
  const list: Pending[] = [];
  for (const scan of state.scans.filter(s => s.status === 'needs_review')) {
    const closer = scan.unclear.length + scan.observations.filter(o => o.closeUp).length;
    list.push({ key: scan.id, tab: 'memory', title: 'Check what I saw', detail: `${items(scan.observations.length)} from your video${closer ? `, ${closer} need a closer look` : ''}` });
  }
  for (const scan of state.scans.filter(s => s.status === 'processing')) list.push({ key: scan.id, tab: 'memory', title: 'Mapping your video', detail: 'This takes about half a minute', quiet: true });
  for (const search of state.photoSearches.filter(s => s.status === 'ready' && !s.cartId).slice(0, 1)) {
    const exact = search.candidates.filter(c => c.match === 'exact').length;
    list.push({ key: search.id, tab: 'tasks', title: 'Pick a match', detail: `${search.spec?.brand ? `${search.spec.brand} ` : ''}${search.spec?.name ?? 'Your photo'}, ${exact ? `${exact} exact` : 'no exact match yet'}` });
  }
  for (const search of state.photoSearches.filter(s => s.status === 'searching')) list.push({ key: search.id, tab: 'tasks', title: 'Looking for your item', detail: 'Reading the photo and checking stores', quiet: true });
  const order: Cart['status'][] = ['draft', 'checkout_ready', 'approved', 'ordered'];
  const carts = state.carts.filter(cart => order.includes(cart.status) && !isReceived(state, cart)).sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  for (const cart of carts) {
    const name = cartTitle(state, cart);
    const comparing = state.proposals.some(p => p.cartId === cart.id && p.status === 'searching');
    if (cart.status === 'draft') list.push(comparing ? { key: cart.id, tab: 'tasks', title: 'Comparing stores', detail: name, quiet: true } : { key: cart.id, tab: 'tasks', title: cart.merchant ? 'Approve your list' : 'Review your list', detail: `${name}, ${items(cart.items.length)}` });
    if (cart.status === 'approved') list.push(cart.checkout?.status === 'preparing' ? { key: cart.id, tab: 'tasks', title: 'Filling your store cart', detail: name, quiet: true } : { key: cart.id, tab: 'tasks', title: 'Ready to open the store', detail: name });
    if (cart.status === 'checkout_ready') list.push(cart.checkout?.status === 'preparing' ? { key: cart.id, tab: 'tasks', title: 'Filling your store cart', detail: name, quiet: true } : { key: cart.id, tab: 'tasks', title: 'Add your order number', detail: `After you pay for ${name}` });
    if (cart.status === 'ordered') list.push({ key: cart.id, tab: 'tasks', title: 'Waiting for delivery', detail: `Tap when ${name} arrives`, quiet: true });
  }
  return list.sort((a, b) => Number(!!a.quiet) - Number(!!b.quiet));
}

/** Tabs that should carry the attention dot. Work in progress and deliveries in transit are not urgent. */
export function attentionTabs(state: AppState | null): Set<Tab> {
  return new Set(pendingFor(state).filter(item => !item.quiet).map(item => item.tab));
}
