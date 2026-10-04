import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Plus } from 'lucide-react-native';
import { formatTimestamp, freshness, type InventoryItem, type Unit } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { c, quantity, radius, t, titleCase } from '../lib/theme';
import { LargeHeader } from './Header';
import { MapCard } from './MapReview';
import { Button, Field, Group, Row, SectionHeader, Sheet } from './ui';

const units: Array<{ unit: Unit; label: string }> = [{ unit: 'each', label: 'Count' }, { unit: 'g', label: 'g' }, { unit: 'kg', label: 'kg' }, { unit: 'ml', label: 'ml' }, { unit: 'l', label: 'L' }, { unit: 'cup', label: 'cups' }];
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
/** Where a remembered fact came from, in plain words. */
function provenance(item: InventoryItem) {
  const ref = item.evidence[0];
  const when = day(item.lastConfirmedAt ?? item.updatedAt);
  if (!ref) return `Confirmed ${when}`;
  return { video: `Confirmed from your video${ref.atSec !== undefined ? ` at ${formatTimestamp(ref.atSec)}` : ''}, ${when}`, voice: `You said it, ${when}`, chat: `You told Aeri, ${when}`, manual: `Entered ${when}`, order: `Arrived in an order, ${when}`, photo: `From a photo, ${when}` }[ref.sourceType];
}
const preferenceIdeas = [
  { key: 'clothing sizes', hint: 'Shirt M, shoes 9' },
  { key: 'location', hint: 'ZIP code, for nearby stores' },
  { key: 'favorite stores', hint: 'Where you like to shop' },
  { key: 'allergies', hint: 'Anything Aeri must never buy' },
  { key: 'weekly budget', hint: 'A limit for groceries' },
  { key: 'things to avoid', hint: 'Brands or ingredients' },
];

function ItemSheet({ item, onClose }: { item: InventoryItem | 'new' | null; onClose: () => void }) {
  const { request, refresh } = useApp();
  const { toast } = useFeedback();
  const existing = item && item !== 'new' ? item : null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<Unit>('each');
  const [brand, setBrand] = useState('');
  const [place, setPlace] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<typeof item>(null);
  if (item !== opened) { setOpened(item); setName(existing ? titleCase(existing.name) : ''); setValue(existing ? String(existing.quantity.amount) : ''); setUnit(existing?.quantity.unit ?? 'each'); setBrand(existing?.brand ?? ''); setPlace(existing?.location ?? ''); }
  const amount = Number(value.replace(',', '.'));
  const valid = name.trim().length > 0 && Number.isFinite(amount) && amount > 0;
  const save = async () => {
    try {
      setBusy(true);
      if (existing) await request(`/v1/inventory/${existing.id}`, { method: 'PATCH', body: JSON.stringify({ amount, unit, brand: brand.trim(), location: place.trim() }) });
      else await request('/v1/inventory', { method: 'POST', body: JSON.stringify({ name: name.trim(), amount, unit, ...(place.trim() ? { place: place.trim() } : {}) }) });
      await refresh(); haptic.success(); onClose();
    }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!existing) return;
    try { setBusy(true); await request(`/v1/inventory/${existing.id}`, { method: 'DELETE' }); await refresh(); onClose(); toast(`Removed ${existing.name}`, 'info'); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return <Sheet visible={!!item} onClose={onClose} title={existing ? titleCase(existing.name) : 'Add something you have'} message={existing ? 'Correct what Aeri remembers.' : 'Aeri uses this when planning what to buy.'}>
    <Group style={styles.sheetGroup}>
      {!existing && <Field label="Item" value={name} onChangeText={setName} placeholder="Eggs, rice, olive oil…" autoFocus autoCapitalize="sentences" />}
      <Field label="Amount" value={value} onChangeText={setValue} placeholder="6" keyboardType="decimal-pad" autoFocus={!!existing} />
      {existing && <Field label="Brand" value={brand} onChangeText={setBrand} placeholder="Optional" />}
      <Field label="Where it's kept" value={place} onChangeText={setPlace} placeholder="Fridge, pantry, closet…" />
    </Group>
    {existing && <Text style={[t.footnote, { marginTop: 10, marginLeft: 4 }]}>{provenance(existing)}</Text>}
    <View style={styles.units} accessibilityRole="radiogroup" accessibilityLabel="Unit">
      {units.map(option => <Pressable key={option.unit} onPress={() => { haptic.tap(); setUnit(option.unit); }} style={[styles.unit, unit === option.unit && styles.unitOn]} accessibilityRole="radio" accessibilityState={{ selected: unit === option.unit }}>
        <Text style={[t.subhead, { color: unit === option.unit ? c.white : c.ink, fontWeight: '600' }]}>{option.label}</Text>
      </Pressable>)}
    </View>
    <Button label="Save" onPress={() => void save()} disabled={!valid} loading={busy} style={{ marginTop: 20 }} />
    {existing && <Button label="Remove from kitchen" tone="destructive" onPress={() => void remove()} style={{ marginTop: 6 }} />}
  </Sheet>;
}

function PreferenceSheet({ draft, onClose }: { draft: { key: string; value: string; fixed: boolean } | null; onClose: () => void }) {
  const { request, refresh } = useApp();
  const { toast } = useFeedback();
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<typeof draft>(null);
  if (draft !== opened) { setOpened(draft); setKey(draft?.key ?? ''); setValue(draft?.value ?? ''); }
  const editing = !!draft?.value;
  const save = async () => {
    try { setBusy(true); await request('/v1/preferences', { method: 'POST', body: JSON.stringify({ key: key.trim().toLowerCase(), value: value.trim() }) }); await refresh(); haptic.success(); onClose(); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    try { setBusy(true); await request(`/v1/preferences/${encodeURIComponent(draft!.key)}`, { method: 'DELETE' }); await refresh(); onClose(); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const note = draft?.key.startsWith('note');
  return <Sheet visible={!!draft} onClose={onClose} title={draft?.fixed ? (note ? 'Note' : titleCase(draft.key)) : 'Add a preference'} message="Aeri keeps this in mind for every kind of shopping, not just groceries.">
    <Group style={styles.sheetGroup}>
      {!draft?.fixed && <Field label="What it's about" value={key} onChangeText={setKey} placeholder="Shoe size, favorite store…" autoFocus />}
      <Field label={note ? 'Note' : 'Preference'} value={value} onChangeText={setValue} placeholder="Medium, Trader Joe's, no peanuts…" autoFocus={draft?.fixed} multiline={note} />
    </Group>
    <Button label="Save" onPress={() => void save()} disabled={!key.trim() || !value.trim()} loading={busy} style={{ marginTop: 20 }} />
    {editing && <Button label="Forget this" tone="destructive" onPress={() => void remove()} style={{ marginTop: 6 }} />}
  </Sheet>;
}

export function MemoryTab() {
  const { state } = useApp();
  const { bottomInset } = useNav();
  const [item, setItem] = useState<InventoryItem | 'new' | null>(null);
  const [preference, setPreference] = useState<{ key: string; value: string; fixed: boolean } | null>(null);
  const maps = (state?.scans ?? []).filter(s => s.status === 'needs_review' || s.status === 'processing' || s.status === 'failed').slice(0, 2);
  const now = new Date().toISOString();
  const inventory = [...(state?.inventory ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const places = [...new Set(inventory.map(i => i.location ?? ''))].sort((a, b) => (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b));
  const preferences = Object.entries(state?.preferences ?? {});
  return <>
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]} showsVerticalScrollIndicator={false} automaticallyAdjustKeyboardInsets>
      <LargeHeader title="Memory" subtitle="Only what you’ve confirmed." />
      {maps.map(scan => <MapCard key={scan.id} scan={scan} />)}
      {inventory.length === 0 && <>
        <SectionHeader title="Your home" action="Add" actionLabel="Add something you have" onAction={() => setItem('new')} />
        <Group><Row title="Nothing remembered yet" subtitle={'Record a short video of a shelf, fridge or closet, or say “I have 6 eggs”.'} tone="muted" /></Group>
      </>}
      {places.map((place, index) => <View key={place || 'elsewhere'}>
        <SectionHeader title={place || (places.length > 1 ? 'Elsewhere' : 'Your home')} action={index === 0 ? 'Add' : undefined} actionLabel="Add something you have" onAction={() => setItem('new')} />
        <Group>
          {inventory.filter(entry => (entry.location ?? '') === place).map(entry => {
            const fresh = freshness(entry, now);
            const detail = [entry.brand, entry.position, fresh.state === 'fresh' ? undefined : fresh.state === 'expired' ? `Past its date` : `Check again: ${fresh.reason}`].filter(Boolean).join(' · ');
            return <Row key={entry.id} title={titleCase(entry.name)} subtitle={detail || undefined} onPress={() => setItem(entry)}
              accessibilityLabel={`${entry.name}, ${quantity(entry.quantity)}${detail ? `, ${detail}` : ''}. Edit`}
              right={<Text style={[t.number, { fontSize: 17, color: fresh.state === 'fresh' ? c.ink : '#875810' }]}>{quantity(entry.quantity)}</Text>} />;
          })}
        </Group>
      </View>)}
      <SectionHeader title="Preferences" action={preferences.length ? 'Add' : undefined} actionLabel="Add a preference" onAction={() => setPreference({ key: '', value: '', fixed: false })} />
      <Group inset={preferences.length ? 16 : 54}>
        {preferences.map(([key, value]) => key.startsWith('note')
          ? <Row key={key} title={titleCase(value)} subtitle="Note" onPress={() => setPreference({ key, value, fixed: true })} />
          : <Row key={key} title={titleCase(key)} onPress={() => setPreference({ key, value, fixed: true })} right={<Text style={[t.callout, { color: c.ink2, maxWidth: 170, textAlign: 'right' }]} numberOfLines={2}>{value}</Text>} />)}
        {!preferences.length && preferenceIdeas.map(idea => <Row key={idea.key} title={titleCase(idea.key)} subtitle={idea.hint} tone="muted" onPress={() => setPreference({ key: idea.key, value: '', fixed: true })}
          left={<View style={styles.addIcon}><Plus size={15} color={c.accent} strokeWidth={2.4} /></View>} accessibilityLabel={`Add ${idea.key}`} />)}
      </Group>
    </ScrollView>
    <ItemSheet item={item} onClose={() => setItem(null)} />
    <PreferenceSheet draft={preference} onClose={() => setPreference(null)} />
  </>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20 },
  sheetGroup: { marginTop: 18, backgroundColor: c.canvas },
  units: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  unit: { paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: c.canvas },
  unitOn: { backgroundColor: c.ink },
  addIcon: { width: 26, height: 26, borderRadius: 13, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
});
