import { useMemo, useState } from 'react';
import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, CircleAlert, Eye, Package, Shirt, X } from 'lucide-react-native';
import { formatTimestamp, isClearSighting, type Correction, type Observation, type Place, type Scan, type Unit } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { c, quantity, radius, t, titleCase } from '../lib/theme';
import { Pop, Reveal, Shimmer } from './motion';
import { Aura, Button, Dot, Field, Group, Sheet, Tag } from './ui';

type Edit = Omit<Correction, 'decision'>;
const evidenceLabel: Record<Observation['evidence'], string> = { label: 'Read on the label', visual: 'Seen', spoken: 'You said it', inferred: 'A guess' };
const units: Array<{ unit: Unit; label: string }> = [{ unit: 'each', label: 'Count' }, { unit: 'g', label: 'g' }, { unit: 'kg', label: 'kg' }, { unit: 'ml', label: 'ml' }, { unit: 'l', label: 'L' }, { unit: 'oz', label: 'oz' }, { unit: 'lb', label: 'lb' }];
const sourceLabel = (scan: Scan) => {
  const kind = { recorded: 'Recorded in Aeri', library: 'From your library', file: 'From Files', youtube: 'YouTube video', link: 'Video link' }[scan.video?.kind ?? 'library'];
  return scan.video?.durationSec ? `${kind}, ${formatTimestamp(scan.video.durationSec)}` : kind;
};
function changeLabel(o: Observation): { text: string; tone: 'leaf' | 'neutral' | 'attention' } | null {
  const change = o.change;
  if (!change) return null;
  if (change.kind === 'new') return { text: 'New', tone: 'leaf' };
  if (change.kind === 'same') return { text: 'Same as remembered', tone: 'neutral' };
  return { text: change.previous ? `Remembered ${quantity(change.previous)}` : 'Changed', tone: 'attention' };
}
const placeIcon = (place?: Place) => place?.kind === 'closet' || place?.kind === 'drawer' ? Shirt : Package;

/** Summary card in Memory: progress while Aeri watches, then one clear action to review. */
export function MapCard({ scan }: { scan: Scan }) {
  const { request, refresh } = useApp();
  const [open, setOpen] = useState(false);
  const closer = scan.unclear.length + scan.observations.filter(o => o.closeUp).length;
  if (scan.status === 'processing') return <Reveal from="scale" style={styles.card}>
    <View style={styles.cardTop}><Aura size={26} mode="thinking" /><Shimmer style={[t.headline, { flex: 1 }]}>Mapping your video…</Shimmer></View>
    <Text style={[t.footnote, { marginTop: 6 }]}>I’m listing each place and what’s visible in it, with the moment I saw it. Nothing is saved until you confirm.</Text>
  </Reveal>;
  if (scan.status === 'failed') return <Reveal from="scale" style={[styles.card, { borderColor: 'rgba(180,71,63,0.25)' }]}>
    <View style={styles.cardTop}><CircleAlert size={18} color={c.ember} strokeWidth={2} /><Text style={[t.headline, { flex: 1 }]}>I couldn’t map that video</Text></View>
    <Text style={[t.footnote, { marginTop: 6 }]}>{scan.error}</Text>
    <Button label="Dismiss" tone="plain" onPress={() => void request(`/v1/scans/${scan.id}/dismiss`, { method: 'POST' }).catch(() => undefined).finally(() => void refresh())} style={{ alignSelf: 'flex-start' }} />
  </Reveal>;
  return <>
    <Reveal from="scale" style={styles.card}>
      <View style={styles.cardTop}>
        <Dot size={9} />
        <Text style={[t.headline, { flex: 1 }]} accessibilityRole="header">Check what I saw</Text>
        {scan.source === 'demo' && <Tag label="Sample" tone="sample" />}
      </View>
      <Text style={[t.subhead, { marginTop: 6, color: c.ink }]}>{scan.places.map(p => p.name).join(' · ') || 'Your video'}</Text>
      <Text style={[t.footnote, { marginTop: 2 }]}>{scan.observations.length} {scan.observations.length === 1 ? 'thing' : 'things'}{closer ? `, ${closer} need a closer look` : ''}{scan.unseen.length ? `, ${scan.unseen.length} not seen this time` : ''}</Text>
      <Button label="Review" onPress={() => setOpen(true)} style={{ marginTop: 14 }} />
    </Reveal>
    <MapReview scan={scan} visible={open} onClose={() => setOpen(false)} />
  </>;
}

export function MapReview({ scan, visible, onClose }: { scan: Scan; visible: boolean; onClose: () => void }) {
  const { request, refresh, frame } = useApp();
  const { toast } = useFeedback();
  const insets = useSafeAreaInsets();
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(scan.observations.filter(o => o.decision === 'accepted').map(o => [o.id, true])));
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [unseen, setUnseen] = useState<Record<string, 'gone' | 'keep'>>({});
  const [editing, setEditing] = useState<Observation | null>(null);
  const [saving, setSaving] = useState(false);
  const count = scan.observations.filter(o => picked[o.id]).length;
  const groups = useMemo(() => {
    const byPlace = scan.places.map(place => ({ place, items: scan.observations.filter(o => o.placeId === place.id) }));
    const loose = scan.observations.filter(o => !o.placeId || !scan.places.some(p => p.id === o.placeId));
    return [...byPlace, ...(loose.length ? [{ place: undefined, items: loose }] : [])].filter(g => g.items.length || scan.unclear.some(u => u.placeId === g.place?.id));
  }, [scan]);
  const needsCount = (o: Observation) => !o.countCertain && edits[o.id]?.amount === undefined;
  const toggle = (o: Observation) => {
    haptic.tap();
    if (!picked[o.id] && needsCount(o)) { setEditing(o); return; }
    setPicked(current => ({ ...current, [o.id]: !current[o.id] }));
  };
  const selectClear = () => { haptic.tap(); setPicked(current => ({ ...current, ...Object.fromEntries(scan.observations.filter(isClearSighting).map(o => [o.id, true])) })); };
  const save = async () => {
    const decisions = Object.fromEntries(scan.observations.map(o => [o.id, picked[o.id] ? { decision: 'accepted', ...edits[o.id] } : 'rejected']));
    try {
      setSaving(true);
      await request(`/v1/scans/${scan.id}/confirm`, { method: 'POST', body: JSON.stringify({ decisions, unseen }) });
      await refresh(); haptic.success(); onClose();
      const gone = Object.values(unseen).filter(v => v === 'gone').length;
      toast(count ? `Remembered ${count} ${count === 1 ? 'thing' : 'things'}${gone ? `, removed ${gone}` : ''}` : 'Nothing saved from that video', count ? 'success' : 'info');
    } catch (error) { haptic.warning(); toast((error as Error).message, 'error'); }
    finally { setSaving(false); }
  };
  const clearCount = scan.observations.filter(o => isClearSighting(o) && !picked[o.id]).length;
  const hasFrames = scan.observations.some(o => o.sightings.some(s => s.frame));
  return <Modal visible={visible} animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} onRequestClose={onClose}>
    <View style={[styles.modal, { paddingTop: Platform.OS === 'ios' ? 8 : insets.top }]}>
      <View style={styles.modalHeader}>
        <View style={{ flex: 1 }}>
          <Text style={t.title2} accessibilityRole="header">Check what I saw</Text>
          <Text style={[t.footnote, { marginTop: 2 }]}>{sourceLabel(scan)}{scan.source === 'gemini' ? ' · read by Gemini' : scan.source === 'gateway' ? ' · read through Neon AI Gateway' : ''}</Text>
        </View>
        <Pressable onPress={onClose} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Close"><X size={18} color={c.ink2} strokeWidth={2.2} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 140 }} showsVerticalScrollIndicator={false}>
        {scan.source === 'demo' && <View style={styles.sample}><Tag label="Sample" tone="sample" /><Text style={[t.footnote, { color: '#6B4A12', flex: 1 }]}>Video understanding isn’t connected, so this is a sample map, not your video. Check only what is really in your home.</Text></View>}
        <Text style={[t.subhead, { marginTop: 10 }]}>Check what’s right. Tap any item to fix its name, count, brand or place. Only what you check is remembered.</Text>
        {groups.map(({ place, items }) => {
          const Icon = placeIcon(place);
          const unclear = scan.unclear.filter(u => u.placeId === place?.id);
          return <View key={place?.id ?? 'other'} style={{ marginTop: 22 }}>
            <View style={styles.placeHeader}>
              <View style={styles.placeIcon}><Icon size={16} color={c.accent} strokeWidth={2} /></View>
              <Text style={[t.headline, { flex: 1 }]}>{place?.name ?? 'Elsewhere'}</Text>
              {place?.startSec !== undefined && <Text style={[t.number, t.footnote]}>{formatTimestamp(place.startSec)}{place.endSec !== undefined ? `–${formatTimestamp(place.endSec)}` : ''}</Text>}
            </View>
            <Group inset={84}>
              {items.map(o => {
                const on = !!picked[o.id];
                const edit = edits[o.id];
                const shown = { name: edit?.name ?? o.name, brand: edit?.brand ?? o.brand, amount: edit?.amount ?? o.quantity?.amount, unit: edit?.unit ?? o.quantity?.unit ?? 'each' };
                const shot = o.sightings[0]?.frame ? frame(scan.id, o.sightings[0].frame) : null;
                const change = changeLabel(o);
                const qty = shown.amount ? quantity({ amount: shown.amount, unit: shown.unit }) : null;
                return <View key={o.id} style={styles.item}>
                  <Pressable onPress={() => toggle(o)} hitSlop={8} style={[styles.checkHit, hasFrames && { paddingTop: 14 }]} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={`Remember ${shown.name}`}>
                    <Pop on={on}><View style={[styles.check, on && styles.checkOn]}>{on && <Check size={14} color={c.white} strokeWidth={3} />}</View></Pop>
                  </Pressable>
                  <Pressable onPress={() => { haptic.tap(); setEditing(o); }} style={({ pressed }) => [styles.itemBody, pressed && { opacity: 0.7 }]} accessibilityRole="button"
                    accessibilityLabel={`${shown.name}${shown.brand ? `, ${shown.brand}` : ''}, ${qty ?? 'count unclear'}, ${evidenceLabel[o.evidence]} at ${formatTimestamp(o.sightings[0]?.startSec ?? 0)}. Edit`}>
                    {shot ? <Image source={shot} style={styles.thumb} accessibilityIgnoresInvertColors /> : hasFrames && <View style={[styles.thumb, styles.thumbEmpty]}><Eye size={18} color={c.ink3} strokeWidth={1.8} /></View>}
                    <View style={{ flex: 1 }}>
                      <View style={styles.itemTop}>
                        <Text style={[t.callout, { flex: 1, fontWeight: '600' }]} numberOfLines={2}>{titleCase(shown.name)}</Text>
                        <Text style={[t.number, { fontSize: 15, color: qty && !needsCount(o) ? c.ink : '#875810' }]}>{needsCount(o) ? (qty ? `${qty}?` : 'How many?') : qty}</Text>
                      </View>
                      {!!(shown.brand || o.variant || o.size) && <Text style={t.footnote} numberOfLines={1}>{[shown.brand, o.variant, o.size].filter(Boolean).join(' · ')}</Text>}
                      <Text style={[t.caption, { marginTop: 3 }]} numberOfLines={1}>
                        <Text style={t.number}>{o.sightings.map(s => formatTimestamp(s.startSec)).slice(0, 3).join(', ')}</Text>
                        {`  ·  `}<Text style={{ color: o.evidence === 'inferred' ? '#875810' : c.ink3 }}>{evidenceLabel[o.evidence]}</Text>
                        {change ? `  ·  ${change.text}` : ''}
                      </Text>
                      {!!o.closeUp && !edit?.amount && <Text style={styles.closeUp}>{o.closeUp}</Text>}
                    </View>
                  </Pressable>
                </View>;
              })}
            </Group>
            {unclear.map(u => <View key={u.id} style={styles.unclear}>
              {u.frame && frame(scan.id, u.frame) ? <Image source={frame(scan.id, u.frame)!} style={styles.thumbSmall} /> : <CircleAlert size={18} color={c.sunrise} strokeWidth={2} />}
              <View style={{ flex: 1 }}>
                <Text style={[t.subhead, { color: c.ink }]}>Couldn’t make out {u.description}{u.atSec !== undefined ? ` (${formatTimestamp(u.atSec)})` : ''}</Text>
                <Text style={[t.footnote, { color: '#875810', marginTop: 2 }]}>{u.ask}</Text>
              </View>
            </View>)}
          </View>;
        })}
        {scan.unseen.length > 0 && <View style={{ marginTop: 26 }}>
          <Text style={[t.headline, { marginBottom: 4 }]}>Not seen this time</Text>
          <Text style={[t.footnote, { marginBottom: 10 }]}>These were in memory for a place this video covered. Leave them as they are, or tell me.</Text>
          <Group>
            {scan.unseen.map(u => <View key={u.inventoryId} style={styles.unseen}>
              <View style={{ flex: 1 }}>
                <Text style={t.callout}>{titleCase(u.name)}</Text>
                <Text style={t.footnote}>Remembered {quantity(u.previous)}</Text>
              </View>
              {(['keep', 'gone'] as const).map(answer => <Pressable key={answer} onPress={() => { haptic.tap(); setUnseen(current => { const next = { ...current }; if (next[u.inventoryId] === answer) delete next[u.inventoryId]; else next[u.inventoryId] = answer; return next; }); }}
                style={[styles.pill, unseen[u.inventoryId] === answer && styles.pillOn]} accessibilityRole="radio" accessibilityState={{ selected: unseen[u.inventoryId] === answer }} accessibilityLabel={`${u.name}: ${answer === 'keep' ? 'still there' : 'gone'}`}>
                <Text style={[t.subhead, { color: unseen[u.inventoryId] === answer ? c.white : c.ink, fontWeight: '600' }]}>{answer === 'keep' ? 'Still there' : 'Gone'}</Text>
              </Pressable>)}
            </View>)}
          </Group>
        </View>}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 14) + 4 }]}>
        {clearCount > 0 && <Pressable onPress={selectClear} hitSlop={8} accessibilityRole="button" style={{ alignSelf: 'center', paddingVertical: 6, marginBottom: 6 }}>
          <Text style={[t.subhead, { color: c.accent, fontWeight: '600' }]}>Check the {clearCount} clearly seen</Text>
        </Pressable>}
        <Button label={count ? `Remember ${count} ${count === 1 ? 'thing' : 'things'}` : Object.keys(unseen).length ? 'Save changes' : 'Skip this video'} tone={count || Object.keys(unseen).length ? 'primary' : 'secondary'} loading={saving} onPress={() => void save()} />
      </View>
    </View>
    <EditSighting scan={scan} observation={editing} edit={editing ? edits[editing.id] : undefined} onClose={() => setEditing(null)}
      onSave={(o, edit) => { setEdits(current => ({ ...current, [o.id]: edit })); setPicked(current => ({ ...current, [o.id]: true })); setEditing(null); haptic.success(); }} />
  </Modal>;
}

function EditSighting({ scan, observation, edit, onClose, onSave }: { scan: Scan; observation: Observation | null; edit?: Edit; onClose: () => void; onSave: (o: Observation, edit: Edit) => void }) {
  const [opened, setOpened] = useState<Observation | null>(null);
  const [name, setName] = useState(''); const [amount, setAmount] = useState(''); const [unit, setUnit] = useState<Unit>('each');
  const [brand, setBrand] = useState(''); const [place, setPlace] = useState(''); const [expires, setExpires] = useState('');
  if (observation !== opened) {
    setOpened(observation);
    if (observation) {
      setName(edit?.name ?? observation.name); setAmount(String(edit?.amount ?? (observation.countCertain ? observation.quantity?.amount ?? '' : '')));
      setUnit(edit?.unit ?? observation.quantity?.unit ?? 'each'); setBrand(edit?.brand ?? observation.brand ?? '');
      setPlace(edit?.place ?? scan.places.find(p => p.id === observation.placeId)?.name ?? ''); setExpires(edit?.expiresOn ?? '');
    }
  }
  if (!observation) return <Sheet visible={false} onClose={onClose} />;
  const value = Number(amount.replace(',', '.'));
  const valid = name.trim().length > 0 && Number.isFinite(value) && value > 0 && (!expires || /^\d{4}-\d{2}-\d{2}$/.test(expires));
  const original = scan.places.find(p => p.id === observation.placeId)?.name ?? '';
  const save = () => onSave(observation, {
    ...(name.trim() !== observation.name ? { name: name.trim() } : {}),
    ...(value !== observation.quantity?.amount || !observation.countCertain ? { amount: value } : {}),
    ...(unit !== (observation.quantity?.unit ?? 'each') ? { unit } : {}),
    ...(brand.trim() !== (observation.brand ?? '') ? { brand: brand.trim() } : {}),
    ...(place.trim() && place.trim() !== original ? { place: place.trim() } : {}),
    ...(expires ? { expiresOn: expires } : {}),
  });
  return <Sheet visible onClose={onClose} title={observation.countCertain ? 'Correct this' : `How many ${observation.name.toLowerCase()}?`}
    message={observation.closeUp ?? (observation.evidence === 'inferred' ? 'This was a guess. Fix anything that isn’t right.' : observation.evidenceNote)}>
    <ScrollView style={{ maxHeight: 460 }} keyboardShouldPersistTaps="handled">
      <Group style={styles.sheetGroup}>
        <Field label="Item" value={name} onChangeText={setName} autoCapitalize="sentences" />
        <Field label={unit === 'each' ? 'How many' : 'Amount'} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="Count what you see" autoFocus={!observation.countCertain} />
      </Group>
      <View style={styles.chips} accessibilityRole="radiogroup" accessibilityLabel="Unit">
        {units.map(option => <Pressable key={option.unit} onPress={() => { haptic.tap(); setUnit(option.unit); }} style={[styles.pill, unit === option.unit && styles.pillOn]} accessibilityRole="radio" accessibilityState={{ selected: unit === option.unit }}>
          <Text style={[t.subhead, { color: unit === option.unit ? c.white : c.ink, fontWeight: '600' }]}>{option.label}</Text>
        </Pressable>)}
      </View>
      <Group style={styles.sheetGroup}>
        <Field label="Brand (optional)" value={brand} onChangeText={setBrand} placeholder="As printed on the label" />
        <Field label="Place" value={place} onChangeText={setPlace} placeholder="Fridge, pantry, closet…" />
        <Field label="Use by (optional)" value={expires} onChangeText={setExpires} placeholder="YYYY-MM-DD" keyboardType="numbers-and-punctuation" />
      </Group>
      {scan.places.length > 1 && <View style={styles.chips}>
        {scan.places.map(p => <Pressable key={p.id} onPress={() => { haptic.tap(); setPlace(p.name); }} style={[styles.pill, place === p.name && styles.pillOn]}>
          <Text style={[t.subhead, { color: place === p.name ? c.white : c.ink, fontWeight: '600' }]}>{p.name}</Text>
        </Pressable>)}
      </View>}
    </ScrollView>
    <Button label="Use these details" onPress={save} disabled={!valid} style={{ marginTop: 16 }} />
  </Sheet>;
}

const styles = StyleSheet.create({
  card: { marginTop: 24, backgroundColor: c.surface, borderRadius: radius.dock, padding: 16, borderWidth: 1, borderColor: 'rgba(224,145,31,0.28)' },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  modal: { flex: 1, backgroundColor: c.canvas },
  modalHeader: { flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8, gap: 12 },
  close: { width: 32, height: 32, borderRadius: 16, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' },
  sample: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: c.sunriseTint, borderRadius: radius.group, padding: 12, marginTop: 8 },
  placeHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10, paddingHorizontal: 2 },
  placeIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  item: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 12, paddingRight: 14, paddingVertical: 12, gap: 10 },
  checkHit: { paddingTop: 2 },
  check: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: c.ink3, alignItems: 'center', justifyContent: 'center' },
  checkOn: { backgroundColor: c.leaf, borderColor: c.leaf },
  itemBody: { flex: 1, flexDirection: 'row', gap: 12 },
  itemTop: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  thumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: c.tint },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center' },
  thumbSmall: { width: 40, height: 40, borderRadius: 8 },
  closeUp: { ...t.footnote, color: '#875810', marginTop: 4 },
  unclear: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', backgroundColor: c.sunriseTint, borderRadius: radius.group, padding: 12, marginTop: 10 },
  unseen: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
  pill: { paddingHorizontal: 12, minHeight: 34, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: c.canvas, borderWidth: StyleSheet.hairlineWidth, borderColor: c.hairline },
  pillOn: { backgroundColor: c.ink, borderColor: c.ink },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 10, backgroundColor: 'rgba(242,247,251,0.97)', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline },
  sheetGroup: { marginTop: 16, backgroundColor: c.canvas },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
});
