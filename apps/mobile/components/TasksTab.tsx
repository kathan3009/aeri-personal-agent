import { useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronDown, Clapperboard, Ellipsis, ExternalLink, PackageCheck, Search, Store, Trash, X } from 'lucide-react-native';
import { normalizeName, type AppState, type Cart, type Recipe } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { isReceived } from '../lib/pending';
import { c, host, quantity, radius, t, titleCase } from '../lib/theme';
import { LargeHeader } from './Header';
import { Fill, Reveal } from './motion';
import { Aura, Button, Dot, Field, Group, HoldButton, Row, SectionHeader, Stepper, Tag } from './ui';

type Suggestions = Array<{ itemId: string; results: Array<{ title: string; url: string }> }>;
const steps = ['Needs your approval', 'Approved', 'Store is open', 'Ordered', 'Delivered'];
const stepOf = (cart: Cart, received: boolean) => received ? 4 : ({ draft: 0, approved: 1, checkout_ready: 2, ordered: 3, cancelled: 0 })[cart.status];
const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
const day = (iso?: string) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';

function Progress({ step }: { step: number }) {
  return <View accessible accessibilityLabel={`Step ${step + 1} of ${steps.length}: ${steps[step]}`}>
    <View style={styles.track}>{steps.map((_, index) => <Fill key={index} filled={index <= step} color={index === step ? c.accent : c.leaf} style={styles.segment} />)}</View>
    <View style={styles.trackLabel}>
      <Text style={[t.footnote, { color: step === 0 ? '#875810' : c.ink, fontWeight: '600' }]}>{steps[step]}</Text>
      <Text style={[t.number, t.footnote, { fontWeight: '500' }]}>{step + 1} of {steps.length}</Text>
    </View>
  </View>;
}

/** Shows how confirmed kitchen memory shaped the list, so the subtraction is visible. */
function FromKitchen({ state, recipe, cart }: { state: AppState; recipe: Recipe; cart: Cart }) {
  const lines = recipe.ingredients.flatMap(ingredient => {
    const have = state.inventory.find(item => item.confidence === 'confirmed' && normalizeName(item.name) === normalizeName(ingredient.name));
    if (!have) return [];
    const buying = cart.items.find(item => normalizeName(item.name) === normalizeName(ingredient.name));
    return [`${titleCase(ingredient.name)}: you have ${quantity(have.quantity)}${buying ? `, buying ${quantity(buying.quantity)} more` : ''}`];
  });
  if (!lines.length) return null;
  return <View style={styles.kitchen}>
    <Text style={[t.footnote, { color: c.leaf, fontWeight: '600' }]}>Checked against your kitchen</Text>
    {lines.map(line => <Text key={line} style={[t.footnote, { color: c.ink, marginTop: 3 }]}>{line}</Text>)}
  </View>;
}

function CartCard({ cart }: { cart: Cart }) {
  const { state, request, refresh, providers } = useApp();
  const { toast, ask } = useFeedback();
  const [busy, setBusy] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [showItems, setShowItems] = useState<boolean | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestions | null>(null);
  if (!state) return null;
  const recipe = state.recipes.find(r => r.id === cart.recipeId);
  const received = isReceived(state, cart);
  const step = stepOf(cart, received);
  const draft = cart.status === 'draft';
  const act = async <T,>(path: string, body?: unknown): Promise<T | null> => {
    try { setBusy(path); const result = await request<T>(`/v1/carts/${cart.id}/${path}`, { method: path.startsWith('items/') ? 'DELETE' : 'POST', body: body ? JSON.stringify(body) : undefined }); await refresh(); return result; }
    catch (error) { haptic.warning(); toast((error as Error).message, 'error'); return null; }
    finally { setBusy(null); }
  };
  const openStore = async () => {
    const result = await act<{ url: string; note: string }>('checkout');
    if (result?.url) { haptic.success(); void Linking.openURL(result.url); }
  };
  const findLinks = async () => {
    try { setBusy('research'); setSuggestions(await request<Suggestions>(`/v1/carts/${cart.id}/research`, { method: 'POST' })); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const itemsOpen = showItems ?? (cart.status === 'checkout_ready' && cart.checkout?.mode !== 'kernel');
  const disclosure = (label: string) => <>
    <Pressable onPress={() => { haptic.tap(); setShowItems(!itemsOpen); }} style={styles.disclosure} accessibilityRole="button" accessibilityState={{ expanded: itemsOpen }}>
      <Text style={[t.callout, { flex: 1 }]}>{label}</Text>
      <ChevronDown size={18} color={c.ink3} strokeWidth={2} style={{ transform: [{ rotate: itemsOpen ? '180deg' : '0deg' }] }} />
    </Pressable>
    {itemsOpen && list}
  </>;
  const menu = () => ask({
    title: recipe?.title ?? 'Shopping list',
    actions: [
      ...(recipe?.sourceUrl ? [{ label: 'Watch the recipe video', icon: Clapperboard, onPress: () => void Linking.openURL(recipe.sourceUrl!) }] : []),
      ...(providers?.exa && cart.items.length && !suggestions ? [{ label: 'Find product links', detail: 'Search the web for each item', icon: Search, onPress: () => void findLinks() }] : []),
      ...(['draft', 'approved', 'checkout_ready'].includes(cart.status) ? [{ label: 'Discard this list', icon: Trash, tone: 'destructive' as const, onPress: async () => { if (await act('cancel')) toast('List discarded', 'info'); } }] : []),
    ],
  });
  const list = <Group style={styles.inner}>
    {draft && recipe && <Row title="Servings" right={<Stepper label="Servings" value={recipe.servings} disabled={!!busy} onChange={servings => void act('servings', { servings })} />} />}
    {cart.items.map(item => <Row key={item.id} title={titleCase(item.name)} accessibilityLabel={`${item.name}, ${quantity(item.quantity)}`}
      right={<View style={styles.itemRight}>
        <Text style={[t.number, { fontSize: 16 }]}>{quantity(item.quantity)}</Text>
        {draft && <Pressable onPress={() => { haptic.tap(); void act(`items/${item.id}`); }} disabled={!!busy} hitSlop={10} style={styles.remove} accessibilityRole="button" accessibilityLabel={`Remove ${item.name} from the list`}><X size={14} color={c.ink2} strokeWidth={2.4} /></Pressable>}
      </View>} />)}
  </Group>;
  return <Reveal style={styles.card}>
    <Progress step={step} />
    <View style={styles.titleRow}>
      <Text style={[t.title2, { flex: 1 }]} accessibilityRole="header">{recipe?.title ?? 'Shopping list'}</Text>
      <Pressable onPress={() => { haptic.tap(); menu(); }} hitSlop={8} style={styles.more} accessibilityRole="button" accessibilityLabel="More options for this list"><Ellipsis size={20} color={c.ink2} strokeWidth={2} /></Pressable>
    </View>
    <View style={styles.meta}>
      {recipe?.source === 'demo' && <Tag label="Sample recipe" tone="sample" />}
      <Text style={t.footnote}>{recipe?.source === 'demo' ? 'Not read from your video yet' : recipe?.sourceUrl ? `From ${host(recipe.sourceUrl)}` : 'Shopping list'}</Text>
    </View>

    {draft && <>
      {cart.items.length > 0 ? list : <Text style={[t.callout, { marginTop: 16 }]}>You already have everything for this recipe.</Text>}
      {recipe && <FromKitchen state={state} recipe={recipe} cart={cart} />}
      {cart.items.length > 0
        ? <><HoldButton label={`Hold to approve ${items(cart.items.length)}`} accessibilityLabel={`Approve ${items(cart.items.length)}`} disabled={!!busy} style={{ marginTop: 18 }}
            onConfirm={async () => { const ok = !!(await act('approve')); if (ok) toast('Approved. Next, open the store.', 'success'); return ok; }} />
          <Text style={styles.fine}>Approving lets Aeri open the store with exactly these items. Nothing is paid for here.</Text></>
        : <Button label="Done" tone="secondary" onPress={() => void act('cancel')} style={{ marginTop: 18 }} />}
    </>}

    {cart.status === 'approved' && <>
      {disclosure(`${items(cart.items.length)} approved`)}
      <Button label="Open the store" icon={Store} loading={busy === 'checkout'} onPress={() => void openStore()} style={{ marginTop: 16 }} />
      <Text style={styles.fine}>{providers?.kernel ? 'Aeri opens a private browser and adds these items. You sign in, check the cart, and pay there.' : 'Aeri opens the store’s website. You add the items and pay there.'}</Text>
    </>}

    {cart.status === 'checkout_ready' && <>
      <View style={styles.note}>
        <Text style={[t.subhead, { color: c.ink }]}>{cart.checkout?.note ?? 'The store is open. Finish checkout there.'}</Text>
        <Text style={[t.footnote, { marginTop: 6 }]}>Aeri hasn't placed an order. When you've paid, add the order number from the store's confirmation.</Text>
      </View>
      {disclosure(cart.checkout?.mode === 'kernel' ? `${items(cart.items.length)} approved` : `${items(cart.items.length)} to add at the store`)}
      {cart.checkoutUrl && <Button label="Open the store again" icon={ExternalLink} tone="plain" onPress={() => void Linking.openURL(cart.checkoutUrl!)} style={{ alignSelf: 'flex-start', marginTop: 4 }} />}
      <Group style={[styles.inner, { marginTop: 4 }]}><Field label="Order number" value={reference} onChangeText={setReference} placeholder="From the store's confirmation" autoCapitalize="characters" autoCorrect={false} returnKeyType="done" /></Group>
      <Button label="Save order number" disabled={!reference.trim()} loading={busy === 'ordered'} onPress={async () => { if (await act('ordered', { reference: reference.trim() })) { haptic.success(); setReference(''); } }} style={{ marginTop: 16 }} />
    </>}

    {cart.status === 'ordered' && !received && <>
      <Group style={styles.inner}>
        <Row title="Order number" right={<Text style={[t.number, { fontSize: 16 }]} selectable>{cart.orderReference}</Text>} />
        {cart.checkoutUrl && <Row title="Store" right={<Text style={[t.callout, { color: c.ink2 }]}>{host(cart.checkoutUrl)}</Text>} />}
      </Group>
      <Button label="It arrived" icon={PackageCheck} loading={busy === 'received'} onPress={async () => { if (await act('received')) { haptic.success(); toast(`Added ${items(cart.items.length)} to your kitchen`, 'success'); } }} style={{ marginTop: 16 }} />
      <Text style={styles.fine}>Adds these {items(cart.items.length)} to your kitchen memory.</Text>
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
  const activity = (state?.tasks ?? []).filter(task => task.status === 'running' || task.status === 'failed' || (task.kind === 'receipt' && task.status === 'needs_review')).slice(0, 4);
  return <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]} showsVerticalScrollIndicator={false} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
    <LargeHeader title="Tasks" subtitle="Shopping lists wait here for your OK." />
    {active.length === 0 && <Reveal from="scale" style={styles.empty}>
      <Aura size={44} />
      <Text style={[t.headline, { marginTop: 16 }]}>No lists waiting</Text>
      <Text style={[t.subhead, { textAlign: 'center', marginTop: 4, maxWidth: 280 }]}>Share a recipe video with Aeri and it will list only what you're missing.</Text>
      <Button label="Go to Agent" tone="secondary" onPress={() => go('agent')} style={{ marginTop: 18, paddingHorizontal: 26 }} />
    </Reveal>}
    {active.map(cart => <CartCard key={cart.id} cart={cart} />)}
    {activity.length > 0 && <>
      <SectionHeader title="Activity" />
      <Group>{activity.map(task => <Row key={task.id} title={task.title} subtitle={task.status === 'failed' || task.kind === 'receipt' ? task.detail ?? taskStatus[task.status][1] : taskStatus[task.status][1]} left={<Dot color={taskStatus[task.status][0]} />} />)}</Group>
    </>}
    {earlier.length > 0 && <>
      <SectionHeader title="Earlier" />
      <Group>{earlier.map(cart => {
        const recipe = state!.recipes.find(r => r.id === cart.recipeId);
        const done = isReceived(state!, cart);
        return <Row key={cart.id} title={recipe?.title ?? 'Shopping list'} subtitle={done ? `Delivered${cart.receivedAt ? ` ${day(cart.receivedAt)}` : ''}, ${items(cart.items.length)} added to your kitchen` : 'Discarded'}
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
  kitchen: { marginTop: 12, paddingHorizontal: 4 },
  fine: { ...t.footnote, color: c.ink2, textAlign: 'center', marginTop: 10, paddingHorizontal: 12 },
  disclosure: { flexDirection: 'row', alignItems: 'center', minHeight: 48, marginTop: 10, paddingHorizontal: 2 },
  note: { marginTop: 16, backgroundColor: c.canvas, borderRadius: radius.group, padding: 14 },
  empty: { alignItems: 'center', marginTop: 28, backgroundColor: c.surface, borderRadius: radius.dock, paddingHorizontal: 24, paddingVertical: 32 },
});
