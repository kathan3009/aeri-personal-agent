import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { CircleAlert, ExternalLink, ScanSearch, ShieldCheck } from 'lucide-react-native';
import type { Candidate, PhotoSearch } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { c, radius, t } from '../lib/theme';
import { Reveal, Shimmer } from './motion';
import { Aura, Button, Group, Sheet, Tag } from './ui';

const matchLabel: Record<Candidate['match'], { label: string; tone: 'leaf' | 'neutral' | 'attention' | 'sample' }> = {
  exact: { label: 'Exact match', tone: 'leaf' }, likely: { label: 'Likely match', tone: 'neutral' }, similar: { label: 'Similar', tone: 'neutral' }, mismatch: { label: 'Doesn’t fit', tone: 'attention' },
};
const price = (v?: Candidate['verification']) => v?.priceCents != null ? `$${(v.priceCents / 100).toFixed(2)}` : null;
const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
function evidence(candidate: Candidate) {
  const v = candidate.verification;
  if (!v) return candidate.source === 'fixture' ? 'Sample listing. Price and stock not checked.' : 'Found by search. Price, stock and size not checked at the store.';
  if (v.method === 'fixture') return `Sample price ${price(v) ?? ''}`.trim();
  if (v.status === 'verified') return `${price(v)} at ${time(v.checkedAt)}${v.availability === 'in_stock' ? ', in stock' : v.availability === 'out_of_stock' ? ', out of stock' : ', stock not shown'}${v.storeLocation ? ` · ${v.storeLocation}` : ''}`;
  return v.note ?? 'The store page could not be read';
}

export function PhotoCard({ search }: { search: PhotoSearch }) {
  const { request, refresh, providers } = useApp();
  const { toast } = useFeedback();
  const { go } = useNav();
  const [open, setOpen] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (search.status === 'searching') return <Reveal from="scale" style={styles.card}>
    <View style={styles.top}><Aura size={26} mode="thinking" /><Shimmer style={[t.headline, { flex: 1 }]}>Looking for your item…</Shimmer></View>
    <Text style={[t.footnote, { marginTop: 6 }]}>Reading the photo, then checking stores. Nothing is added to a list without you.</Text>
  </Reveal>;
  if (search.status === 'failed') return <Reveal style={styles.card}>
    <View style={styles.top}><CircleAlert size={18} color={c.ember} strokeWidth={2} /><Text style={[t.headline, { flex: 1 }]}>I couldn’t search for that photo</Text></View>
    <Text style={[t.footnote, { marginTop: 6 }]}>{search.error}</Text>
  </Reveal>;
  const spec = search.spec!;
  const sample = search.source === 'demo' || search.discovery === 'fixture';
  const shown = search.candidates.filter(c => c.match !== 'mismatch').slice(0, 4);
  const hidden = search.candidates.length - shown.length;
  const choose = async (candidate: Candidate, acceptUncertain: boolean) => {
    try {
      setBusy('choose');
      await request(`/v1/photos/${search.id}/candidates/${candidate.id}/choose`, { method: 'POST', body: JSON.stringify({ acceptUncertain }) });
      await refresh(); haptic.success(); setOpen(null);
      toast('Added to a list for your approval', 'success'); go('tasks');
    } catch (error) { haptic.warning(); toast((error as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  const verify = async (candidate: Candidate) => {
    try { setBusy('verify'); const next = await request<Candidate>(`/v1/photos/${search.id}/candidates/${candidate.id}/verify`, { method: 'POST' }); await refresh(); setOpen(next); }
    catch (error) { toast((error as Error).message, 'error'); }
    finally { setBusy(null); }
  };
  return <Reveal style={styles.card}>
    <View style={styles.top}>
      <View style={styles.icon}><ScanSearch size={18} color={c.accent} strokeWidth={2} /></View>
      <View style={{ flex: 1 }}>
        <Text style={t.title3} accessibilityRole="header">{[spec.brand, spec.productLine, spec.name].filter(Boolean).join(' ')}</Text>
        <Text style={t.footnote}>{[spec.variant, spec.size, spec.color].filter(Boolean).join(' · ') || 'From your photo'}</Text>
      </View>
      {sample && <Tag label="Sample" tone="sample" />}
    </View>
    {sample && <Text style={[t.footnote, styles.sampleNote]}>{search.source === 'demo' ? 'Photo understanding isn’t connected, so this is a sample product with sample store results.' : 'Store search isn’t connected, so these store results are samples.'}</Text>}
    {!!spec.visibleText.length && <Text style={[t.footnote, { marginTop: 8 }]} numberOfLines={2}>Label reads: “{spec.visibleText.slice(0, 4).join('”, “')}”</Text>}
    {(spec.uncertain.length > 0 || spec.closeUp) && <Text style={[t.footnote, { color: '#875810', marginTop: 6 }]}>{spec.closeUp ?? `The photo doesn’t show the ${spec.uncertain.join(' or ')} clearly. A closer photo of the label helps.`}</Text>}
    {!!search.constraints?.applied.length && <View style={styles.chips}>{search.constraints.applied.slice(0, 5).map(a => <Tag key={a} label={a} />)}</View>}
    <Group style={styles.inner}>
      {shown.map(candidate => <Pressable key={candidate.id} onPress={() => { haptic.tap(); setOpen(candidate); }} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }]} accessibilityRole="button"
        accessibilityLabel={`${matchLabel[candidate.match].label}: ${candidate.title} at ${candidate.merchant}. ${evidence(candidate)}`}>
        <View style={{ flex: 1 }}>
          <View style={styles.rowTop}><Tag label={matchLabel[candidate.match].label} tone={matchLabel[candidate.match].tone} /><Text style={[t.footnote, { flex: 1 }]} numberOfLines={1}>{candidate.merchant}</Text></View>
          <Text style={[t.callout, { marginTop: 4 }]} numberOfLines={2}>{candidate.title}</Text>
          <Text style={[t.footnote, { marginTop: 2, color: candidate.verification?.status === 'verified' ? c.ink2 : c.ink3 }]} numberOfLines={2}>{evidence(candidate)}</Text>
        </View>
      </Pressable>)}
      {!shown.length && <View style={styles.row}><Text style={t.subhead}>No result fits what you asked for yet.</Text></View>}
    </Group>
    {hidden > 0 && <Text style={[t.footnote, { marginTop: 8, marginLeft: 4 }]}>{hidden} more {hidden === 1 ? 'result conflicts' : 'results conflict'} with your preferences.</Text>}
    <Sheet visible={!!open} onClose={() => setOpen(null)} title={open ? matchLabel[open.match].label : ''} message={open?.title}>
      {open && <>
        <Text style={[t.subhead, { marginTop: 12, color: c.ink }]}>{open.merchant} · {evidence(open)}</Text>
        {open.reasons.map(r => <View key={r} style={styles.reason}><ShieldCheck size={15} color={c.leaf} strokeWidth={2} /><Text style={[t.footnote, { flex: 1, color: c.ink }]}>{r}</Text></View>)}
        {open.warnings.map(w => <View key={w} style={styles.reason}><CircleAlert size={15} color={c.sunrise} strokeWidth={2} /><Text style={[t.footnote, { flex: 1, color: c.ink }]}>{w}</Text></View>)}
        {open.match === 'exact'
          ? <Button label="Add to a list" onPress={() => void choose(open, false)} loading={busy === 'choose'} style={{ marginTop: 18 }} />
          : open.match !== 'mismatch' && <>
            <Button label={`Use this ${open.match} match`} tone="secondary" onPress={() => void choose(open, true)} loading={busy === 'choose'} style={{ marginTop: 18 }} />
            <Text style={[t.footnote, { textAlign: 'center', marginTop: 8 }]}>It isn’t confirmed identical to your photo. You’ll still approve the list before anything is bought.</Text>
          </>}
        {open.source === 'exa' && providers?.kernel && open.verification?.status !== 'verified' && <Button label="Check price and stock at the store" tone="plain" loading={busy === 'verify'} onPress={() => void verify(open)} style={{ marginTop: 4 }} />}
        {open.source === 'exa' && <Button label="Open product page" icon={ExternalLink} tone="plain" onPress={() => void Linking.openURL(open.url)} />}
      </>}
    </Sheet>
  </Reveal>;
}

const styles = StyleSheet.create({
  card: { marginTop: 24, backgroundColor: c.surface, borderRadius: radius.dock, padding: 18 },
  top: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 36, height: 36, borderRadius: 10, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  sampleNote: { marginTop: 10, backgroundColor: c.sunriseTint, color: '#6B4A12', borderRadius: 12, padding: 10, overflow: 'hidden' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  inner: { marginTop: 14, backgroundColor: c.canvas },
  row: { paddingHorizontal: 14, paddingVertical: 12, minHeight: 56 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reason: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', marginTop: 8 },
});
