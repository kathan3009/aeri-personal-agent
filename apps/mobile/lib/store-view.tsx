import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Clipboard from 'expo-clipboard';
import { ActivityIndicator, Linking, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Copy, ExternalLink, KeyRound, ShieldCheck } from 'lucide-react-native';
import { haptic } from './haptics';
import { c, radius, t } from './theme';

/**
 * The store, shown inside Aeri: a live private browser filling the cart, a store sign-in, or the store's own site.
 * It replaces a generic browser tab so the person always knows what they're looking at and that payment is theirs.
 */
/** `code` looks for a sign-in code the store just emailed to Aeri's inbox; it's checked while the sign-in is open. */
type Open = { url: string; title: string; kind: 'live' | 'signin' | 'site'; code?: () => Promise<string | null> };
type StoreView = { open: (view: Open) => Promise<void> };
const Context = createContext<StoreView>({ open: async () => undefined });
export const useStoreView = () => useContext(Context);

export function StoreViewProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [view, setView] = useState<Open | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const closed = useRef<(() => void) | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setCode(null); setCopied(false);
    const look = view?.code;
    if (!look) return;
    let stop = false;
    const check = async () => { try { const found = await look(); if (!stop && found) setCode(found); } catch { /* keep looking */ } };
    void check();
    const timer = setInterval(() => void check(), 4000);
    return () => { stop = true; clearInterval(timer); };
  }, [view]);
  const open = useCallback((next: Open) => {
    const parsed = new URL(next.url);
    if (parsed.protocol !== 'https:') return Promise.reject(new Error('The store link must use HTTPS.'));
    if (Platform.OS === 'web') { void Linking.openURL(next.url); return Promise.resolve(); }
    setLoading(true); setFailed(false); setView(next);
    return new Promise<void>(resolve => { closed.current = resolve; });
  }, []);
  const close = () => { haptic.tap(); setView(null); closed.current?.(); closed.current = null; };
  const value = useMemo(() => ({ open }), [open]);
  const subtitle = view?.kind === 'live' ? 'Live session. You can take over at any time.' : view?.kind === 'signin' ? 'Your password goes to the store, not to Aeri.' : view ? new URL(view.url).hostname.replace(/^www\./, '') : '';
  return <Context.Provider value={value}>
    {children}
    <Modal visible={!!view} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <View style={[styles.root, Platform.OS === 'android' && { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <View style={styles.titleRow}>
              {view?.kind === 'live' && <View style={styles.liveDot} accessibilityLabel="Live" />}
              <Text style={t.headline} numberOfLines={1}>{view?.title}</Text>
            </View>
            <Text style={[t.footnote, { marginTop: 1 }]} numberOfLines={1}>{subtitle}</Text>
          </View>
          <Pressable onPress={close} hitSlop={10} style={styles.done} accessibilityRole="button" accessibilityLabel="Done">
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
        {!!code && <View style={styles.code} accessibilityLiveRegion="polite">
          <KeyRound size={16} color={c.leaf} strokeWidth={2} />
          <Text style={[t.subhead, { color: c.ink, flex: 1 }]}>Code from {view?.title.replace(/^Sign in to /, '')}: <Text style={styles.codeText}>{code}</Text></Text>
          <Pressable onPress={() => { haptic.tap(); void Clipboard.setStringAsync(code).then(() => setCopied(true)); }} hitSlop={8} style={styles.copy} accessibilityRole="button" accessibilityLabel={`Copy code ${code}`}>
            <Copy size={14} color={c.accent} strokeWidth={2.2} /><Text style={styles.copyText}>{copied ? 'Copied' : 'Copy'}</Text>
          </Pressable>
        </View>}
        <View style={styles.frame}>
          {view && !failed && <WebView source={{ uri: view.url }} style={styles.web} originWhitelist={['https://*']} allowsInlineMediaPlayback mediaPlaybackRequiresUserAction={false}
            setSupportMultipleWindows={false} onLoadEnd={() => setLoading(false)} onError={() => { setLoading(false); setFailed(true); }} onHttpError={event => { if (event.nativeEvent.statusCode >= 500) setFailed(true); }} />}
          {loading && !failed && <View style={styles.cover} pointerEvents="none"><ActivityIndicator color={c.accent} /><Text style={[t.footnote, { marginTop: 10 }]}>Opening {view?.title}…</Text></View>}
          {failed && view && <View style={styles.cover}>
            <Text style={[t.headline, { textAlign: 'center' }]}>The store didn’t load</Text>
            <Text style={[t.subhead, { textAlign: 'center', marginTop: 6 }]}>The private browser may have closed. You can open the store in Safari instead.</Text>
            <Pressable onPress={() => void Linking.openURL(view.url)} style={styles.fallback} accessibilityRole="button"><ExternalLink size={16} color={c.accent} strokeWidth={2} /><Text style={styles.doneText}>Open in Safari</Text></Pressable>
          </View>}
        </View>
        <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
          <ShieldCheck size={15} color={c.leaf} strokeWidth={2} />
          <Text style={[t.footnote, { flex: 1 }]}>{view?.kind === 'signin' ? 'Sign in once. Aeri saves the store session, never your password.' : 'Aeri stops before checkout. Payment is always yours.'}</Text>
        </View>
      </View>
    </Modal>
  </Context.Provider>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.canvas },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 12, backgroundColor: c.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hairline },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.ember },
  done: { paddingHorizontal: 14, minHeight: 36, borderRadius: radius.pill, backgroundColor: c.tint, justifyContent: 'center' },
  doneText: { fontSize: 16, fontWeight: '600', color: c.accent },
  frame: { flex: 1, backgroundColor: c.surface },
  code: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20, paddingVertical: 12, backgroundColor: c.leafTint },
  codeText: { fontFamily: Platform.select({ ios: 'ui-rounded', default: undefined }), fontVariant: ['tabular-nums'], fontWeight: '700', letterSpacing: 1.5, color: c.ink },
  copy: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, minHeight: 32, borderRadius: radius.pill, backgroundColor: c.surface },
  copyText: { fontSize: 14, fontWeight: '600', color: c.accent },
  web: { flex: 1, backgroundColor: c.surface },
  cover: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: c.surface },
  fallback: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18, paddingHorizontal: 16, minHeight: 44, borderRadius: radius.pill, backgroundColor: c.tint },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 10, backgroundColor: c.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.hairline },
});
