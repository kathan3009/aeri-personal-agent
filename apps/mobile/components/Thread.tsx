import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Easing, Linking, Platform, Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Speech from 'expo-speech';
import { ActionBarPrimitive, useAuiState } from '@assistant-ui/react-native';
import { ArrowDown, BookmarkCheck, Check, Copy, Eraser, Film, Image as ImageIcon, Minus, PackageSearch, ScanEye, ShoppingBasket, Square, Store, Users, Volume2 } from 'lucide-react-native';
import type { AppState } from '@personal-agent/core';
import { useApp } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { cartTitle, isReceived } from '../lib/pending';
import { c, quantity, radius, t, titleCase } from '../lib/theme';
import { Reveal } from './motion';
import { Tag, useReducedMotion, type Icon } from './ui';

const nativeDriver = Platform.OS !== 'web';

/* ------------------------------------------------------------------ text */

const inline = (text: string, base: StyleProp<TextStyle>, key: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g).filter(Boolean).map((piece, index) => {
    if (piece.startsWith('**') && piece.endsWith('**')) return <Text key={`${key}-${index}`} style={[base, styles.strong]}>{piece.slice(2, -2)}</Text>;
    if (/^https?:\/\//.test(piece)) return <Text key={`${key}-${index}`} style={[base, styles.link]} onPress={() => void Linking.openURL(piece)} accessibilityRole="link">{piece.replace(/^https?:\/\/(www\.)?/, '')}</Text>;
    return piece;
  });

/** Assistant replies are mostly plain sentences; this keeps the occasional bold, list or link readable. */
export function RichText({ text, style }: { text: string; style: StyleProp<TextStyle> }) {
  const blocks = text.trim().split(/\n{2,}/);
  return <View style={{ gap: 10 }}>
    {blocks.map((block, b) => {
      const lines = block.split('\n');
      const list = lines.every(line => /^\s*([-*•]|\d+[.)])\s+/.test(line));
      if (!list) return <Text key={b} style={style} selectable>{inline(lines.join('\n'), style, String(b))}</Text>;
      return <View key={b} style={{ gap: 4 }}>
        {lines.map((line, l) => {
          const marker = line.match(/^\s*(\d+[.)]|[-*•])\s+/)!;
          const numbered = /\d/.test(marker[1]);
          return <View key={l} style={styles.listRow}>
            <Text style={[style, styles.marker]}>{numbered ? marker[1].replace(')', '.') : '•'}</Text>
            <Text style={[style, { flex: 1 }]} selectable>{inline(line.slice(marker[0].length), style, `${b}-${l}`)}</Text>
          </View>;
        })}
      </View>;
    })}
  </View>;
}

/* ------------------------------------------------------------- presence */

/** Three soft dots while Aeri works on a reply. */
export function Typing() {
  const reduced = useReducedMotion();
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduced) { dots.forEach(dot => dot.setValue(0.5)); return; }
    const loop = Animated.loop(Animated.stagger(150, dots.map(dot => Animated.sequence([
      Animated.timing(dot, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: nativeDriver }),
      Animated.timing(dot, { toValue: 0, duration: 420, easing: Easing.in(Easing.quad), useNativeDriver: nativeDriver }),
    ]))));
    loop.start();
    return () => loop.stop();
  }, [dots, reduced]);
  return <View style={styles.typing} accessible accessibilityLabel="Aeri is thinking" accessibilityLiveRegion="polite">
    {dots.map((dot, index) => <Animated.View key={index} style={[styles.typingDot, {
      opacity: dot.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
      transform: [{ translateY: dot.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
    }]} />)}
  </View>;
}

/* ----------------------------------------------------------------- time */

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
function stampFor(date: Date) {
  const now = new Date();
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const clock = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay(date, now)) return `Today ${clock}`;
  if (sameDay(date, yesterday)) return `Yesterday ${clock}`;
  return `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${clock}`;
}
/** A quiet time line where a conversation picks up again after a break. */
export function TimeStamp({ date, previous }: { date: Date; previous?: Date }) {
  if (previous && date.getTime() - previous.getTime() < 45 * 60_000) return null;
  return <Text style={styles.stamp} accessibilityRole="text">{stampFor(date)}</Text>;
}

/* -------------------------------------------------------- what Aeri did */

type Line = { key: string; icon: Icon; text: string };
type Card = { key: string; icon: Icon; title: string; detail: string; sample?: boolean; status?: { label: string; tone: 'leaf' | 'attention' | 'neutral' }; action?: { label: string; onPress: () => void } };

const listStatus = (state: AppState, cartId: string): Card['status'] => {
  const cart = state.carts.find(entry => entry.id === cartId);
  if (!cart) return undefined;
  if (isReceived(state, cart)) return { label: 'Delivered', tone: 'leaf' };
  return ({ draft: { label: 'Needs your review', tone: 'attention' }, approved: { label: 'Approved', tone: 'leaf' }, checkout_ready: { label: 'Store open', tone: 'neutral' }, ordered: { label: 'Ordered', tone: 'leaf' }, cancelled: { label: 'Discarded', tone: 'neutral' } } as const)[cart.status];
};

/** Turns the events recorded during one reply into the things a person would recognise. */
function describe(state: AppState, events: AppState['events'], nav: ReturnType<typeof useNav>) {
  const lines: Line[] = [];
  const cards: Card[] = [];
  const seenCarts = new Set<string>();
  const remembered = events.filter(e => e.type === 'inventory.confirmed');
  if (remembered.length > 3) lines.push({ key: 'remembered', icon: BookmarkCheck, text: `Remembered ${remembered.length} things` });
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    const name = typeof data.name === 'string' ? data.name.toLowerCase() : '';
    switch (event.type) {
      case 'inventory.confirmed':
        if (remembered.length <= 3) lines.push({ key: event.id, icon: BookmarkCheck, text: `Remembered ${quantity({ amount: Number(data.amount), unit: String(data.unit ?? 'each') })} ${name}` });
        break;
      case 'inventory.consumed': lines.push({ key: event.id, icon: Minus, text: `Used ${data.amount} ${name}` }); break;
      case 'inventory.removed': lines.push({ key: event.id, icon: Eraser, text: `Forgot ${name}` }); break;
      case 'inventory.corrected': {
        const item = state.inventory.find(entry => entry.id === data.inventoryId);
        lines.push({ key: event.id, icon: Check, text: item ? `Updated ${item.name.toLowerCase()}` : 'Updated your kitchen' });
        break;
      }
      case 'preference.updated': lines.push({ key: event.id, icon: BookmarkCheck, text: String(data.key).startsWith('note') ? 'Saved a note' : `Saved ${String(data.key)}: ${String(data.value)}` }); break;
      case 'preference.removed': lines.push({ key: event.id, icon: Eraser, text: `Forgot ${String(data.key)}` }); break;
      case 'recipe.scaled': lines.push({ key: event.id, icon: Users, text: `Set to ${data.servings} servings` }); break;
      case 'recipe.created':
      case 'cart.requested': {
        const cartId = String(data.cartId ?? '');
        const cart = state.carts.find(entry => entry.id === cartId);
        if (!cart || seenCarts.has(cartId)) break;
        seenCarts.add(cartId);
        const recipe = cart.recipeId ? state.recipes.find(r => r.id === cart.recipeId) : undefined;
        const count = cart.items.length;
        cards.push({
          key: event.id, icon: ShoppingBasket, title: cartTitle(state, cart),
          detail: count ? `${count} ${count === 1 ? 'item' : 'items'} to buy${recipe ? ', checked against your kitchen' : ''}` : 'You already have everything',
          sample: recipe?.source === 'demo', status: listStatus(state, cartId),
          action: { label: cart.status === 'draft' ? 'Review' : 'Open', onPress: () => nav.go('tasks') },
        });
        break;
      }
      case 'scan.observed': {
        const scan = state.scans.find(entry => entry.id === data.scanId);
        const count = Number(data.count ?? scan?.observations.length ?? 0);
        const review = scan?.status === 'needs_review';
        cards.push({
          key: event.id, icon: ScanEye, title: 'Mapped your video', detail: `${count} ${count === 1 ? 'thing' : 'things'}${scan?.places.length ? ` in ${scan.places.map(p => p.name.toLowerCase()).join(', ')}` : ''}`,
          sample: data.source === 'demo', status: review ? { label: 'Needs your check', tone: 'attention' } : { label: 'Checked', tone: 'leaf' },
          action: { label: review ? 'Check' : 'Open', onPress: () => review && scan ? nav.openReview(scan.id) : nav.go('memory') },
        });
        break;
      }
      case 'photo.searched': {
        const exact = Number(data.exact ?? 0), total = Number(data.candidates ?? 0);
        cards.push({ key: event.id, icon: PackageSearch, title: 'Looked up your photo', detail: total ? `${total} ${total === 1 ? 'match' : 'matches'}${exact ? `, ${exact} exact` : ''}` : 'No matches yet', action: { label: 'See', onPress: () => nav.go('tasks') } });
        break;
      }
      case 'proposal.ready': lines.push({ key: event.id, icon: Store, text: 'Compared stores' }); break;
    }
  }
  return { lines, cards };
}

/**
 * What Aeri actually did while writing a reply: small receipts above the words, so the
 * conversation shows real changes to memory and lists, not just claims about them.
 */
export function Activity({ index }: { index: number }) {
  const { state } = useApp();
  const nav = useNav();
  const { lines, cards } = useMemo(() => {
    const messages = state?.messages ?? [];
    const message = messages[index];
    if (!state || !message || message.role !== 'assistant') return { lines: [], cards: [] };
    const from = index > 0 ? messages[index - 1].createdAt : '';
    const events = state.events.filter(event => event.at > from && event.at <= message.createdAt);
    return describe(state, events, nav);
  }, [index, nav, state]);
  if (!lines.length && !cards.length) return null;
  return <View style={styles.activity}>
    {lines.length > 0 && <View style={styles.trail} accessible accessibilityLabel={lines.map(line => line.text).join('. ')}>
      {lines.map(({ key, icon: LineIcon, text }) => <View key={key} style={styles.trailRow}>
        <LineIcon size={14} color={c.leaf} strokeWidth={2.2} />
        <Text style={styles.trailText} numberOfLines={2}>{titleCase(text)}</Text>
      </View>)}
    </View>}
    {cards.map(card => <ResultCard key={card.key} card={card} />)}
  </View>;
}

function ResultCard({ card }: { card: Card }) {
  const CardIcon = card.icon;
  const statusColor = card.status?.tone === 'attention' ? '#875810' : card.status?.tone === 'leaf' ? c.leaf : c.ink2;
  return <Pressable onPress={card.action ? () => { haptic.tap(); card.action!.onPress(); } : undefined} disabled={!card.action}
    style={({ pressed }) => [styles.card, pressed && { backgroundColor: '#F7FAFD' }]} accessibilityRole={card.action ? 'button' : undefined}
    accessibilityLabel={`${card.title}. ${card.detail}.${card.status ? ` ${card.status.label}.` : ''}${card.sample ? ' Sample.' : ''}`} accessibilityHint={card.action?.label}>
    <View style={styles.cardIcon}><CardIcon size={18} color={c.accent} strokeWidth={1.9} /></View>
    <View style={{ flex: 1, gap: 1 }}>
      <Text style={styles.cardTitle} numberOfLines={2}>{card.title}</Text>
      <Text style={t.footnote} numberOfLines={2}>{card.detail}</Text>
      {(card.status || card.sample) && <View style={styles.cardMeta}>
        {card.status && <Text style={[styles.cardStatus, { color: statusColor }]}>{card.status.label}</Text>}
        {card.sample && <Tag label="Sample" tone="sample" />}
      </View>}
    </View>
    {card.action && <View style={styles.cardAction}><Text style={styles.cardActionText}>{card.action.label}</Text></View>}
  </Pressable>;
}

/* -------------------------------------------------------------- actions */

/** Copy and read-aloud under Aeri's latest reply. */
export function MessageActions() {
  const text = useAuiState(s => s.message.content.map(part => part.type === 'text' ? part.text : '').join('\n').trim());
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => () => { if (speaking) void Speech.stop(); }, [speaking]);
  if (!text) return null;
  const speak = () => {
    haptic.tap();
    if (speaking) { void Speech.stop(); setSpeaking(false); return; }
    setSpeaking(true);
    const done = () => setSpeaking(false);
    Speech.speak(text.replace(/\*\*/g, ''), { language: 'en-US', rate: 0.96, onDone: done, onStopped: done, onError: done });
  };
  return <View style={styles.actions}>
    <ActionBarPrimitive.Copy copyToClipboard={value => { haptic.tap(); return Clipboard.setStringAsync(value.replace(/\*\*/g, '')).then(() => undefined); }}
      hitSlop={8} style={styles.action} accessibilityLabel="Copy reply">
      {({ isCopied }) => <>{isCopied ? <Check size={15} color={c.leaf} strokeWidth={2.4} /> : <Copy size={15} color={c.ink3} strokeWidth={2} />}
        <Text style={[styles.actionText, isCopied && { color: c.leaf }]}>{isCopied ? 'Copied' : 'Copy'}</Text></>}
    </ActionBarPrimitive.Copy>
    <Pressable onPress={speak} hitSlop={8} style={styles.action} accessibilityRole="button" accessibilityLabel={speaking ? 'Stop reading' : 'Read reply aloud'}>
      {speaking ? <Square size={13} color={c.accent} strokeWidth={2.4} /> : <Volume2 size={15} color={c.ink3} strokeWidth={2} />}
      <Text style={[styles.actionText, speaking && { color: c.accent }]}>{speaking ? 'Stop' : 'Read aloud'}</Text>
    </Pressable>
  </View>;
}

/* ---------------------------------------------------------- suggestions */

export function Suggestions({ items, onPick }: { items: string[]; onPick: (text: string) => void }) {
  return <View style={styles.suggestions}>
    {items.map((item, index) => <Reveal key={item} delay={index * 40} from="scale">
      <Pressable onPress={() => { haptic.tap(); onPick(item); }} style={({ pressed }) => [styles.suggestion, pressed && { backgroundColor: c.tintStrong }]} accessibilityRole="button" accessibilityLabel={`Write: ${item}`}>
        <Text style={styles.suggestionText}>{item}</Text>
      </Pressable>
    </Reveal>)}
  </View>;
}

/* ---------------------------------------------------------- attachment */

/** The video or photo on its way to Aeri, shown where the person's message would be. */
export function Sending({ kind }: { kind: 'scan' | 'photo' }) {
  const KindIcon = kind === 'scan' ? Film : ImageIcon;
  return <Reveal from="scale" style={styles.sendingWrap}>
    <View style={styles.sending} accessible accessibilityLabel={`Sending your ${kind === 'scan' ? 'video' : 'photo'}`} accessibilityLiveRegion="polite">
      <View style={styles.sendingIcon}><KindIcon size={18} color={c.accent} strokeWidth={1.9} /></View>
      <View>
        <Text style={styles.cardTitle}>{kind === 'scan' ? 'Your video' : 'Your photo'}</Text>
        <Text style={t.footnote}>Sending to Aeri…</Text>
      </View>
      <ActivityIndicator size="small" color={c.accent} style={{ marginLeft: 6 }} />
    </View>
  </Reveal>;
}

/* ---------------------------------------------------------------- scroll */

export function JumpToLatest({ visible, onPress, bottom }: { visible: boolean; onPress: () => void; bottom: number }) {
  const shown = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.spring(shown, { toValue: visible ? 1 : 0, damping: 18, stiffness: 260, useNativeDriver: nativeDriver }).start(); }, [shown, visible]);
  return <Animated.View pointerEvents={visible ? 'auto' : 'none'} style={[styles.jumpWrap, { bottom, opacity: shown, transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }] }]}>
    <Pressable onPress={() => { haptic.tap(); onPress(); }} style={styles.jump} accessibilityRole="button" accessibilityLabel="Jump to the latest message" hitSlop={8}>
      <ArrowDown size={18} color={c.ink} strokeWidth={2.2} />
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  strong: { fontWeight: '600' },
  link: { color: c.accent, textDecorationLine: 'underline' },
  listRow: { flexDirection: 'row', gap: 8 },
  marker: { minWidth: 14, color: c.ink2 },
  typing: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 24, paddingLeft: 2 },
  typingDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.accent },
  stamp: { ...t.caption, textAlign: 'center', marginTop: 22, marginBottom: -4, color: c.ink3 },
  activity: { gap: 8, marginBottom: 10 },
  trail: { borderLeftWidth: 2, borderLeftColor: 'rgba(31,132,102,0.28)', paddingLeft: 10, gap: 5, paddingVertical: 2 },
  trailRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  trailText: { ...t.footnote, color: c.ink, fontWeight: '500', flexShrink: 1 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: c.surface, borderRadius: radius.group, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(15,43,64,0.12)', paddingHorizontal: 12, paddingVertical: 11 },
  cardIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  cardTitle: { ...t.subhead, color: c.ink, fontWeight: '600', flexShrink: 1 },
  cardStatus: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  cardAction: { paddingHorizontal: 13, minHeight: 32, borderRadius: radius.pill, backgroundColor: c.tint, justifyContent: 'center' },
  cardActionText: { fontSize: 14, fontWeight: '600', color: c.accent },
  actions: { flexDirection: 'row', gap: 18, marginTop: 8 },
  action: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 28 },
  actionText: { fontSize: 13, fontWeight: '500', color: c.ink3 },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 18 },
  suggestion: { paddingHorizontal: 14, minHeight: 36, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: c.tint },
  suggestionText: { fontSize: 15, color: c.accent, fontWeight: '500', letterSpacing: -0.1 },
  sendingWrap: { alignSelf: 'flex-end', marginTop: 18 },
  sending: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.surface, borderRadius: 20, borderBottomRightRadius: 6, paddingLeft: 10, paddingRight: 14, paddingVertical: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(15,43,64,0.1)' },
  sendingIcon: { width: 36, height: 36, borderRadius: 11, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  jumpWrap: { position: 'absolute', alignSelf: 'center' },
  jump: { width: 38, height: 38, borderRadius: 19, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(15,43,64,0.14)', ...Platform.select({ web: { boxShadow: '0 4px 14px rgba(39,96,140,0.16)' } as object, default: { shadowColor: '#27608C', shadowOpacity: 0.16, shadowRadius: 10, shadowOffset: { width: 0, height: 4 }, elevation: 4 } }) },
});
