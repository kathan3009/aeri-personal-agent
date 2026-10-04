import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import { CircleAlert, House, ListChecks, LogOut, RotateCw, Sparkles } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentTab } from '../components/AgentTab';
import { MemoryTab } from '../components/MemoryTab';
import { ReviewLayer } from '../components/MapReview';
import { TasksTab } from '../components/TasksTab';
import { Bloom, introDelay, LaunchVeil, Reveal, SkyLight, Wordmark } from '../components/motion';
import { Aura, Button, Dot, Field, Glass, Group, Row, Sheet, useReducedMotion, type Icon } from '../components/ui';
import { useApp } from '../lib/api';
import { haptic } from '../lib/haptics';
import { NavContext } from '../lib/nav';
import { attentionTabs, type Tab } from '../lib/pending';
import { c, radius, skyFor, t } from '../lib/theme';

const preview = Platform.OS === 'web';

function Sky() {
  const colors = useMemo(() => skyFor(), []);
  return <>
    <LinearGradient pointerEvents="none" colors={colors} locations={[0, 0.45, 1]} style={styles.sky} />
    <SkyLight />
  </>;
}

function ConnectScreen() {
  const { connect } = useApp();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState(preview ? 'http://127.0.0.1:8787' : process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    try { setBusy(true); setProblem(null); await connect(url, token); haptic.success(); }
    catch (error) { haptic.warning(); setProblem((error as Error).message); }
    finally { setBusy(false); }
  };
  return <View style={styles.root}>
    <Sky />
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.connect, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}>
        <Bloom size={64} delay={140} mode={busy ? 'thinking' : 'idle'} />
        <View style={{ marginTop: 26 }}><Wordmark text="Aeri" delay={420} style={styles.connectTitle} /></View>
        <Reveal delay={760}><Text style={[t.body, { color: c.ink2, marginTop: 8 }]}>A quiet helper for your home. It remembers what you have, plans what you need, and shops only with your OK.</Text></Reveal>
        <Reveal delay={900}><Group style={{ marginTop: 36 }}>
          <Field label="Server address" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" />
          <Field label="Access code" value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="From your .env file" returnKeyType="go" onSubmitEditing={() => void submit()} />
        </Group></Reveal>
        {problem && <View style={styles.problem} accessibilityLiveRegion="polite"><CircleAlert size={16} color={c.ember} strokeWidth={2} /><Text style={[t.footnote, { color: c.ember, flex: 1 }]}>{problem}</Text></View>}
        <Reveal delay={1000}><Button label="Connect" onPress={() => void submit()} loading={busy} disabled={!token.trim()} style={{ marginTop: 22 }} /></Reveal>
        <Reveal delay={1150} style={styles.connectFootWrap}><Text style={[t.footnote, styles.connectFoot]}>{preview
          ? 'Development preview. Your code is kept only for this browser session.'
          : 'Both are in the .env file on the computer running Aeri. The code stays in this phone’s secure storage.'}</Text></Reveal>
      </ScrollView>
    </KeyboardAvoidingView>
  </View>;
}

const capabilityRows = (p: Record<string, boolean> | null): Array<{ title: string; ready: boolean; detail: string }> => [
  { title: 'Memory, lists and approvals', ready: true, detail: p?.neon ? 'Saved in Neon Postgres' : 'Saved on the computer running Aeri' },
  { title: 'Video maps of your home', ready: !!p?.vision, detail: p?.vision ? `Reads your video with Gemini${p?.frames ? ', with the frames it saw' : ''}` : 'Shows a sample map until Gemini is connected' },
  { title: 'Recipe videos', ready: !!p?.vision, detail: p?.vision ? 'Reads YouTube links and video files' : 'Shows a sample recipe until Gemini is connected' },
  { title: 'Find from a photo', ready: !!p?.vision && !!p?.exa, detail: p?.vision ? (p?.exa ? 'Reads the photo, searches stores with Exa' : 'Reads the photo; store results are samples') : 'Sample product until Gemini is connected' },
  { title: 'Store prices and stock', ready: !!p?.exa && !!p?.kernel, detail: p?.exa && p?.kernel ? 'Checks each store’s own page with Kernel' : 'Sample stores until Exa and Kernel are connected' },
  { title: 'Store cart', ready: !!p?.kernel, detail: p?.kernel ? 'Private Kernel browser you can watch and take over' : 'Opens the store’s site; you add the items' },
  { title: 'Open conversation', ready: !!p?.aiGateway, detail: p?.aiGateway ? 'Through Neon AI Gateway' : 'Simple commands until Neon AI Gateway is connected' },
  { title: 'Talk with Aeri', ready: !!p?.voice, detail: p?.voice ? 'Ready' : 'Needs Gemini; keyboard dictation works now' },
  { title: 'Receipts by email', ready: !!p?.agentMail, detail: p?.agentMail ? 'Through AgentMail' : 'Needs AgentMail and a public server' },
];

function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { settings, providers, error, refresh, disconnect } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  return <Sheet visible={visible} onClose={onClose} title="Settings">
    <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
      <Group style={styles.sheetGroup}>
        <Row title={settings?.url.replace(/^https?:\/\//, '') ?? 'Not connected'} subtitle={error ? 'Not reachable right now' : 'Connected'} left={<Dot color={error ? c.ember : c.leaf} />}
          right={refreshing ? <ActivityIndicator color={c.accent} /> : <RotateCw size={18} color={c.accent} strokeWidth={2} />}
          onPress={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} accessibilityLabel="Refresh connection" />
      </Group>
      <Text style={[t.footnote, styles.sheetLabel]}>What Aeri can do right now</Text>
      <Group style={styles.sheetGroup} inset={36}>
        {capabilityRows(providers).map(row => <Row key={row.title} title={row.title} subtitle={row.detail} left={<Dot color={row.ready ? c.leaf : 'rgba(15,43,64,0.18)'} />} />)}
      </Group>
      <Button label="Disconnect this device" icon={LogOut} tone="destructive" onPress={() => { onClose(); void disconnect(); }} style={{ marginTop: 10 }} />
    </ScrollView>
  </Sheet>;
}

function Unreachable() {
  const { error, refresh, disconnect } = useApp();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  return <View style={[styles.center, { paddingTop: insets.top }]}>
    <Aura size={56} mode={busy ? 'thinking' : 'idle'} />
    <Text style={[t.title2, { marginTop: 24, textAlign: 'center' }]}>Can't reach Aeri</Text>
    <Text style={[t.subhead, { marginTop: 8, textAlign: 'center', maxWidth: 300 }]}>{error?.replace(/^Can't reach Aeri(?: at (\S+))?\.\s*/, (_, where) => where ? `No answer from ${where}. ` : '')}</Text>
    <Button label="Try again" onPress={async () => { setBusy(true); await refresh(); setBusy(false); }} loading={busy} style={{ marginTop: 28, alignSelf: 'stretch' }} />
    <Button label="Change server" tone="plain" onPress={() => void disconnect()} style={{ marginTop: 6 }} />
  </View>;
}

const tabs: Array<{ key: Tab; label: string; icon: Icon; symbol: SFSymbol; activeSymbol: SFSymbol }> = [
  { key: 'agent', label: 'Agent', icon: Sparkles, symbol: 'sparkles', activeSymbol: 'sparkles' },
  { key: 'memory', label: 'Memory', icon: House, symbol: 'house', activeSymbol: 'house.fill' },
  { key: 'tasks', label: 'Tasks', icon: ListChecks, symbol: 'checklist', activeSymbol: 'checklist' },
];

/** SF Symbols on iPhone (with the system bounce on selection); matching line icons elsewhere. */
function TabIcon({ tab, active }: { tab: (typeof tabs)[number]; active: boolean }) {
  const [taps, setTaps] = useState(0);
  const was = useRef(active);
  useEffect(() => { if (active && !was.current) setTaps(n => n + 1); was.current = active; }, [active]);
  const color = active ? c.accent : c.ink2;
  if (Platform.OS === 'ios') return <SymbolView key={taps} name={active ? tab.activeSymbol : tab.symbol} size={23} tintColor={color} weight={active ? 'semibold' : 'regular'}
    animationSpec={taps ? { effect: { type: 'bounce', direction: 'up' } } : undefined} fallback={<tab.icon size={22} color={color} />} />;
  const TabGlyph = tab.icon;
  return <TabGlyph size={22} color={color} strokeWidth={active ? 2.1 : 1.8} />;
}

/** Cross-fades a tab's content in when it becomes the selected tab. */
function TabScreen({ active, children }: { active: boolean; children: ReactNode }) {
  const reduced = useReducedMotion();
  const enter = useRef(new Animated.Value(1)).current;
  const was = useRef(active);
  useEffect(() => {
    if (active && !was.current && !reduced) {
      enter.setValue(0);
      Animated.spring(enter, { toValue: 1, damping: 20, stiffness: 220, useNativeDriver: Platform.OS !== 'web' }).start();
    }
    was.current = active;
  }, [active, enter, reduced]);
  return <Animated.View style={[styles.screen, !active && styles.hidden, { opacity: enter, transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) }] }]}
    accessibilityElementsHidden={!active} importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}>{children}</Animated.View>;
}

export default function Root() {
  const { settings, state, loading, error } = useApp();
  const ready = !loading && (!settings || !!state || !!error);
  return <View style={styles.root}>
    <Home />
    <LaunchVeil ready={ready} brief={!loading && !settings} />
  </View>;
}

function Home() {
  const { settings, state, loading, refresh } = useApp();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('agent');
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set(['agent']));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const attention = useMemo(() => attentionTabs(state), [state]);
  const bottomGap = Math.max(insets.bottom, 14);
  const bottomInset = 64 + bottomGap + 10;
  const nav = useMemo(() => ({
    go: (next: Tab) => { setVisited(seen => new Set(seen).add(next)); setTab(next); void refresh(); },
    openSettings: () => setSettingsOpen(true), openReview: setReviewing, bottomInset, keyboard,
  }), [bottomInset, keyboard, refresh]);
  if (loading) return <View style={styles.root} />;
  if (!settings) return <ConnectScreen />;
  if (!state) return <View style={styles.root}><Sky /><Unreachable /><SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} /></View>;
  return <NavContext.Provider value={nav}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <Sky />
      {tabs.map(({ key }) => visited.has(key) && <TabScreen key={key} active={tab === key}>
        {key === 'agent' ? <AgentTab /> : key === 'memory' ? <MemoryTab /> : <TasksTab />}
      </TabScreen>)}
      {!keyboard && <Reveal delay={introDelay(260)} distance={30} pointerEvents="box-none" style={[styles.tabDock, { bottom: bottomGap }]}>
        <Glass style={styles.tabBar}>
          <View style={styles.tabRow} accessibilityRole="tablist">
            {tabs.map(item => {
              const { key, label } = item;
              const active = tab === key;
              return <Pressable key={key} onPress={() => { if (!active) haptic.tap(); nav.go(key); }} style={[styles.tabItem, active && styles.tabActive]}
                accessibilityRole="tab" accessibilityState={{ selected: active }} accessibilityLabel={attention.has(key) ? `${label}, needs your attention` : label}>
                <View>
                  <TabIcon tab={item} active={active} />
                  {attention.has(key) && <View style={styles.badge} />}
                </View>
                <Text style={[styles.tabLabel, active && { color: c.accent }]}>{label}</Text>
              </Pressable>;
            })}
          </View>
        </Glass>
      </Reveal>}
    </KeyboardAvoidingView>
    {reviewing && state.scans.find(s => s.id === reviewing && s.status === 'needs_review') && <ReviewLayer scan={state.scans.find(s => s.id === reviewing)!} onClose={() => setReviewing(null)} />}
    <SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </NavContext.Provider>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.canvas },
  sky: { position: 'absolute', top: 0, left: 0, right: 0, height: 360 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  screen: { flex: 1 },
  hidden: { display: 'none' },
  connect: { paddingHorizontal: 24, flexGrow: 1 },
  connectTitle: { fontSize: 40, lineHeight: 46, fontWeight: '700', letterSpacing: -1, color: c.ink },
  connectFootWrap: { marginTop: 'auto' },
  problem: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 14, paddingHorizontal: 4 },
  connectFoot: { textAlign: 'center', paddingTop: 28, paddingHorizontal: 12, color: c.ink3 },
  sheetGroup: { backgroundColor: c.canvas },
  sheetLabel: { marginTop: 22, marginBottom: 8, marginLeft: 4 },
  tabDock: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  tabBar: { borderRadius: radius.pill, overflow: 'hidden', width: '86%', maxWidth: 360 },
  tabRow: { flexDirection: 'row', padding: 5, height: 64 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: radius.pill },
  tabActive: { backgroundColor: 'rgba(27,120,191,0.1)' },
  tabLabel: { fontSize: 11, lineHeight: 13, fontWeight: '600', color: c.ink2 },
  badge: { position: 'absolute', top: -2, right: -5, width: 9, height: 9, borderRadius: 5, backgroundColor: c.sunrise, borderWidth: 1.5, borderColor: c.white },
});
