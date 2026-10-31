import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ArrowRightLeft, Check, ChevronDown, CircleAlert, CircleCheck, IdCard, LogIn, RotateCw, Clapperboard, Ellipsis, ExternalLink, Eye, PackageCheck, Plus, Search, SearchX, Store, Trash, X } from 'lucide-react-native';
import { covers, deliveredQuantity, needsPerson, normalizeName, type AppState, type Basket, type BlockReason, type Cart, type CartItem, type Proposal, type Recipe, type TraceStep } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { cartTitle, isReceived } from '../lib/pending';
import { useStoreView } from '../lib/store-view';
import { c, host, quantity, radius, t, titleCase } from '../lib/theme';
import { LargeHeader } from './Header';
import { Fill, Pop, Reveal, Shimmer } from './motion';
import { PhotoCard } from './PhotoCard';
import { Aura, Button, Dot, Field, Group, HoldButton, Row, SectionHeader, Sheet, Stepper, Tag } from './ui';

type Suggestions = Array<{ itemId: string; results: Array<{ title: string; url: string }> }>;
const steps = ['Review', 'Approved', 'In cart', 'Ordered', 'Delivered'];
const stepOf = (cart: Cart, received: boolean) => received ? 4 : ({ draft: 0, approved: 1, checkout_ready: 2, ordered: 3, cancelled: 0 })[cart.status];
/** Spoon- and cup-sized recipe amounts aren't sold; one pack covers them. */
const small = (item: CartItem) => ['tsp', 'tbsp', 'cup', 'ml', 'g', 'oz'].includes(item.quantity.unit) && !(item.quantity.unit === 'g' && item.quantity.amount >= 250) && !(item.quantity.unit === 'ml' && item.quantity.amount >= 250);
/** Store-step notes in plain words. Technical errors from earlier runs never reach the screen. */
const plain = (detail: string | undefined, name: string) => !detail || /json|position|column|undefined|typeerror|stopped:|error/i.test(detail) ? `Search for “${name.toLowerCase()}” in the store and add it` : detail;
const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
/** Why an item didn't make it into the cart, in the person's words. */
const reasonText: Record<BlockReason, string> = {
  age_check: 'Needs you to confirm you’re 21 or older (ID is checked at delivery)', sign_in: 'Needs you signed in at the store', address: 'Needs your delivery address at the store',
  bot_check: 'The store stopped Aeri with a bot check', store_limited: 'The store limited automated shopping', out_of_stock: 'Out of stock at this store', not_found: 'Not found at this store',
  minimum_order: 'Below the store’s order minimum', quantity_limit: 'Over the store’s quantity limit', other: 'Aeri couldn’t add this',
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** What Aeri did at the store, step by step, with the reference that ties it to the server logs. */
function Trace({ steps, runId }: { steps: TraceStep[]; runId?: string }) {
  const [open, setOpen] = useState(false);
  const failures = steps.filter(entry => !entry.ok).length;
  return <View style={{ marginTop: 10 }}>
    <Pressable onPress={() => { haptic.tap(); setOpen(value => !value); }} style={styles.disclosure} accessibilityRole="button" accessibilityState={{ expanded: open }}>
      <Text style={[t.callout, { flex: 1 }]}>What Aeri did</Text>
      <Text style={[t.footnote, { marginRight: 8 }]}>{steps.length} steps{failures ? `, ${failures} didn’t work` : ''}</Text>
      <ChevronDown size={18} color={c.ink3} strokeWidth={2} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
    </Pressable>
    {open && <View style={styles.trace}>
      {steps.map((entry, index) => <View key={`${entry.at}-${index}`} style={styles.traceRow} accessible accessibilityLabel={`${entry.ok ? '' : 'Didn’t work: '}${entry.detail}`}>
        {entry.ok ? <CircleCheck size={14} color={c.leaf} strokeWidth={2.2} style={{ marginTop: 2 }} /> : <CircleAlert size={14} color={c.ember} strokeWidth={2.2} style={{ marginTop: 2 }} />}
        <View style={{ flex: 1 }}>
          <Text style={[t.footnote, { color: c.ink }]}>{entry.detail}</Text>
          <Text style={t.caption}>{clock(entry.at)}{entry.store ? ` · ${entry.store}` : ''}{entry.ms ? ` · ${(entry.ms / 1000).toFixed(1)}s` : ''}</Text>
        </View>
      </View>)}
      {!!runId && <Text style={[t.footnote, { color: c.ink3, marginTop: 6 }]} selectable>Reference {runId}</Text>}
    </View>}
  </View>;
}
const day = (iso?: string) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
const dollars = (cents?: number | null) => cents == null ? null : `$${(cents / 100).toFixed(2)}`;

function Progress({ step }: { step: number }) {
  return <View accessible accessibilityLabel={`Step ${step + 1} of ${steps.length}: ${steps[step]}`}>
    <View style={styles.track}>{steps.map((_, index) => <Fill key={index} filled={index <= step} color={index === step ? c.accent : c.leaf} style={styles.segment} />)}</View>
    <View style={styles.trackLabel}>
      <Text style={[t.footnote, { color: step === 0 ? '#875810' : c.ink, fontWeight: '600' }]}>{steps[step]}</Text>
      <Text style={[t.number, t.footnote, { fontWeight: '500' }]}>{step + 1} of {steps.length}</Text>
    </View>
  </View>;
}

/** Shows how confirmed memory shaped the list, so the subtraction is visible. */
function FromKitchen({ state, recipe, cart }: { state: AppState; recipe: Recipe; cart: Cart }) {
  const lines = recipe.ingredients.flatMap(ingredient => {
    const have = state.inventory.find(item => item.confidence === 'confirmed' && covers(item.name, ingredient.name));
    if (!have) return [];
    const buying = cart.items.find(item => normalizeName(item.name) === normalizeName(ingredient.name));
    return [`${titleCase(ingredient.name)}: you have ${quantity(have.quantity)}${have.name.toLowerCase() !== ingredient.name.toLowerCase() ? ` ${have.name.toLowerCase()}` : ''}${have.size ? ` (${have.size})` : ''}${have.location ? ` in the ${have.location.toLowerCase()}` : ''}${buying ? `, buying ${quantity(buying.quantity)} more` : ''}`];
  });
  if (!lines.length) return null;
  return <View style={styles.kitchen}>
    <Text style={[t.footnote, { color: c.leaf, fontWeight: '600' }]}>Checked against what you have</Text>
    {lines.map(line => <Text key={line} style={[t.footnote, { color: c.ink, marginTop: 3 }]}>{line}</Text>)}
  </View>;
}

const noPrices = (b: Basket) => !b.complete && b.knownTotalCents === 0 && b.lines.every(l => l.status !== 'matched');
const basketTotal = (b: Basket) => b.complete ? dollars(b.totalCents)! : noPrices(b) ? 'Prices not read' : `${dollars(b.knownTotalCents)}+`;
/** Only a complete total can be called the cheapest; otherwise say what the pick is actually better at. */
const pickReason = (b: Basket, optimize: Proposal['request']['optimize']) => optimize !== 'lowest_total' ? `Best for ${optimize.replace('_', ' ')}`
  : b.complete ? 'Best for all-in cost' : b.missing === 0 ? (b.merchants.length > 1 ? 'Gets everything on the list' : 'Has everything on the list') : 'Finds the most items';
const basketDetail = (b: Basket) => {
  const outOfStock = b.lines.filter(l => l.status === 'unavailable' && l.note === 'out of stock').length;
  const toFind = b.lines.filter(l => l.status === 'unavailable' && l.note !== 'out of stock').length;
  const found = b.lines.length - outOfStock - toFind;
  return [
    b.fulfillment === 'pickup' ? 'Pickup' : 'Delivery',
    b.distanceMiles != null ? `${b.distanceMiles.toFixed(1)} mi` : null,
    `${found} of ${b.lines.length} found`,
    outOfStock ? `${outOfStock} out of stock` : null,
    b.complete ? null : 'fees at checkout',
  ].filter(Boolean).join(' · ');
};

/** The store comparison inside a draft list: all-in totals, the reason for the pick, and one tap to choose. */
function StoreChoice({ cart, proposal, busy, onChoose, onRetry }: { cart: Cart; proposal: Proposal; busy: boolean; onRetry: () => void; onChoose: (basket: Basket) => void }) {
  if (proposal.status === 'searching') return <View style={styles.note}><Shimmer style={[t.subhead, { color: c.ink }]}>Checking prices at stores…</Shimmer><Text style={[t.footnote, { marginTop: 4 }]}>Reading each store’s own product page. This can take a minute.</Text></View>;
  if (proposal.status === 'failed') return <View style={styles.note}><Text style={[t.subhead, { color: c.ember }]}>{proposal.error ?? 'The comparison failed'}</Text><Button label="Retry comparison" tone="secondary" loading={busy} onPress={onRetry} style={{ marginTop: 10 }} /></View>;
  const recommended = proposal.baskets.find(b => b.id === proposal.recommendedId);
  return <View style={{ marginTop: 16 }}>
    <View style={styles.choiceHead}>
      <Text style={[t.headline, { flex: 1 }]}>Where to buy</Text>
      {proposal.source === 'fixture' && <Tag label="Sample prices" tone="sample" />}
    </View>
    <Group style={[styles.inner, { marginTop: 8 }]}>
      {proposal.baskets.map(basket => {
        const on = cart.basketId === basket.id;
        return <Pressable key={basket.id} disabled={busy} onPress={() => { haptic.tap(); onChoose(basket); }} style={({ pressed }) => [styles.basket, pressed && { backgroundColor: c.fill }]}
          accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${basket.label}, ${basketTotal(basket)}, ${basketDetail(basket)}${basket.id === recommended?.id ? ', recommended' : ''}`}>
          <Pop on={on}><View style={[styles.radio, on && styles.radioOn]}>{on && <Check size={13} color={c.white} strokeWidth={3} />}</View></Pop>
          <View style={{ flex: 1 }}>
            <View style={styles.basketTop}>
              <Text style={[t.callout, { flex: 1, fontWeight: '600' }]} numberOfLines={1}>{basket.merchants.join(' + ')}</Text>
              <Text style={[noPrices(basket) ? t.footnote : t.number, { fontSize: noPrices(basket) ? 13 : 17 }]}>{basketTotal(basket)}</Text>
            </View>
            <Text style={t.footnote} numberOfLines={2}>{basketDetail(basket)}</Text>
            {basket.id === recommended?.id && <Text style={[t.caption, { color: c.leaf, marginTop: 2 }]}>{pickReason(basket, proposal.request.optimize)}</Text>}
          </View>
        </Pressable>;
      })}
    </Group>
    {!!proposal.stores?.length && <Text style={[t.footnote, { marginTop: 8, marginHorizontal: 4, color: c.ink }]}>Compared {proposal.stores.map(s => s.merchant).join(', ').replace(/, ([^,]*)$/, ' and $1')}.</Text>}
    <Text style={[t.footnote, { marginTop: 8, marginHorizontal: 4 }]}>{proposal.explanation}</Text>
    {proposal.rejected.length > 0 && <Text style={[t.caption, { marginTop: 4, marginHorizontal: 4 }]}>Left out: {proposal.rejected.map(r => `${r.merchant} (${r.reason})`).join(', ')}</Text>}
  </View>;
}

function DeliverySheet({ cart, visible, onClose, onConfirm, busy }: { cart: Cart; visible: boolean; onClose: () => void; onConfirm: (outcome: Record<string, 'received' | 'missing'>) => void; busy: boolean }) {
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const received = cart.items.filter(i => !missing[i.id]).length;
  return <Sheet visible={visible} onClose={onClose} title="What arrived?" message="Uncheck anything that didn’t come. Only what arrived is added to memory.">
    <ScrollView style={{ maxHeight: 360, marginTop: 14 }}>
      <Group style={{ backgroundColor: c.canvas }}>
        {cart.items.map(item => <Pressable key={item.id} onPress={() => { haptic.tap(); setMissing(m => ({ ...m, [item.id]: !m[item.id] })); }} style={styles.deliveryRow}
          accessibilityRole="checkbox" accessibilityState={{ checked: !missing[item.id] }} accessibilityLabel={`${item.name} arrived`}>
          <View style={[styles.radio, !missing[item.id] && styles.radioOn]}>{!missing[item.id] && <Check size={13} color={c.white} strokeWidth={3} />}</View>
          <Text style={[t.callout, { flex: 1, color: missing[item.id] ? c.ink3 : c.ink }]}>{titleCase(item.name)}</Text>
          <Text style={[t.number, { fontSize: 15 }]}>{quantity(deliveredQuantity(item))}</Text>
        </Pressable>)}
      </Group>
    </ScrollView>
    <Button label={received === cart.items.length ? 'Everything arrived' : `Add ${items(received)} to memory`} loading={busy} onPress={() => onConfirm(Object.fromEntries(cart.items.map(i => [i.id, missing[i.id] ? 'missing' : 'received'])))} style={{ marginTop: 16 }} />
  </Sheet>;
}

function CartCard({ cart }: { cart: Cart }) {
  const { state, account, request, refresh, providers } = useApp();
  const { toast, ask } = useFeedback();
  const storeView = useStoreView();
  const { go } = useNav();
  const [busy, setBusy] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [showItems, setShowItems] = useState<boolean | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  const [skipCompare, setSkipCompare] = useState(false);
  const [delivery, setDelivery] = useState(false);
  if (!state) return null;
  const recipe = cart.recipeId ? state.recipes.find(r => r.id === cart.recipeId) : undefined;
  const proposal = state.proposals.find(p => p.cartId === cart.id);
  const received = isReceived(state, cart);
  const step = stepOf(cart, received);
  const draft = cart.status === 'draft';
  const approvalActive = cart.purchaseApproval?.status === 'active' && Date.parse(cart.purchaseApproval.expiresAt) > Date.now();
  const title = cartTitle(state, cart);
  const act = async <T,>(path: string, body?: unknown, method = 'POST'): Promise<T | null> => {
    try { setBusy(path); const result = await request<T>(`/v1/carts/${cart.id}/${path}`, { method: path.startsWith('items/') ? 'DELETE' : method, body: body ? JSON.stringify(body) : undefined }); await refresh(); return result; }
    catch (error) { haptic.warning(); toast((error as Error).message, 'error'); return null; }
    finally { setBusy(null); }
  };
  const storeName = cart.merchant && !cart.merchant.startsWith('Sample') ? cart.merchant : host(cart.checkoutUrl) || 'The store';
  const openStore = async () => {
    const result = await act<{ url: string | null; note: string; mode?: 'manual' | 'kernel'; opener?: 'app' }>('checkout');
    // Instacart and Amazon list links open in the store's own app, where the person is already signed in.
    if (result?.url && result.opener === 'app') { haptic.success(); void Linking.openURL(result.url); }
    else if (result?.url) { haptic.success(); try { await storeView.open({ url: result.url, title: storeName, kind: result.mode === 'kernel' ? 'live' : 'site' }); } catch (error) { toast((error as Error).message, 'error'); } }
    else if (result) toast(`Filling your ${storeName} cart. Tap Watch to follow along.`, 'info');
  };
  const reviewStore = async () => {
    const link = await act<{ url: string; live: boolean; app?: boolean; note?: string }>('review', undefined, 'GET');
    if (!link) return;
    if (link.note) toast(link.note, 'info');
    // A cart in the person's own account opens in the store's app (or Safari), where they're already signed in.
    if (link.app || (!link.live && /(^|\.)(instacart|amazon)\.com$/.test(host(link.url)))) { haptic.success(); void Linking.openURL(link.url); return; }
    try { await storeView.open({ url: link.url, title: storeName, kind: link.live ? 'live' : 'site' }); } catch (error) { toast((error as Error).message, 'error'); }
  };
  // While Aeri fills the cart: what it's doing, how far it got, and the live store to watch.
  const tried = cart.checkout?.lines.length ?? 0;
  const filling = <View style={styles.note}>
    <Shimmer style={[t.subhead, { color: c.ink }]}>{cart.checkout?.note && cart.checkout.note !== 'Opening a private browser at the store…' ? cart.checkout.note : `Opening ${storeName}…`}</Shimmer>
    {tried > 0 && <View style={[styles.track, { marginTop: 10 }]}><View style={[styles.segment, { flex: 0, width: `${Math.round(tried / Math.max(1, cart.items.length) * 100)}%`, backgroundColor: c.accent }]} /></View>}
    {(cart.checkout?.trace ?? []).slice(-3).map((entry, index) => <Text key={`${entry.at}-${index}`} style={[t.footnote, { marginTop: 4, color: entry.ok ? c.ink2 : c.ember }]} numberOfLines={2}>{entry.ok ? '✓' : '!'} {entry.detail}</Text>)}
    <Text style={[t.footnote, { marginTop: 8 }]}>Only approved items are added. Aeri stops before checkout.</Text>
    {cart.checkout?.mode === 'kernel' && <Button label="Watch" icon={Eye} tone="secondary" loading={busy === 'review'} onPress={() => void reviewStore()} style={{ marginTop: 10, alignSelf: 'flex-start', paddingHorizontal: 18, minHeight: 40 }} />}
  </View>;
  const restore = async (itemId: string) => {
    try { setBusy('restore'); await request(`/v1/carts/${cart.id}/items/${itemId}/restore`, { method: 'POST' }); await refresh(); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const findLinks = async () => {
    try { setBusy('research'); setSuggestions(await request<Suggestions>(`/v1/carts/${cart.id}/research`, { method: 'POST' })); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  // What's holding items back, with the fix only the person can make (or a retry for everything else).
  const left = (cart.checkout?.lines ?? []).filter(line => line.result !== 'added');
  const heldBy = (reason: BlockReason) => cart.items.filter(item => left.some(line => line.itemId === item.id && line.reason === reason)).map(item => titleCase(item.name));
  const ageHeld = heldBy('age_check'), signInHeld = heldBy('sign_in'), addressHeld = heldBy('address');
  const retryable = left.filter(line => !needsPerson(line.reason)).length;
  const finish = async (confirmAge?: boolean) => { if (await act('finish', confirmAge ? { confirmAge } : {})) { haptic.success(); toast(confirmAge ? 'Thanks. Aeri is adding them now.' : 'Aeri is trying the remaining items.', 'info'); } };
  const needs = cart.checkout?.mode === 'kernel' && left.length > 0 ? <View style={styles.needs}>
    {ageHeld.length > 0 && <View style={styles.need}>
      <View style={styles.needHead}><IdCard size={16} color={c.sunrise} strokeWidth={2} /><Text style={[t.subhead, { color: c.ink, flex: 1, fontWeight: '600' }]}>Confirm you’re 21 or older</Text></View>
      <Text style={[t.footnote, { marginTop: 4 }]}>{ageHeld.join(', ')} {ageHeld.length === 1 ? 'needs' : 'need'} an adult’s confirmation at {storeName}. ID is checked when it’s delivered. Aeri only confirms this for you after you do.</Text>
      <Button label="I’m 21 or older, add it" tone="secondary" loading={busy === 'finish'} onPress={() => void finish(true)} style={{ marginTop: 10 }} />
    </View>}
    {signInHeld.length > 0 && <View style={styles.need}>
      <View style={styles.needHead}><LogIn size={16} color={c.sunrise} strokeWidth={2} /><Text style={[t.subhead, { color: c.ink, flex: 1, fontWeight: '600' }]}>Sign in to {storeName}</Text></View>
      <Text style={[t.footnote, { marginTop: 4 }]}>{signInHeld.join(', ')} {signInHeld.length === 1 ? 'needs' : 'need'} you signed in. Connect {storeName} in Memory → Store accounts, then try again here.</Text>
      <Button label="Open store accounts" tone="secondary" onPress={() => { haptic.tap(); go('memory'); }} style={{ marginTop: 10 }} />
    </View>}
    {addressHeld.length > 0 && <View style={styles.need}>
      <View style={styles.needHead}><Store size={16} color={c.sunrise} strokeWidth={2} /><Text style={[t.subhead, { color: c.ink, flex: 1, fontWeight: '600' }]}>Set your delivery address</Text></View>
      <Text style={[t.footnote, { marginTop: 4 }]}>{storeName} needs your address before it can add {addressHeld.join(', ')}. Set it there, then try again here.</Text>
    </View>}
    {(retryable > 0 || signInHeld.length > 0 || addressHeld.length > 0) && <Button label={`Try the ${retryable + signInHeld.length + addressHeld.length === 1 ? 'remaining item' : 'remaining items'} again`} icon={RotateCw} tone="plain" loading={busy === 'finish' && !ageHeld.length} onPress={() => void finish()} style={{ marginTop: 4 }} />}
  </View> : null;
  // A guest cart lives only in Aeri's browser; a signed-in (or older Kernel) cart is in the person's own store account.
  const guestCart = cart.checkout?.account === 'guest';
  const itemsOpen = showItems ?? (cart.status === 'checkout_ready' && cart.checkout?.mode !== 'kernel');
  const menu = () => ask({
    title,
    actions: [
      ...(recipe?.sourceUrl ? [{ label: 'Watch the recipe video', icon: Clapperboard, onPress: () => void Linking.openURL(recipe.sourceUrl!) }] : []),
      ...(draft && proposal?.status === 'ready' ? [{ label: 'Compare again', detail: 'Fresh prices from each store', icon: Store, onPress: () => void act('compare', {}) }] : []),
      ...(providers?.exa && cart.items.length && !suggestions ? [{ label: 'Find product links', detail: 'Search the web for each item', icon: Search, onPress: () => void findLinks() }] : []),
      ...(['draft', 'approved', 'checkout_ready'].includes(cart.status) ? [{ label: 'Discard this list', icon: Trash, tone: 'destructive' as const, onPress: async () => { if (await act('cancel')) toast('List discarded', 'info'); } }] : []),
    ],
  });
  const chosen = proposal?.baskets.find(b => b.id === cart.basketId);
  const primary = chosen?.merchants[0];
  const movedFrom = (itemId: string) => chosen?.lines.find(l => l.needId === itemId)?.movedFrom;
  const notFound = draft ? cart.items.filter(item => item.status === 'unavailable') : [];
  const buying = cart.items.filter(item => !notFound.includes(item));
  const keepAt = (merchant: string) => proposal?.baskets.find(b => b.merchants.length === 1 && b.merchants[0] === merchant);
  const row = (item: CartItem) => {
      const line = cart.checkout?.lines.find(l => l.itemId === item.id);
      const sub = [item.offer ? `${dollars(item.offer.priceCents) ?? 'price unknown'}${item.offer.packs > 1 ? ` for ${item.offer.packs}` : ''} · ${item.offer.title}` : null,
        item.status === 'unavailable' ? 'Not available at this store' : null,
        line ? (line.result !== 'added' && line.reason && line.reason !== 'other' ? reasonText[line.reason] : ({ added: line.reason === 'age_check' ? 'In the store cart · valid ID (21+) needed at delivery' : 'In the store cart', unavailable: 'The store doesn’t seem to carry this', substituted: 'Store suggested a substitute', uncertain: plain(line.detail, item.name) })[line.result]) : null,
        !item.offer && small(item) ? `Recipe uses ${quantity(item.quantity)}` : null,
        draft && chosen && !item.offer && item.status !== 'unavailable' ? 'Aeri will find this in the store' : null,
        item.delivery && item.delivery !== 'received' ? 'Didn’t arrive' : null].filter(Boolean).join('\n');
      const from = draft ? movedFrom(item.id) : undefined;
      return <View key={item.id}>
        <Row title={titleCase(item.name)} subtitle={sub || undefined} accessibilityLabel={`${item.name}, ${quantity(item.quantity)}${from ? `, moved because ${from} doesn’t have it` : ''}${sub ? `, ${sub}` : ''}`}
          right={<View style={styles.itemRight}>
            <Text style={[t.number, { fontSize: 16 }]}>{item.offer ? (item.offer.packs > 1 ? `${item.offer.packs} packs` : '1 pack') : small(item) ? '1 pack' : quantity(item.quantity)}</Text>
            {draft && <Pressable onPress={() => { haptic.tap(); void act(`items/${item.id}`); }} disabled={!!busy} hitSlop={10} style={styles.remove} accessibilityRole="button" accessibilityLabel={`Remove ${item.name} from the list`}><X size={14} color={c.ink2} strokeWidth={2.4} /></Pressable>}
          </View>} />
        {!!from && <View style={styles.moved}><ArrowRightLeft size={12} color={c.accent} strokeWidth={2.4} /><Text style={styles.movedText}>Moved here: {from} doesn’t have it</Text></View>}
        {!!item.check && draft && <Text style={styles.check}>{item.check}</Text>}
      </View>;
  };
  const servings = draft && recipe ? <Row title="Servings" right={<Stepper label="Servings" value={recipe.servings} disabled={!!busy} onChange={next => void act('servings', { servings: next })} />} /> : null;
  // A multi-store list shows one group per store, so it's clear what comes from where.
  const stores = draft && chosen && chosen.merchants.length > 1
    ? chosen.merchants.map(merchant => ({ merchant, items: buying.filter(item => (item.offer?.merchant ?? primary) === merchant) })).filter(group => group.items.length)
    : null;
  const list = <>
    {stores ? <>
      {servings && <Group style={styles.inner}>{servings}</Group>}
      {stores.map(group => {
        const moved = group.merchant !== primary;
        return <View key={group.merchant}>
          <View style={styles.groupHead}>
            <Store size={14} color={c.ink2} strokeWidth={2} />
            <Text style={styles.groupTitle}>At {group.merchant}</Text>
            <Text style={[t.footnote, { flex: 1 }]}>{items(group.items.length)}</Text>
            {moved && primary && keepAt(primary) && <Pressable onPress={() => { haptic.tap(); void act('choose', { basketId: keepAt(primary)!.id }).then(r => r && toast(`Back to ${primary} only`, 'info')); }} hitSlop={8} disabled={!!busy} accessibilityRole="button" accessibilityLabel={`Undo: keep everything at ${primary}`}>
              <Text style={styles.undo}>Undo</Text>
            </Pressable>}
          </View>
          <Group style={[styles.inner, { marginTop: 6 }]}>{group.items.map(row)}</Group>
        </View>;
      })}
    </> : <Group style={styles.inner}>{servings}{buying.map(row)}</Group>}
    {notFound.length > 0 && <View>
      <View style={styles.groupHead}>
        <SearchX size={14} color={c.ember} strokeWidth={2} />
        <Text style={[styles.groupTitle, { color: c.ember, flex: 1 }]}>Out of stock</Text>
        <Pressable onPress={() => { haptic.tap(); void act('compare', {}); }} hitSlop={8} disabled={!!busy} accessibilityRole="button" accessibilityLabel="Look at stores again">
          <Text style={styles.undo}>Look again</Text>
        </Pressable>
      </View>
      <Group style={[styles.inner, { marginTop: 6 }]}>
        {notFound.map(item => <View key={item.id} style={styles.missingRow} accessible accessibilityLabel={`${item.name}, not found. It will be set aside when you approve.`}>
          <View style={{ flex: 1 }}>
            <Text style={styles.missingName}>{titleCase(item.name)}</Text>
            <Text style={t.footnote}>Set aside when you approve. Compare again to try other stores.</Text>
          </View>
          <Pressable onPress={() => { haptic.tap(); void act(`items/${item.id}`); }} disabled={!!busy} hitSlop={10} style={styles.remove} accessibilityRole="button" accessibilityLabel={`Remove ${item.name} from the list`}><X size={14} color={c.ink2} strokeWidth={2.4} /></Pressable>
        </View>)}
      </Group>
    </View>}
  </>;
  const disclosure = (label: string) => <>
    <Pressable onPress={() => { haptic.tap(); setShowItems(!itemsOpen); }} style={styles.disclosure} accessibilityRole="button" accessibilityState={{ expanded: itemsOpen }}>
      <Text style={[t.callout, { flex: 1 }]}>{label}</Text>
      <ChevronDown size={18} color={c.ink3} strokeWidth={2} style={{ transform: [{ rotate: itemsOpen ? '180deg' : '0deg' }] }} />
    </Pressable>
    {itemsOpen && list}
  </>;
  const total = cart.estimatedTotalCents != null ? dollars(cart.estimatedTotalCents) : null;
  const canApprove = cart.origin === 'photo' || !!chosen || skipCompare;
  const approveLabel = notFound.length ? `Hold to approve ${items(buying.length)}` : chosen || cart.origin === 'photo' ? `Hold to approve${total ? ` ${total}` : ''}${cart.merchant ? ` at ${cart.merchant}` : ''}` : `Hold to approve ${items(cart.items.length)}`;
  return <Reveal style={styles.card}>
    <Progress step={step} />
    <View style={styles.titleRow}>
      <Text style={[t.title2, { flex: 1 }]} accessibilityRole="header">{title}</Text>
      <Pressable onPress={() => { haptic.tap(); menu(); }} hitSlop={8} style={styles.more} accessibilityRole="button" accessibilityLabel="More options for this list"><Ellipsis size={20} color={c.ink2} strokeWidth={2} /></Pressable>
    </View>
    {!!cart.splitFrom && (() => {
      const siblings = state.carts.filter(c => c.splitFrom === cart.splitFrom);
      const parent = state.carts.find(c => c.id === cart.splitFrom);
      return <View style={styles.splitNote}><Store size={13} color={c.accent} strokeWidth={2} /><Text style={[t.footnote, { color: c.accent, fontWeight: '600', flex: 1 }]}>Order {siblings.findIndex(c => c.id === cart.id) + 1} of {siblings.length} from {parent ? cartTitle(state, parent) : 'one list'}. Each store is filled and paid separately.</Text></View>;
    })()}
    <View style={styles.meta}>
      {recipe?.source === 'demo' && <Tag label="Sample recipe" tone="sample" />}
      <Text style={t.footnote}>{cart.origin === 'photo' ? `From your photo${cart.merchant ? ` · ${cart.merchant}` : ''}` : recipe?.source === 'demo' ? 'Not read from your video yet' : recipe?.sourceUrl ? `From ${host(recipe.sourceUrl)}` : recipe ? 'From your recipe video' : 'Shopping list'}</Text>
    </View>

    {draft && <>
      {cart.items.length > 0 ? list : <Text style={[t.callout, { marginTop: 16 }]}>You already have everything for this recipe.</Text>}
      {recipe && <FromKitchen state={state} recipe={recipe} cart={cart} />}
      {cart.items.length > 0 && cart.origin !== 'photo' && proposal && <StoreChoice cart={cart} proposal={proposal} busy={!!busy} onChoose={basket => void act('choose', { basketId: basket.id })} onRetry={() => void act('compare', { live: proposal.source !== 'fixture' })} />}
      {cart.items.length > 0 && (canApprove
        ? <><HoldButton label={approveLabel} accessibilityLabel={approveLabel.replace('Hold to approve', 'Approve')} disabled={!!busy} style={{ marginTop: 18 }}
            onConfirm={async () => { const ok = !!(await act('approve')); if (ok) toast(chosen && chosen.merchants.length > 1 ? `Approved. ${chosen.merchants.join(' and ')} each have their own order below.` : 'Approved. Open the store when you’re ready.', 'success'); return ok; }} />
          <Text style={styles.fine}>{notFound.length ? `${items(notFound.length)} out of stock will be set aside. ` : ''}{chosen && !chosen.complete ? 'Fees and tax are added at checkout. ' : ''}Approving lets Aeri add exactly these items to your {chosen && chosen.merchants.length > 1 ? 'carts' : 'cart'}. You pay at the store.</Text></>
        : <>{!proposal && <Button label="Compare stores" icon={Store} loading={busy === 'compare'} onPress={() => void act('compare', {})} style={{ marginTop: 18 }} />}
          {proposal?.status === 'ready' && <Text style={styles.fine}>Choose a store to approve its total.</Text>}
        </>)}
      {cart.items.length === 0 && <Button label="Done" tone="secondary" onPress={() => void act('cancel')} style={{ marginTop: 18 }} />}
    </>}

    {cart.status === 'approved' && <>
      {disclosure(`${items(cart.items.length)} approved${total ? `, about ${total}` : ''}`)}
      {cart.checkout?.status === 'preparing'
        ? filling
        : <>
          {cart.checkout?.status === 'failed' && <Text style={[t.footnote, { color: c.ember, marginTop: 12, marginHorizontal: 4 }]}>{cart.checkout.note}</Text>}
          {cart.checkout?.status === 'failed' && !!cart.checkout.trace?.length && <Trace steps={cart.checkout.trace} runId={cart.checkout.runId} />}
          <Button label={cart.merchant && !cart.merchant.startsWith('Sample') ? `Open ${cart.merchant}` : 'Open the store'} icon={Store} loading={busy === 'checkout'} onPress={() => void openStore()} style={{ marginTop: 16 }} />
          <Text style={styles.fine}>{providers?.kernel ? 'Aeri fills your cart in a private browser and stops before checkout. You review and pay at the store.' : 'The store opens in Aeri. Add the items, review the cart and pay there.'}</Text>
        </>}
    </>}

    {cart.status === 'checkout_ready' && <>
      {cart.checkout?.status === 'preparing'
        ? filling
        : <View style={styles.note}>
          <Text style={[t.subhead, { color: c.ink }]}>{cart.checkout?.note ?? 'The store is open. Finish checkout there.'}</Text>
          <Text style={[t.footnote, { marginTop: 6 }]}>{guestCart
            ? 'This guest cart is in Aeri’s private browser. Open it, check the items and pay there within 20 minutes.'
            : `Check the items, quantities and total in ${storeName}, then pay there.${account?.mailbox ? ' Aeri picks up the order number from the confirmation email.' : ' Add the order number from the confirmation afterwards.'}`}</Text>
        </View>}
      {cart.checkout?.status !== 'preparing' && needs}
      {disclosure(cart.checkout?.mode === 'kernel' ? `${items(cart.items.length)} approved` : `${items(cart.items.length)} to add at the store`)}
      {cart.checkout?.status !== 'preparing' && cart.checkoutUrl && <Button label={guestCart ? 'Check out in Aeri’s browser' : cart.checkout?.mode === 'kernel' ? `Check out at ${storeName}` : 'Open the store in Aeri'} icon={ExternalLink} onPress={() => void reviewStore()} loading={busy === 'review'} style={{ marginTop: 12 }} />}
      {!!cart.checkout?.trace?.length && cart.checkout.status !== 'preparing' && <Trace steps={cart.checkout.trace} runId={cart.checkout.runId} />}
      {cart.checkoutSnapshot && <Group style={[styles.inner, { marginTop: 12 }]}>
        <Row title="Final total" subtitle={`${cart.checkoutSnapshot.fulfillment === 'pickup' ? 'Pickup' : 'Delivery'} · Includes observed fees, tax and tip`} right={<Text style={t.headline}>{dollars(cart.checkoutSnapshot.totalCents)}</Text>} />
        <Row title="Location" subtitle={cart.checkoutSnapshot.locationKey} />
        <Row title="Fees / tax / tip" right={<Text style={t.footnote}>{dollars(cart.checkoutSnapshot.feesCents)} / {dollars(cart.checkoutSnapshot.taxCents)} / {dollars(cart.checkoutSnapshot.tipCents)}</Text>} />
      </Group>}
      {approvalActive && cart.purchaseApproval && <Text style={[t.footnote, { marginTop: 8, color: c.leaf }]}>Reviewed until {new Date(cart.purchaseApproval.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Complete payment yourself in the store.</Text>}
      {!!cart.suggestedOrderReference && !reference && <Pressable onPress={() => { haptic.tap(); setReference(cart.suggestedOrderReference!.reference); }} style={styles.suggested} accessibilityRole="button" accessibilityLabel={`Use order number ${cart.suggestedOrderReference.reference} from the email`}>
        <Text style={[t.subhead, { color: c.ink, flex: 1 }]}>Found <Text style={{ fontWeight: '600' }}>{cart.suggestedOrderReference.reference}</Text> in an email from {cart.suggestedOrderReference.from}</Text>
        <Text style={styles.undo}>Use it</Text>
      </Pressable>}
      <Group style={[styles.inner, { marginTop: 14 }]}><Field label="Order number" value={reference} onChangeText={setReference} placeholder="From the store's confirmation" autoCapitalize="characters" autoCorrect={false} returnKeyType="done" /></Group>
      <Button label="Save order number" disabled={!reference.trim()} loading={busy === 'ordered'} onPress={async () => { if (await act('ordered', { reference: reference.trim() })) { haptic.success(); setReference(''); } }} style={{ marginTop: 14 }} />
    </>}

    {cart.status === 'ordered' && !received && <>
      <Group style={styles.inner}>
        <Row title="Order number" right={<Text style={[t.number, { fontSize: 16 }]} selectable>{cart.orderReference}</Text>} />
        {(cart.merchant || cart.checkoutUrl) && <Row title="Store" right={<Text style={[t.callout, { color: c.ink2 }]}>{cart.merchant ?? host(cart.checkoutUrl)}</Text>} />}
      </Group>
      <Button label="It arrived" icon={PackageCheck} onPress={() => { haptic.tap(); setDelivery(true); }} style={{ marginTop: 16 }} />
      <Text style={styles.fine}>You’ll check off what actually came before it’s added to memory.</Text>
      <DeliverySheet cart={cart} visible={delivery} busy={busy === 'received'} onClose={() => setDelivery(false)}
        onConfirm={async outcome => { if (await act('received', { outcome })) { setDelivery(false); haptic.success(); toast('Memory updated with what arrived', 'success'); } }} />
    </>}

    {draft && !!cart.skipped?.length && <View style={styles.leftOff}>
      <Text style={[t.footnote, { color: c.ink, fontWeight: '600' }]}>Not added, pantry {cart.skipped.length === 1 ? 'staple' : 'staples'}</Text>
      <View style={styles.leftOffRow}>{cart.skipped.map(item => <Pressable key={item.id} onPress={() => { haptic.tap(); void restore(item.id); }} disabled={!!busy} style={styles.leftOffChip} accessibilityRole="button" accessibilityLabel={`Add ${item.name} back to the list`}>
        <Plus size={13} color={c.accent} strokeWidth={2.4} /><Text style={[t.footnote, { color: c.accent, fontWeight: '600' }]}>{titleCase(item.name)}</Text>
      </Pressable>)}</View>
    </View>}
    {!draft && !!cart.skipped?.length && <Text style={[t.footnote, { marginTop: 12, marginHorizontal: 4 }]}>Set aside, no store had {cart.skipped.length === 1 ? 'it' : 'them'}: {cart.skipped.map(i => i.name.toLowerCase()).join(', ')}</Text>}
    {suggestions && <View style={{ marginTop: 14 }}>
      <Text style={[t.footnote, { marginBottom: 6, marginLeft: 4 }]}>Product links from the web. Prices and stock aren't checked.</Text>
      <Group style={styles.inner}>{suggestions.flatMap(entry => entry.results.slice(0, 1).map(result => <Row key={entry.itemId} title={result.title} subtitle={host(result.url)} onPress={() => void Linking.openURL(result.url)} right={<ExternalLink size={16} color={c.ink3} />} />))}</Group>
    </View>}
  </Reveal>;
}

const taskStatus = { running: [c.accent, 'Working on it'], needs_review: [c.sunrise, 'Waiting for you'], done: [c.leaf, 'Done'], failed: [c.ember, 'Didn’t work'] } as const;

export function TasksTab() {
  const { state } = useApp();
  const { bottomInset, go } = useNav();
  const carts = state?.carts ?? [];
  const active = carts.filter(cart => cart.status !== 'cancelled' && !isReceived(state!, cart));
  const earlier = carts.filter(cart => cart.status === 'cancelled' || isReceived(state!, cart)).slice(0, 8);
  const searches = (state?.photoSearches ?? []).filter(s => !s.cartId && s.status !== 'failed').slice(0, 2);
  const failedSearch = (state?.photoSearches ?? []).find(s => s.status === 'failed' && Date.now() - new Date(s.updatedAt).getTime() < 3_600_000);
  const activity = (state?.tasks ?? []).filter(task => task.status === 'running' && task.kind !== 'photo' && task.kind !== 'compare' || task.status === 'failed' && task.kind !== 'photo' || (task.kind === 'receipt' && task.status === 'needs_review')).slice(0, 4);
  const nothing = !active.length && !searches.length && !failedSearch && !activity.length;
  return <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]} showsVerticalScrollIndicator={false} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
    <LargeHeader title="Tasks" subtitle="Nothing is purchased without your approval." />
    {nothing && <Reveal from="scale" style={styles.empty}>
      <Aura size={44} />
      <Text style={[t.headline, { marginTop: 16 }]}>Nothing waiting</Text>
      <Text style={[t.subhead, { textAlign: 'center', marginTop: 4, maxWidth: 280 }]}>Lists from recipes, photos and requests appear here for your review.</Text>
      <Button label="Go to Aeri" tone="secondary" onPress={() => go('agent')} style={{ marginTop: 18, paddingHorizontal: 26 }} />
    </Reveal>}
    {searches.map(search => <PhotoCard key={search.id} search={search} />)}
    {failedSearch && <PhotoCard search={failedSearch} />}
    {active.map(cart => <CartCard key={cart.id} cart={cart} />)}
    {activity.length > 0 && <>
      <SectionHeader title="Activity" />
      <Group>{activity.map(task => <Row key={task.id} title={task.title} subtitle={task.status === 'failed' || task.kind === 'receipt' ? task.detail ?? taskStatus[task.status][1] : taskStatus[task.status][1]} left={<Dot color={taskStatus[task.status][0]} />} />)}</Group>
    </>}
    {earlier.length > 0 && <>
      <SectionHeader title="Earlier" />
      <Group>{earlier.map(cart => {
        const done = isReceived(state!, cart);
        const arrived = cart.items.filter(i => !i.delivery || i.delivery === 'received').length;
        return <Row key={cart.id} title={cartTitle(state!, cart)} subtitle={done ? `Delivered${cart.receivedAt ? ` ${day(cart.receivedAt)}` : ''}, ${items(arrived)} added to memory` : cart.splitInto?.length ? `Split into orders at ${cart.splitInto.map(id => state!.carts.find(c => c.id === id)?.merchant).filter(Boolean).join(' and ')}` : 'Discarded'}
          left={<Dot color={done ? c.leaf : 'rgba(15,43,64,0.2)'} />} />;
      })}</Group>
    </>}
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20 },
  card: { marginTop: 24, backgroundColor: c.surface, borderRadius: radius.dock, padding: 18 },
  track: { flexDirection: 'row', gap: 4 },
  segment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: 'rgba(15,43,64,0.09)' },
  trackLabel: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 14 },
  more: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.canvas, alignItems: 'center', justifyContent: 'center', marginTop: -4 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  inner: { marginTop: 16, backgroundColor: c.canvas },
  itemRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  remove: { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(15,43,64,0.07)', alignItems: 'center', justifyContent: 'center' },
  check: { ...t.footnote, color: '#875810', paddingHorizontal: 16, paddingBottom: 10, marginTop: -6 },
  moved: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingBottom: 10, marginTop: -6 },
  movedText: { ...t.footnote, color: c.accent, fontWeight: '500' },
  groupHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18, paddingHorizontal: 4 },
  groupTitle: { ...t.subhead, color: c.ink, fontWeight: '600' },
  undo: { ...t.subhead, color: c.accent, fontWeight: '600' },
  suggested: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, padding: 14, borderRadius: radius.group, backgroundColor: c.tint },
  splitNote: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  leftOff: { marginTop: 14, paddingHorizontal: 4, gap: 8 },
  leftOffRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  leftOffChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, minHeight: 30, borderRadius: radius.pill, backgroundColor: c.tint },
  missingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 52 },
  missingName: { ...t.callout, color: c.ink2, textDecorationLine: 'line-through' },
  kitchen: { marginTop: 12, paddingHorizontal: 4 },
  fine: { ...t.footnote, color: c.ink2, textAlign: 'center', marginTop: 10, paddingHorizontal: 12 },
  disclosure: { flexDirection: 'row', alignItems: 'center', minHeight: 48, marginTop: 10, paddingHorizontal: 2 },
  note: { marginTop: 16, backgroundColor: c.canvas, borderRadius: radius.group, padding: 14 },
  needs: { marginTop: 12, gap: 10 },
  need: { backgroundColor: c.sunriseTint, borderRadius: radius.group, padding: 14 },
  needHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trace: { marginTop: 6, gap: 10, paddingHorizontal: 4 },
  traceRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  choiceHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  basket: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  basketTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: c.ink3, alignItems: 'center', justifyContent: 'center' },
  radioOn: { backgroundColor: c.accent, borderColor: c.accent },
  deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 52 },
  empty: { alignItems: 'center', marginTop: 28, backgroundColor: c.surface, borderRadius: radius.dock, paddingHorizontal: 24, paddingVertical: 32 },
});
