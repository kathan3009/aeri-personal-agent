import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, Plus, ScanLine } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { c } from '../lib/theme';
import type { Observation } from '@personal-agent/core';

const pretty = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(1);

export function MemoryTab() {
  const { state, request, refresh, providers } = useApp();
  const [decisions, setDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState(''); const [amount, setAmount] = useState('1');
  const [saving, setSaving] = useState(false);
  const scan = state?.scans.find(s => s.status === 'needs_review');
  const choose = (item: Observation, decision: 'accepted' | 'rejected') => setDecisions(current => ({ ...current, [item.id]: decision }));
  const confirm = async () => {
    if (!scan) return;
    const all = Object.fromEntries(scan.observations.map(o => [o.id, decisions[o.id] ?? 'rejected']));
    try { setSaving(true); await request(`/v1/scans/${scan.id}/confirm`, { method: 'POST', body: JSON.stringify({ decisions: all }) }); await refresh(); setDecisions({}); }
    catch (error) { Alert.alert('Could not save scan', (error as Error).message); }
    finally { setSaving(false); }
  };
  const add = async () => {
    const n = Number(amount);
    if (!name.trim() || !Number.isFinite(n) || n <= 0) { Alert.alert('Add an item name and quantity'); return; }
    try { setSaving(true); await request('/v1/inventory', { method: 'POST', body: JSON.stringify({ name: name.trim(), amount: n, unit: 'each' }) }); await refresh(); setName(''); setAmount('1'); setAdding(false); }
    catch (error) { Alert.alert('Could not add item', (error as Error).message); }
    finally { setSaving(false); }
  };
  return <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <Text style={styles.eyebrow}>YOUR WORLD</Text>
    <Text style={styles.title}>What Aeri knows</Text>
    <Text style={styles.subtitle}>Your memory grows with every conversation and confirmation.</Text>
    {scan && <View style={styles.scanCard}>
      <View style={styles.scanHeading}><View style={styles.scanIcon}><ScanLine size={20} color={c.blue} /></View><View style={{ flex: 1 }}><Text style={styles.sectionTitle}>Review your kitchen scan</Text><Text style={styles.caption}>{scan.source === 'demo' ? 'Sample items · check against your actual kitchen' : 'Only confirmed items become memory'}</Text></View></View>
      {scan.observations.map(item => <View key={item.id} style={styles.observation}>
        <View style={{ flex: 1 }}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.caption}>{item.quantity ? `${pretty(item.quantity.amount)} ${item.quantity.unit}` : 'Quantity uncertain'} · {Math.round(item.confidence * 100)}% confidence</Text></View>
        <Pressable onPress={() => choose(item, 'rejected')} style={[styles.choice, decisions[item.id] === 'rejected' && styles.reject]}><Text style={styles.choiceText}>No</Text></Pressable>
        <Pressable onPress={() => choose(item, 'accepted')} style={[styles.choice, decisions[item.id] === 'accepted' && styles.accept]}><Text style={styles.choiceText}>Yes</Text></Pressable>
      </View>)}
      <Pressable onPress={() => void confirm()} disabled={saving} style={styles.primary}><Check size={17} color={c.white} /><Text style={styles.primaryText}>Save confirmed items</Text></Pressable>
    </View>}
    <View style={styles.sectionHeader}><Text style={styles.sectionTitle}>Kitchen inventory</Text><Pressable onPress={() => setAdding(!adding)} style={styles.plus}><Plus size={19} color={c.deep} /></Pressable></View>
    {adding && <View style={styles.addCard}><TextInput value={name} onChangeText={setName} placeholder="Item name" placeholderTextColor="#9AACB7" style={styles.input} /><TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Quantity" placeholderTextColor="#9AACB7" style={styles.input} /><Pressable onPress={() => void add()} disabled={saving} style={styles.primary}><Text style={styles.primaryText}>Add to memory</Text></Pressable></View>}
    <View style={styles.whiteCard}>
      {!state?.inventory.length && <Text style={styles.empty}>Nothing here yet. Tell Aeri “I have 3 eggs” or scan your kitchen.</Text>}
      {state?.inventory.map((item, index) => <View key={item.id} style={[styles.listRow, index > 0 && styles.divider]}><View style={styles.dot} /><View style={{ flex: 1 }}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.caption}>{item.confidence === 'confirmed' ? 'Confirmed' : 'Estimated'}</Text></View><Text style={styles.qty}>{pretty(item.quantity.amount)} {item.quantity.unit}</Text></View>)}
    </View>
    <Text style={[styles.sectionTitle, { marginTop: 28, marginBottom: 12 }]}>Preferences</Text>
    <View style={styles.whiteCard}>
      {Object.entries(state?.preferences ?? {}).length === 0 && <Text style={styles.empty}>Tell Aeri your sizes, favorite stores, allergies or things to avoid.</Text>}
      {Object.entries(state?.preferences ?? {}).map(([key, value], index) => <View key={key} style={[styles.listRow, index > 0 && styles.divider]}><View style={{ flex: 1 }}><Text style={styles.itemName}>{key}</Text><Text style={styles.caption}>{value}</Text></View></View>)}
    </View>
    <Text style={styles.footer}>{providers?.gemini ? 'Video understanding is connected' : 'Video scan uses sample observations until Gemini is connected'}</Text>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 42 },
  eyebrow: { color: c.blue, fontSize: 10, fontWeight: '800', letterSpacing: 1.8, marginBottom: 10 },
  title: { fontSize: 30, letterSpacing: -.8, fontWeight: '600', color: c.deep },
  subtitle: { color: c.muted, fontSize: 14, lineHeight: 21, marginTop: 8, marginBottom: 27, maxWidth: 300 },
  scanCard: { backgroundColor: '#E4F4FA', borderRadius: 25, padding: 17, marginBottom: 30, borderWidth: 1, borderColor: '#CFEAF4' },
  scanHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 14 },
  scanIcon: { width: 44, height: 44, borderRadius: 15, backgroundColor: c.white, justifyContent: 'center', alignItems: 'center' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: '600', color: c.deep, letterSpacing: -.2 },
  caption: { fontSize: 12, color: c.muted, marginTop: 3 },
  observation: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,.75)', borderRadius: 15, padding: 13, marginTop: 7 },
  itemName: { fontSize: 14, color: c.deep, fontWeight: '600' },
  choice: { paddingHorizontal: 11, paddingVertical: 9, backgroundColor: '#F1F6F8', borderRadius: 10 },
  choiceText: { fontSize: 12, color: c.deep, fontWeight: '600' }, reject: { backgroundColor: '#F9DFDE' }, accept: { backgroundColor: c.mint },
  primary: { backgroundColor: c.blue, borderRadius: 14, paddingVertical: 14, marginTop: 14, justifyContent: 'center', alignItems: 'center', flexDirection: 'row', gap: 8 },
  primaryText: { color: c.white, fontSize: 14, fontWeight: '700' },
  plus: { width: 36, height: 36, backgroundColor: '#FFFFFF', borderRadius: 12, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: c.line },
  whiteCard: { backgroundColor: 'rgba(255,255,255,.88)', borderRadius: 22, borderWidth: 1, borderColor: '#E4EFF4', paddingHorizontal: 17, paddingVertical: 5 },
  empty: { color: c.muted, fontSize: 14, lineHeight: 21, paddingVertical: 21 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 15 }, divider: { borderTopWidth: 1, borderTopColor: '#EEF3F6' },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#8BD5C9' }, qty: { color: c.deep, fontSize: 13, fontWeight: '600' },
  addCard: { backgroundColor: '#FFFFFF', borderRadius: 18, padding: 14, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: c.line, borderRadius: 12, padding: 12, marginBottom: 8, color: c.deep },
  footer: { textAlign: 'center', color: '#9BB0BB', fontSize: 11, marginTop: 24 },
});
