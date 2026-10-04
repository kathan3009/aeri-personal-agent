import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, ChevronDown, Clapperboard, Ellipsis, ExternalLink, PackageCheck, Search, Store, Trash, X } from 'lucide-react-native';
import { covers, normalizeName, type AppState, type Basket, type Cart, type Proposal, type Recipe } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { cartTitle, isReceived } from '../lib/pending';
import { openRetailerBrowser } from '../lib/retailer-browser';
import { c, host, quantity, radius, t, titleCase } from '../lib/theme';
import { LargeHeader } from './Header';
import { Fill, Pop, Reveal, Shimmer } from './motion';
import { PhotoCard } from './PhotoCard';
import { Aura, Button, Dot, Field, Group, HoldButton, Row, SectionHeader, Sheet, Stepper, Tag } from './ui';

type Suggestions = Array<{ itemId: string; results: Array<{ title: string; url: string }> }>;
const steps = ['Review', 'Approved', 'Store open', 'Ordered', 'Delivered'];
const stepOf = (cart: Cart, received: boolean) => received ? 4 : ({ draft: 0, approved: 1, checkout_ready: 2, ordered: 3, cancelled: 0 })[cart.status];
const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
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

const basketTotal = (b: Basket) => b.complete ? dollars(b.totalCents)! : `${dollars(b.knownTotalCents)}+`;
const basketDetail = (b: Basket) => [
  b.fulfillment === 'pickup' ? 'Pickup' : 'Delivery',
  b.distanceMiles != null ? `${b.distanceMiles.toFixed(1)} mi${b.distanceMeasure === 'straight_line' ? ' (straight line)' : ''}` : 'distance unknown',
  b.missing ? `${b.missing} missing` : null,
  !b.complete && b.unknowns.some(u => !/price/.test(u)) ? 'some fees unknown' : null,
  b.unknowns.some(u => /price/.test(u)) ? 'some prices unknown' : null,
].filter(Boolean).join(' · ');

/** The store comparison inside a draft list: all-in totals, the reason for the pick, and one tap to choose. */
function StoreChoice({ cart, proposal, busy, onChoose }: { cart: Cart; proposal: Proposal; busy: boolean; onChoose: (basket: Basket) => void }) {
  if (proposal.status === 'searching') return <View style={styles.note}><Shimmer style={[t.subhead, { color: c.ink }]}>Checking prices at stores…</Shimmer><Text style={[t.footnote, { marginTop: 4 }]}>Reading each store’s own product page. This can take a minute.</Text></View>;
  if (proposal.status === 'failed') return <View style={styles.note}><Text style={[t.subhead, { color: c.ember }]}>{proposal.error ?? 'The comparison failed'}</Text></View>;
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
              <Text style={[t.number, { fontSize: 17 }]}>{basketTotal(basket)}</Text>
            </View>
            <Text style={t.footnote} numberOfLines={2}>{basketDetail(basket)}</Text>
            {basket.id === recommended?.id && <Text style={[t.caption, { color: c.leaf, marginTop: 2 }]}>Best for {proposal.request.optimize === 'lowest_total' ? 'all-in cost' : proposal.request.optimize.replace('_', ' ')}</Text>}
          </View>
        </Pressable>;
      })}
    </Group>
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
          <Text style={[t.number, { fontSize: 15 }]}>{quantity(item.quantity)}</Text>
        </Pressable>)}
      </Group>
    </ScrollView>
    <Button label={received === cart.items.length ? 'Everything arrived' : `Add ${items(received)} to memory`} loading={busy} onPress={() => onConfirm(Object.fromEntries(cart.items.map(i => [i.id, missing[i.id] ? 'missing' : 'received'])))} style={{ marginTop: 16 }} />
  </Sheet>;
}

function CartCard({ cart }: { cart: Cart }) {
  const { state, request, refresh, providers } = useApp();
  const { toast, ask } = useFeedback();
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
  const title = cartTitle(state, cart);
  const act = async <T,>(path: string, body?: unknown, method = 'POST'): Promise<T | null> => {
    try { setBusy(path); const result = await request<T>(`/v1/carts/${cart.id}/${path}`, { method: path.startsWith('items/') ? 'DELETE' : method, body: body ? JSON.stringify(body) : undefined }); await refresh(); return result; }
    catch (error) { haptic.warning(); toast((error as Error).message, 'error'); return null; }
    finally { setBusy(null); }
  };
  const openStore = async () => {
    const result = await act<{ url: string | null; note: string }>('checkout');
    if (result?.url) { haptic.success(); try { await openRetailerBrowser(result.url); } catch (error) { toast((error as Error).message, 'error'); } }
    else if (result) toast('Filling your store cart. I’ll show it when it’s ready.', 'working');
  };
  const reviewStore = async () => {
    const link = await act<{ url: string; live: boolean; note?: string }>('review', undefined, 'GET');
    if (!link) return;
    if (link.note) toast(link.note, 'info');
    try { await openRetailerBrowser(link.url); } catch (error) { toast((error as Error).message, 'error'); }
  };
  const findLinks = async () => {
    try { setBusy('research'); setSuggestions(await request<Suggestions>(`/v1/carts/${cart.id}/research`, { method: 'POST' })); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(null); }
  };
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
  const list = <Group style={styles.inner}>
    {draft && recipe && <Row title="Servings" right={<Stepper label="Servings" value={recipe.servings} disabled={!!busy} onChange={servings => void act('servings', { servings })} />} />}
    {cart.items.map(item => {
      const line = cart.checkout?.lines.find(l => l.itemId === item.id);
      const sub = [item.offer ? `${dollars(item.offer.priceCents) ?? 'price unknown'}${item.offer.packs > 1 ? ` for ${item.offer.packs}` : ''} · ${item.offer.title}` : null,
        item.status === 'unavailable' ? 'Not available at this store' : null,
        line ? ({ added: 'Added to the store cart', unavailable: 'Unavailable at the store', substituted: 'Store suggested a substitute', uncertain: line.detail ?? 'Check this in the store' })[line.result] : null,
        item.delivery && item.delivery !== 'received' ? 'Didn’t arrive' : null].filter(Boolean).join('\n');
      return <View key={item.id}>
        <Row title={titleCase(item.name)} subtitle={sub || undefined} accessibilityLabel={`${item.name}, ${quantity(item.quantity)}${sub ? `, ${sub}` : ''}`}
          right={<View style={styles.itemRight}>
            <Text style={[t.number, { fontSize: 16 }]}>{quantity(item.quantity)}</Text>
            {draft && <Pressable onPress={() => { haptic.tap(); void act(`items/${item.id}`); }} disabled={!!busy} hitSlop={10} style={styles.remove} accessibilityRole="button" accessibilityLabel={`Remove ${item.name} from the list`}><X size={14} color={c.ink2} strokeWidth={2.4} /></Pressable>}
          </View>} />
        {!!item.check && draft && <Text style={styles.check}>{item.check}</Text>}
      </View>;
    })}
  </Group>;
  const disclosure = (label: string) => <>
    <Pressable onPress={() => { haptic.tap(); setShowItems(!itemsOpen); }} style={styles.disclosure} accessibilityRole="button" accessibilityState={{ expanded: itemsOpen }}>
      <Text style={[t.callout, { flex: 1 }]}>{label}</Text>
      <ChevronDown size={18} color={c.ink3} strokeWidth={2} style={{ transform: [{ rotate: itemsOpen ? '180deg' : '0deg' }] }} />
    </Pressable>
    {itemsOpen && list}
  </>;
  const chosen = proposal?.baskets.find(b => b.id === cart.basketId);
  const total = cart.estimatedTotalCents != null ? dollars(cart.estimatedTotalCents) : null;
  const canApprove = cart.origin === 'photo' || !!chosen || skipCompare;
  const approveLabel = chosen || cart.origin === 'photo' ? `Hold to approve${total ? ` ${total}` : ''}${cart.merchant ? ` at ${cart.merchant}` : ''}` : `Hold to approve ${items(cart.items.length)}`;
  return <Reveal style={styles.card}>
    <Progress step={step} />
    <View style={styles.titleRow}>
      <Text style={[t.title2, { flex: 1 }]} accessibilityRole="header">{title}</Text>
      <Pressable onPress={() => { haptic.tap(); menu(); }} hitSlop={8} style={styles.more} accessibilityRole="button" accessibilityLabel="More options for this list"><Ellipsis size={20} color={c.ink2} strokeWidth={2} /></Pressable>
    </View>
    <View style={styles.meta}>
      {recipe?.source === 'demo' && <Tag label="Sample recipe" tone="sample" />}
      <Text style={t.footnote}>{cart.origin === 'photo' ? `From your photo${cart.merchant ? ` · ${cart.merchant}` : ''}` : recipe?.source === 'demo' ? 'Not read from your video yet' : recipe?.sourceUrl ? `From ${host(recipe.sourceUrl)}` : recipe ? 'From your recipe video' : 'Shopping list'}</Text>
    </View>

    {draft && <>
      {cart.items.length > 0 ? list : <Text style={[t.callout, { marginTop: 16 }]}>You already have everything for this recipe.</Text>}
      {recipe && <FromKitchen state={state} recipe={recipe} cart={cart} />}
      {cart.items.length > 0 && cart.origin !== 'photo' && proposal && <StoreChoice cart={cart} proposal={proposal} busy={!!busy} onChoose={basket => void act('choose', { basketId: basket.id })} />}
      {cart.items.length > 0 && (canApprove
        ? <><HoldButton label={approveLabel} accessibilityLabel={approveLabel.replace('Hold to approve', 'Approve')} disabled={!!busy} style={{ marginTop: 18 }}
            onConfirm={async () => { const ok = !!(await act('approve')); if (ok) toast('Approved. Next, open the store.', 'success'); return ok; }} />
          <Text style={styles.fine}>{chosen && !chosen.complete ? 'Some fees are only shown at checkout, so the final total may be higher. ' : ''}Approving lets Aeri open the store with exactly these items. Nothing is paid for here.</Text></>
        : <>{!proposal && <Button label="Compare stores" icon={Store} loading={busy === 'compare'} onPress={() => void act('compare', {})} style={{ marginTop: 18 }} />}
          {proposal?.status === 'ready' && <Text style={styles.fine}>Choose a store to approve its total.</Text>}
          <Button label="Skip comparing" tone="plain" onPress={() => { haptic.tap(); setSkipCompare(true); }} style={{ marginTop: 2 }} /></>)}
      {cart.items.length === 0 && <Button label="Done" tone="secondary" onPress={() => void act('cancel')} style={{ marginTop: 18 }} />}
    </>}

    {cart.status === 'approved' && <>
      {disclosure(`${items(cart.items.length)} approved${total ? `, about ${total}` : ''}`)}
      {cart.checkout?.status === 'preparing'
        ? <View style={styles.note}><Shimmer style={[t.subhead, { color: c.ink }]}>Filling your cart at the store…</Shimmer><Text style={[t.footnote, { marginTop: 4 }]}>Aeri adds only the approved items in a private browser and stops before checkout.</Text></View>
        : <>
          {cart.checkout?.status === 'failed' && <Text style={[t.footnote, { color: c.ember, marginTop: 12, marginHorizontal: 4 }]}>{cart.checkout.note}</Text>}
          <Button label={cart.merchant && !cart.merchant.startsWith('Sample') ? `Open ${cart.merchant}` : 'Open the store'} icon={Store} loading={busy === 'checkout'} onPress={() => void openStore()} style={{ marginTop: 16 }} />
          <Text style={styles.fine}>{providers?.kernel ? 'Aeri opens a private browser, adds the approved items it can, and shows you the real cart. You pay there.' : 'Aeri opens the store in Aeri. You add the items, review the cart, and pay there.'}</Text>
        </>}
    </>}

    {cart.status === 'checkout_ready' && <>
      {cart.checkout?.status === 'preparing'
        ? <View style={styles.note}><Shimmer style={[t.subhead, { color: c.ink }]}>Filling your cart at the store…</Shimmer><Text style={[t.footnote, { marginTop: 4 }]}>Aeri adds only the approved items and stops before checkout.</Text></View>
        : <View style={styles.note}>
          <Text style={[t.subhead, { color: c.ink }]}>{cart.checkout?.note ?? 'The store is open. Finish checkout there.'}</Text>
          <Text style={[t.footnote, { marginTop: 6 }]}>Check the store, items, quantities, substitutions and final total. Aeri hasn’t placed an order. After paying, add the order number from the store’s confirmation.</Text>
        </View>}
      {disclosure(cart.checkout?.mode === 'kernel' ? `${items(cart.items.length)} approved` : `${items(cart.items.length)} to add at the store`)}
      {cart.checkout?.status !== 'preparing' && cart.checkoutUrl && <Button label={cart.checkout?.mode === 'kernel' ? 'Review the store cart' : 'Open the store in Aeri'} icon={ExternalLink} tone="secondary" onPress={() => void reviewStore()} loading={busy === 'review'} style={{ marginTop: 12 }} />}
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
  const nothing = !active.length && !searches.length && !failedSearch;
  return <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]} showsVerticalScrollIndicator={false} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
    <LargeHeader title="Tasks" subtitle="Nothing is bought without your OK." />
    {nothing && <Reveal from="scale" style={styles.empty}>
      <Aura size={44} />
      <Text style={[t.headline, { marginTop: 16 }]}>Nothing waiting</Text>
      <Text style={[t.subhead, { textAlign: 'center', marginTop: 4, maxWidth: 280 }]}>Share a recipe video or a photo of something you need, and the list will wait here for you.</Text>
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
        return <Row key={cart.id} title={cartTitle(state!, cart)} subtitle={done ? `Delivered${cart.receivedAt ? ` ${day(cart.receivedAt)}` : ''}, ${items(arrived)} added to memory` : 'Discarded'}
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
  kitchen: { marginTop: 12, paddingHorizontal: 4 },
  fine: { ...t.footnote, color: c.ink2, textAlign: 'center', marginTop: 10, paddingHorizontal: 12 },
  disclosure: { flexDirection: 'row', alignItems: 'center', minHeight: 48, marginTop: 10, paddingHorizontal: 2 },
  note: { marginTop: 16, backgroundColor: c.canvas, borderRadius: radius.group, padding: 14 },
  choiceHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 2 },
  basket: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 60 },
  basketTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: c.ink3, alignItems: 'center', justifyContent: 'center' },
  radioOn: { backgroundColor: c.accent, borderColor: c.accent },
  deliveryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 52 },
  empty: { alignItems: 'center', marginTop: 28, backgroundColor: c.surface, borderRadius: radius.dock, paddingHorizontal: 24, paddingVertical: 32 },
});
