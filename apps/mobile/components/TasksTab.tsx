import { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ArrowUpRight, Check, Clock3, PackageCheck, X } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { c } from '../lib/theme';
import type { Cart } from '@personal-agent/core';

function statusLabel(status: Cart['status']) {
  return ({ draft: 'Needs your review', approved: 'Approved', checkout_ready: 'Checkout ready', ordered: 'Ordered', cancelled: 'Cancelled' })[status];
}

export function TasksTab() {
  const { state, request, refresh, providers } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, Array<{ itemId: string; results: Array<{ title: string; url: string }> }>>>({});
  const act = async (cartId: string, path: string, body?: unknown) => {
    try { setBusy(cartId); const result = await request<{ url?: string; note?: string }>(`/v1/carts/${cartId}/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined }); await refresh();
      if (result.url) { Alert.alert('Checkout is ready', result.note ?? 'Open the retailer to complete your order.', [{ text: 'Open', onPress: () => void Linking.openURL(result.url!) }, { text: 'Later' }]); }
    } catch (error) { Alert.alert('Could not complete action', (error as Error).message); }
    finally { setBusy(null); }
  };
  const remove = async (cartId: string, itemId: string) => {
    try { setBusy(cartId); await request(`/v1/carts/${cartId}/items/${itemId}`, { method: 'DELETE' }); await refresh(); }
    catch (error) { Alert.alert('Could not remove item', (error as Error).message); }
    finally { setBusy(null); }
  };
  const research = async (cartId: string) => {
    try { setBusy(cartId); const result = await request<Array<{ itemId: string; results: Array<{ title: string; url: string }> }>>(`/v1/carts/${cartId}/research`, { method: 'POST' }); setSuggestions(current => ({ ...current, [cartId]: result })); }
    catch (error) { Alert.alert('Research unavailable', (error as Error).message); }
    finally { setBusy(null); }
  };
  return <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <Text style={styles.eyebrow}>IN MOTION</Text><Text style={styles.title}>Your tasks</Text>
    <Text style={styles.subtitle}>Plans stay here until you're ready for the next step.</Text>
    {!state?.carts.length && <View style={styles.empty}><Clock3 size={28} color={c.blue} strokeWidth={1.5} /><Text style={styles.emptyTitle}>Nothing to review yet</Text><Text style={styles.emptyBody}>Paste a YouTube recipe link in Agent to make your first shopping cart.</Text></View>}
    {state?.carts.map(cart => {
      const recipe = state.recipes.find(r => r.id === cart.recipeId);
      const received = state.events.some(e => e.type === 'order.received' && (e.data as { cartId?: string }).cartId === cart.id);
      const open = expanded === cart.id;
      return <View key={cart.id} style={styles.card}>
        <View style={styles.cardTop}><View style={styles.statusDot} /><Text style={styles.status}>{received ? 'Delivered · memory updated' : statusLabel(cart.status)}</Text><Text style={styles.date}>{new Date(cart.createdAt).toLocaleDateString()}</Text></View>
        <Text style={styles.recipeTitle}>{recipe?.title ?? 'Shopping plan'}</Text>
        <Text style={styles.recipeMeta}>{recipe?.servings ?? 2} servings · {cart.items.length} items needed</Text>
        {recipe?.sourceUrl && <Pressable onPress={() => void Linking.openURL(recipe.sourceUrl!)}><Text style={[styles.link, { paddingBottom: 0 }]}>Source video ↗</Text></Pressable>}
        <Pressable onPress={() => setExpanded(open ? null : cart.id)} style={styles.itemToggle}><Text style={styles.itemToggleText}>{open ? 'Hide items' : 'Review items'}</Text><ArrowUpRight size={15} color={c.blue} /></Pressable>
        {open && <View style={styles.items}>
          {cart.status === 'draft' && recipe && <View style={styles.servingsRow}><Text style={styles.itemName}>Servings</Text><View style={styles.stepper}><Pressable onPress={() => void act(cart.id, 'servings', { servings: Math.max(1, recipe.servings - 1) })} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><Text style={styles.stepCount}>{recipe.servings}</Text><Pressable onPress={() => void act(cart.id, 'servings', { servings: Math.min(24, recipe.servings + 1) })} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable></View></View>}
          {cart.items.length === 0 && <Text style={styles.emptyItems}>Everything is already in your kitchen.</Text>}{cart.items.map(item => <View key={item.id} style={styles.itemRow}><View style={{ flex: 1 }}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.itemQuantity}>{item.quantity.amount} {item.quantity.unit}</Text></View>{cart.status === 'draft' && <Pressable onPress={() => void remove(cart.id, item.id)} style={styles.remove} accessibilityLabel={`Remove ${item.name}`}><X size={17} color={c.muted} /></Pressable>}</View>)}
          {providers?.exa && cart.items.length > 0 && !suggestions[cart.id] && <Pressable onPress={() => void research(cart.id)}><Text style={styles.link}>Find product links with Exa ↗</Text></Pressable>}
          {suggestions[cart.id]?.flatMap(entry => entry.results.slice(0, 1).map(result => ({ ...result, itemId: entry.itemId }))).map(result => <Pressable key={result.itemId} onPress={() => void Linking.openURL(result.url)}><Text style={styles.suggestion}>{result.title} ↗</Text></Pressable>)}
        </View>}
        {cart.status === 'draft' && <Pressable disabled={busy === cart.id} onPress={() => void act(cart.id, 'approve')} style={styles.primary}><Check size={17} color={c.white} /><Text style={styles.primaryText}>Approve this cart</Text></Pressable>}
        {cart.status === 'approved' && <Pressable disabled={busy === cart.id} onPress={() => void act(cart.id, 'checkout')} style={styles.primary}><ArrowUpRight size={18} color={c.white} /><Text style={styles.primaryText}>Open checkout</Text></Pressable>}
        {cart.status === 'checkout_ready' && <View style={{ marginTop: 16 }}>
          <Text style={styles.helper}>Complete checkout at the retailer, then save the order reference.</Text>
          {cart.checkoutUrl && <Pressable onPress={() => void Linking.openURL(cart.checkoutUrl!)}><Text style={styles.link}>Open retailer ↗</Text></Pressable>}
          <TextInput value={reference} onChangeText={setReference} placeholder="Order reference" placeholderTextColor="#A0B1BB" style={styles.input} />
          <Pressable disabled={!reference.trim() || busy === cart.id} onPress={() => void act(cart.id, 'ordered', { reference: reference.trim() })} style={[styles.primary, !reference.trim() && { opacity: .55 }]}><Text style={styles.primaryText}>Mark as ordered</Text></Pressable>
        </View>}
        {cart.status === 'ordered' && !received && <Pressable disabled={busy === cart.id} onPress={() => void act(cart.id, 'received')} style={styles.primary}><PackageCheck size={18} color={c.white} /><Text style={styles.primaryText}>I received this order</Text></Pressable>}
        {recipe?.source === 'demo' && <Text style={styles.demoNote}>Demo recipe — add Gemini key for this video's actual ingredients.</Text>}
      </View>;
    })}
    {!!state?.tasks.length && <><Text style={styles.sectionTitle}>Activity</Text><View style={styles.activityCard}>{state.tasks.slice(0, 8).map((task, index) => <View key={task.id} style={[styles.activityRow, index > 0 && styles.divider]}><View style={[styles.activityDot, task.status === 'failed' && { backgroundColor: c.danger }]} /><View style={{ flex: 1 }}><Text style={styles.activityTitle}>{task.title}</Text><Text style={styles.activityMeta}>{task.detail ?? task.status.replace('_', ' ')}</Text></View></View>)}</View></>}
    <Text style={styles.footer}>{providers?.kernel ? 'Kernel browser available' : 'Connect Kernel to open a hosted retailer browser'}</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 46 },
  eyebrow: { color: c.blue, fontSize: 10, fontWeight: '800', letterSpacing: 1.8, marginBottom: 10 },
  title: { fontSize: 30, letterSpacing: -.8, fontWeight: '600', color: c.deep },
  subtitle: { color: c.muted, fontSize: 14, lineHeight: 21, marginTop: 8, marginBottom: 26 },
  empty: { alignItems: 'center', backgroundColor: '#E7F5FA', borderRadius: 25, paddingHorizontal: 35, paddingVertical: 45 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: c.deep, marginTop: 18 }, emptyBody: { textAlign: 'center', color: c.muted, fontSize: 13, lineHeight: 20, marginTop: 8 },
  card: { backgroundColor: 'rgba(255,255,255,.94)', borderWidth: 1, borderColor: '#E2EDF3', borderRadius: 23, padding: 19, marginBottom: 15 },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 7 }, statusDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#75CABA' },
  status: { fontSize: 11, fontWeight: '700', color: '#409E9A' }, date: { marginLeft: 'auto', color: '#9CAFB9', fontSize: 11 },
  recipeTitle: { color: c.deep, fontSize: 21, fontWeight: '600', letterSpacing: -.3, marginTop: 17 }, recipeMeta: { color: c.muted, fontSize: 12, marginTop: 5 },
  itemToggle: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 17 }, itemToggleText: { fontSize: 13, color: c.blue, fontWeight: '700' },
  items: { borderTopWidth: 1, borderTopColor: '#EDF3F6', marginTop: 15 }, itemRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F4F6' },
  servingsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#F0F4F6' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 14 }, stepButton: { width: 29, height: 29, borderRadius: 10, backgroundColor: '#EDF7FB', alignItems: 'center', justifyContent: 'center' }, stepText: { color: c.blue, fontWeight: '700', fontSize: 18 }, stepCount: { color: c.deep, fontWeight: '700', fontSize: 14 },
  itemName: { color: c.deep, fontSize: 14, fontWeight: '600' }, itemQuantity: { color: c.muted, fontSize: 12, marginTop: 3 }, remove: { padding: 6 }, emptyItems: { color: c.muted, fontSize: 13, paddingVertical: 13 },
  primary: { backgroundColor: c.blue, borderRadius: 14, minHeight: 47, marginTop: 18, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 }, primaryText: { color: c.white, fontSize: 14, fontWeight: '700' },
  helper: { color: c.muted, fontSize: 12, lineHeight: 19 }, link: { color: c.blue, fontSize: 13, fontWeight: '700', paddingVertical: 10 },
  suggestion: { color: c.muted, fontSize: 12, lineHeight: 18, paddingVertical: 4 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 13, padding: 12, color: c.deep, marginTop: 8 },
  demoNote: { color: '#9CAFB9', fontSize: 10, lineHeight: 15, marginTop: 14 }, sectionTitle: { color: c.deep, fontSize: 18, fontWeight: '600', marginTop: 20, marginBottom: 12 },
  activityCard: { backgroundColor: '#FFFFFF', borderRadius: 20, paddingHorizontal: 15 }, activityRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 }, divider: { borderTopWidth: 1, borderTopColor: '#EEF3F6' }, activityDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.blue }, activityTitle: { color: c.deep, fontSize: 13, fontWeight: '600' }, activityMeta: { color: c.muted, fontSize: 11, marginTop: 3 },
  footer: { color: '#9CAFB9', textAlign: 'center', fontSize: 11, marginTop: 23 },
});
