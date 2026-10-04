import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Check, Plus } from 'lucide-react-native';
import type { InventoryItem, Observation, Scan, Unit } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { c, quantity, radius, t, titleCase } from '../lib/theme';
import { LargeHeader } from './Header';
import { Pop, Reveal } from './motion';
import { Button, Dot, Field, Group, Row, SectionHeader, Sheet, Tag } from './ui';

const certainty = (confidence: number) => confidence >= 0.85 ? 'Clearly seen' : confidence >= 0.6 ? 'Probably' : 'Not sure';
const units: Array<{ unit: Unit; label: string }> = [{ unit: 'each', label: 'Count' }, { unit: 'g', label: 'g' }, { unit: 'kg', label: 'kg' }, { unit: 'ml', label: 'ml' }, { unit: 'l', label: 'L' }, { unit: 'cup', label: 'cups' }];
const preferenceIdeas = [
  { key: 'clothing sizes', hint: 'Shirt M, shoes 9' },
  { key: 'favorite stores', hint: 'Where you like to shop' },
  { key: 'allergies', hint: 'Anything Aeri must never buy' },
  { key: 'weekly budget', hint: 'A limit for groceries' },
  { key: 'things to avoid', hint: 'Brands or ingredients' },
];

function Review({ scan }: { scan: Scan }) {
  const { request, refresh } = useApp();
  const { toast } = useFeedback();
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const count = scan.observations.filter(o => picked[o.id]).length;
  const toggle = (item: Observation) => { haptic.tap(); setPicked(current => ({ ...current, [item.id]: !current[item.id] })); };
  const save = async () => {
    const decisions = Object.fromEntries(scan.observations.map(o => [o.id, picked[o.id] ? 'accepted' : 'rejected']));
    try {
      setSaving(true);
      await request(`/v1/scans/${scan.id}/confirm`, { method: 'POST', body: JSON.stringify({ decisions }) });
      await refresh(); haptic.success();
      toast(count ? `Added ${count} ${count === 1 ? 'item' : 'items'} to your kitchen` : 'Nothing saved from that video', count ? 'success' : 'info');
    } catch (error) { toast((error as Error).message, 'error'); }
    finally { setSaving(false); }
  };
  return <Reveal from="scale" style={styles.review}>
    <View style={styles.reviewTop}>
      <Dot size={9} />
      <Text style={[t.headline, { flex: 1 }]} accessibilityRole="header">Check what I saw</Text>
      {scan.source === 'demo' && <Tag label="Sample" tone="sample" />}
    </View>
    <Text style={[t.footnote, { marginTop: 4, marginBottom: 6 }]}>{scan.source === 'demo'
      ? 'Video understanding isn’t connected, so these are sample items, not from your video. Check only what is really in your kitchen.'
      : 'Only the items you check are remembered.'}</Text>
    {!scan.observations.length && <Text style={[t.subhead, { paddingVertical: 12 }]}>I couldn't make out any groceries in that video.</Text>}
    {scan.observations.map(item => {
      const on = !!picked[item.id];
      return <Pressable key={item.id} onPress={() => toggle(item)} style={({ pressed }) => [styles.observation, pressed && { backgroundColor: c.fill }]}
        accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`${item.name}, ${item.quantity ? quantity(item.quantity) : 'amount unclear'}, ${certainty(item.confidence)}`}>
        <Pop on={on}><View style={[styles.check, on && styles.checkOn]}>{on && <Check size={14} color={c.white} strokeWidth={3} />}</View></Pop>
        <View style={{ flex: 1 }}>
          <Text style={t.callout}>{titleCase(item.name)}</Text>
          <Text style={t.footnote}>{certainty(item.confidence)}</Text>
        </View>
        <Text style={[t.number, { fontSize: 15, color: item.quantity ? c.ink : c.ink3 }]}>{item.quantity ? quantity(item.quantity) : 'Amount unclear'}</Text>
      </Pressable>;
    })}
    <Button label={count ? `Remember ${count} ${count === 1 ? 'item' : 'items'}` : scan.observations.length ? 'None of these' : 'Dismiss'} tone={count ? 'primary' : 'secondary'} loading={saving} onPress={() => void save()} style={{ marginTop: 12 }} />
  </Reveal>;
}

function ItemSheet({ item, onClose }: { item: InventoryItem | 'new' | null; onClose: () => void }) {
  const { request, refresh } = useApp();
  const { toast } = useFeedback();
  const existing = item && item !== 'new' ? item : null;
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState<Unit>('each');
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<typeof item>(null);
  if (item !== opened) { setOpened(item); setName(existing ? titleCase(existing.name) : ''); setValue(existing ? String(existing.quantity.amount) : ''); setUnit(existing?.quantity.unit ?? 'each'); }
  const amount = Number(value.replace(',', '.'));
  const valid = name.trim().length > 0 && Number.isFinite(amount) && amount > 0;
  const save = async () => {
    try { setBusy(true); await request('/v1/inventory', { method: 'POST', body: JSON.stringify({ name: existing?.name ?? name.trim(), amount, unit }) }); await refresh(); haptic.success(); onClose(); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!existing) return;
    try { setBusy(true); await request(`/v1/inventory/${existing.id}`, { method: 'DELETE' }); await refresh(); onClose(); toast(`Removed ${existing.name}`, 'info'); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(false); }
  };
  return <Sheet visible={!!item} onClose={onClose} title={existing ? titleCase(existing.name) : 'Add to your kitchen'} message={existing ? 'Correct the amount Aeri remembers.' : 'Aeri uses this when planning what to buy.'}>
    <Group style={styles.sheetGroup}>
      {!existing && <Field label="Item" value={name} onChangeText={setName} placeholder="Eggs, rice, olive oil…" autoFocus autoCapitalize="sentences" />}
      <Field label="Amount" value={value} onChangeText={setValue} placeholder="6" keyboardType="decimal-pad" autoFocus={!!existing} />
    </Group>
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
  const scan = state?.scans.find(s => s.status === 'needs_review');
  const inventory = [...(state?.inventory ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const preferences = Object.entries(state?.preferences ?? {});
  return <>
    <ScrollView contentContainerStyle={[styles.content, { paddingBottom: bottomInset + 24 }]} showsVerticalScrollIndicator={false} automaticallyAdjustKeyboardInsets>
      <LargeHeader title="Memory" subtitle="What Aeri knows about your home." />
      {scan && <Review key={scan.id} scan={scan} />}
      <SectionHeader title="Kitchen" action="Add" actionLabel="Add a kitchen item" onAction={() => setItem('new')} />
      <Group>
        {inventory.length === 0 && <Row title="Nothing remembered yet" subtitle={'Tell Aeri “I have 6 eggs” or show it your kitchen.'} tone="muted" />}
        {inventory.map(entry => <Row key={entry.id} title={titleCase(entry.name)} subtitle={entry.confidence === 'confirmed' ? undefined : 'Not confirmed'} onPress={() => setItem(entry)}
          accessibilityLabel={`${entry.name}, ${quantity(entry.quantity)}. Edit`} right={<Text style={[t.number, { fontSize: 17 }]}>{quantity(entry.quantity)}</Text>} />)}
      </Group>
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
  review: { marginTop: 24, backgroundColor: c.surface, borderRadius: radius.dock, padding: 16, borderWidth: 1, borderColor: 'rgba(224,145,31,0.28)' },
  reviewTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  observation: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 4, borderRadius: radius.row, minHeight: 52 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: c.ink3, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: c.leaf, borderColor: c.leaf },
  sheetGroup: { marginTop: 18, backgroundColor: c.canvas },
  units: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  unit: { paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: c.canvas },
  unitOn: { backgroundColor: c.ink },
  addIcon: { width: 26, height: 26, borderRadius: 13, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
});
