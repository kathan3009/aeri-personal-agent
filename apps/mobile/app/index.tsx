import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { File as DeviceFile, Paths } from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import * as Clipboard from 'expo-clipboard';
import { CircleAlert, Copy, Download, House, ListChecks, LogOut, Mail, RotateCw, Sparkles, Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentTab } from '../components/AgentTab';
import { MemoryTab } from '../components/MemoryTab';
import { ReviewLayer } from '../components/MapReview';
import { TasksTab } from '../components/TasksTab';
import { Bloom, introDelay, LaunchVeil, Reveal, SkyLight, Wordmark } from '../components/motion';
import { Aura, Button, Dot, Field, Glass, Group, Row, Sheet, useReducedMotion, type Icon } from '../components/ui';
import { defaultServer, useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
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

const openPage = (server: string, page: 'terms' | 'privacy') => { haptic.tap(); void WebBrowser.openBrowserAsync(`${server.replace(/\/$/, '')}/${page}`); };

/** Sign in with a one-time code sent to your email. New emails get a new account. */
function SignInScreen() {
  const { sendCode, verifyCode, signedOutReason } = useApp();
  const insets = useSafeAreaInsets();
  const [server, setServer] = useState(defaultServer);
  const [custom, setCustom] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(signedOutReason);
  const run = async (work: () => Promise<void>) => {
    try { setBusy(true); setProblem(null); await work(); }
    catch (error) { haptic.warning(); setProblem((error as Error).message); }
    finally { setBusy(false); }
  };
  const ask = () => run(async () => {
    const result = await sendCode(server, email);
    setStep('code'); setCode(result.devCode ?? '');
    setNote(result.devCode ? 'Development server: the code is filled in for you.' : `We sent a 6-digit code to ${email.trim()}. It expires in 10 minutes.`);
    haptic.success();
  });
  const verify = () => run(async () => { await verifyCode(server, email, code); haptic.success(); });
  return <View style={styles.root}>
    <Sky />
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.connect, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]}>
        <Bloom size={64} delay={140} mode={busy ? 'thinking' : 'idle'} />
        <View style={{ marginTop: 26 }}><Wordmark text="Aeri" delay={420} style={styles.connectTitle} /></View>
        <Reveal delay={760}><Text style={[t.body, { color: c.ink2, marginTop: 8 }]}>Your personal shopping agent. Aeri remembers what you have, finds the best store for what you need and fills the cart. You check it and pay.</Text></Reveal>
        <Reveal delay={900}><Group style={{ marginTop: 36 }}>
          {custom && <Field label="Server address" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" />}
          {step === 'email'
            ? <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" textContentType="emailAddress" autoComplete="email" placeholder="you@example.com" returnKeyType="go" onSubmitEditing={() => void ask()} />
            : <Field label="Code" value={code} onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="one-time-code" placeholder="6 digits" returnKeyType="go" onSubmitEditing={() => void verify()} autoFocus />}
        </Group></Reveal>
        {note && step === 'code' && <Text style={[t.footnote, { color: c.ink2, marginTop: 12, marginHorizontal: 4 }]}>{note}</Text>}
        {problem && <View style={styles.problem} accessibilityLiveRegion="polite"><CircleAlert size={16} color={c.ember} strokeWidth={2} /><Text style={[t.footnote, { color: c.ember, flex: 1 }]}>{problem}</Text></View>}
        <Reveal delay={1000}>
          {step === 'email'
            ? <Button label="Send code" onPress={() => void ask()} loading={busy} disabled={!email.trim()} style={{ marginTop: 22 }} />
            : <>
              <Button label="Continue" onPress={() => void verify()} loading={busy} disabled={code.length !== 6} style={{ marginTop: 22 }} />
              <Button label="Use a different email" tone="plain" onPress={() => { setStep('email'); setCode(''); setProblem(null); }} style={{ marginTop: 4 }} />
            </>}
          {__DEV__ && !custom && <Button label="Use a different server" tone="plain" onPress={() => setCustom(true)} style={{ marginTop: 4 }} />}
        </Reveal>
        <Reveal delay={1150} style={styles.connectFootWrap}>
          <Text style={[t.footnote, styles.connectFoot]}>
            By continuing, you agree to Aeri’s <Text style={styles.link} onPress={() => openPage(server, 'terms')} accessibilityRole="link">Terms</Text> and <Text style={styles.link} onPress={() => openPage(server, 'privacy')} accessibilityRole="link">Privacy Policy</Text>. Aeri never pays or places an order for you.
          </Text>
        </Reveal>
      </ScrollView>
    </KeyboardAvoidingView>
  </View>;
}

const capabilityRows = (p: Record<string, boolean> | null): Array<{ title: string; ready: boolean; detail: string }> => [
  { title: 'Memory, lists and approvals', ready: true, detail: 'Saved privately to your account' },
  { title: 'Video maps of your home', ready: !!p?.vision, detail: p?.vision ? `Reads your video with Gemini${p?.frames ? ', with the frames it saw' : ''}` : 'Shows a sample map until Gemini is connected' },
  { title: 'Recipe videos', ready: !!p?.vision, detail: p?.vision ? 'Reads YouTube links and video files' : 'Shows a sample recipe until Gemini is connected' },
  { title: 'Find from a photo', ready: !!p?.vision && !!p?.exa, detail: p?.vision ? (p?.exa ? 'Reads the photo, searches stores with Exa' : 'Reads the photo; store results are samples') : 'Sample product until Gemini is connected' },
  { title: 'Store prices and stock', ready: !!p?.exa && !!p?.kernel, detail: p?.exa && p?.kernel ? 'Searches the web and checks each store’s own page' : 'Shows sample stores on this server' },
  { title: 'Store cart', ready: !!p?.kernel, detail: p?.kernel ? 'A private browser you can watch and take over' : 'Opens the store’s site; you add the items' },
  { title: 'Open conversation', ready: !!p?.aiGateway, detail: p?.aiGateway ? 'Through Neon AI Gateway' : 'Simple commands until Neon AI Gateway is connected' },
  { title: 'Talk with Aeri', ready: !!p?.voice, detail: p?.voice ? 'Ready' : 'Needs Gemini; keyboard dictation works now' },
  { title: 'Order emails', ready: !!p?.agentMail, detail: p?.agentMail ? 'Reads store emails you forward to your Aeri address' : 'Not available on this server yet' },
];

type Mailbox = { configured: boolean; connected: boolean; address?: string; checkedAt?: string; error?: string; gmailForwardingCode?: string };
const copy = async (value: string, what: string, toast: (text: string, tone?: 'info') => void) => { haptic.tap(); await Clipboard.setStringAsync(value); toast(`${what} copied`, 'info'); };

/** Your own Aeri email address: one tap to create it, then forward store emails to it. */
function EmailSection() {
  const { request } = useApp();
  const { toast } = useFeedback();
  const [mail, setMail] = useState<Mailbox | null>(null);
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void request<Mailbox>('/v1/mailbox').then(setMail).catch(() => setMail(null)); }, [request]);
  const change = async (method: 'POST' | 'DELETE') => {
    try { setBusy(true); const next = await request<Mailbox>(method === 'POST' ? '/v1/mailbox/connect' : '/v1/mailbox', { method }); setMail(next); haptic.success(); if (method === 'POST') setSteps(true); }
    catch (error) { haptic.warning(); toast((error as Error).message); }
    finally { setBusy(false); }
  };
  if (!mail) return null;
  return <>
    <Text style={[t.footnote, styles.sheetLabel]}>Order emails</Text>
    <Group style={styles.sheetGroup} inset={36}>
      {mail.address
        ? <Row title={mail.address} subtitle={mail.error ? `Can’t read the inbox right now: ${mail.error}` : 'Your Aeri address. Tap to copy, then forward store emails here.'} left={<Dot color={mail.error ? c.ember : c.leaf} />}
            right={<Copy size={17} color={c.accent} strokeWidth={2} />} onPress={() => void copy(mail.address!, 'Address', toast)} accessibilityLabel={`Copy your Aeri email address, ${mail.address}`} />
        : <Row title={mail.configured ? 'Get your Aeri email address' : 'Not available yet'} subtitle={mail.configured ? 'One tap. Aeri reads order emails and store sign-in codes sent here.' : 'This Aeri server isn’t set up for email.'}
            left={busy ? <ActivityIndicator color={c.accent} /> : <Mail size={18} color={mail.configured ? c.accent : c.ink3} strokeWidth={2} />} onPress={mail.configured && !busy ? () => void change('POST') : undefined} accessibilityLabel="Create your Aeri email address" />}
      {!!mail.gmailForwardingCode && <Row title={`Gmail confirmation code: ${mail.gmailForwardingCode}`} subtitle="Paste it into Gmail’s forwarding settings." left={<Dot color={c.sunrise} />}
        right={<Copy size={17} color={c.accent} strokeWidth={2} />} onPress={() => void copy(mail.gmailForwardingCode!, 'Code', toast)} />}
      {!!mail.address && <Row title="How to forward store emails" chevron onPress={() => setSteps(open => !open)} accessibilityLabel="Show how to forward store emails" />}
    </Group>
    {steps && mail.address && <Text style={[t.footnote, styles.steps]}>
      1. In Gmail on a computer, open Settings → Forwarding and POP/IMAP → Add a forwarding address, and enter {mail.address}. Gmail sends a confirmation code here; it appears above.{'\n'}
      2. Create a filter: From “target.com OR walmart.com OR instacart.com” (add any store you use) → Forward it to {mail.address}.{'\n'}
      3. Aeri reads those emails every minute. It suggests order numbers, flags deliveries for you to check, and enters store sign-in codes for sign-ins you start. It never changes an order or your memory on its own.
    </Text>}
    {!!mail.address && <Button label="Remove this address" tone="plain" loading={busy} onPress={() => void change('DELETE')} style={{ marginTop: 2 }} />}
  </>;
}

type Usage = { ai: { used: number; limit: number }; browser: { used: number; limit: number } };
/** Who is signed in, today's usage, a copy of your data, signing out and deleting the account. */
function AccountSection({ onClose }: { onClose: () => void }) {
  const { account, request, signOut } = useApp();
  const { toast } = useFeedback();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  useEffect(() => { void request<{ usage: Usage }>('/v1/me').then(result => setUsage(result.usage)).catch(() => undefined); }, [request]);
  const exportData = async () => {
    try {
      setBusy('export');
      const data = await request<unknown>('/v1/account/export');
      const file = new DeviceFile(Paths.cache, `aeri-export-${new Date().toISOString().slice(0, 10)}.json`);
      if (file.exists) file.delete();
      file.create(); file.write(JSON.stringify(data, null, 2));
      await Share.share({ url: file.uri, title: 'Your Aeri data' });
    } catch (error) { toast((error as Error).message); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    try { setBusy('delete'); await request('/v1/account', { method: 'DELETE', body: JSON.stringify({ confirm }) }); haptic.success(); onClose(); await signOut(); }
    catch (error) { haptic.warning(); toast((error as Error).message); setBusy(null); }
  };
  return <>
    <Text style={[t.footnote, styles.sheetLabel]}>Account</Text>
    <Group style={styles.sheetGroup} inset={36}>
      <Row title={account?.email ?? 'Signed in'} subtitle={usage ? `Today: ${usage.ai.used} of ${usage.ai.limit} AI requests, ${usage.browser.used} of ${usage.browser.limit} store visits` : undefined} left={<Dot color={c.leaf} />} />
      <Row title="Download my data" left={busy === 'export' ? <ActivityIndicator color={c.accent} /> : <Download size={18} color={c.accent} strokeWidth={2} />} onPress={busy ? undefined : () => void exportData()} />
      <Row title="Delete account" left={<Trash2 size={18} color={c.ember} strokeWidth={2} />} onPress={() => setDeleting(open => !open)} />
    </Group>
    {deleting && <View style={{ marginTop: 10 }}>
      <Text style={[t.footnote, styles.steps]}>This deletes your memory, lists, files, your Aeri email address and your store connections, and signs you out everywhere. It can’t be undone. Type {account?.email} to confirm.</Text>
      <Group style={[styles.sheetGroup, { marginTop: 8 }]}><Field label="Email" value={confirm} onChangeText={setConfirm} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" /></Group>
      <Button label="Delete my account" tone="destructive" icon={Trash2} loading={busy === 'delete'} disabled={confirm.trim().toLowerCase() !== account?.email} onPress={() => void remove()} style={{ marginTop: 6 }} />
    </View>}
  </>;
}

function SettingsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { settings, providers, error, refresh, signOut } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  return <Sheet visible={visible} onClose={onClose} title="Settings">
    <ScrollView style={{ maxHeight: 520 }} contentContainerStyle={{ paddingBottom: 6 }} showsVerticalScrollIndicator={false}>
      <Group style={styles.sheetGroup}>
        <Row title={error ? 'Aeri isn’t reachable right now' : 'Connected to Aeri'} subtitle={settings?.url.replace(/^https?:\/\//, '')} left={<Dot color={error ? c.ember : c.leaf} />}
          right={refreshing ? <ActivityIndicator color={c.accent} /> : <RotateCw size={18} color={c.accent} strokeWidth={2} />}
          onPress={async () => { setRefreshing(true); await refresh(); setRefreshing(false); }} accessibilityLabel="Refresh connection" />
      </Group>
      <Text style={[t.footnote, styles.sheetLabel]}>What Aeri can do right now</Text>
      <Group style={styles.sheetGroup} inset={36}>
        {capabilityRows(providers).map(row => <Row key={row.title} title={row.title} subtitle={row.detail} left={<Dot color={row.ready ? c.leaf : 'rgba(15,43,64,0.18)'} />} />)}
      </Group>
      {visible && <AccountSection onClose={onClose} />}
      {visible && <EmailSection />}
      <Button label="Sign out" icon={LogOut} tone="destructive" onPress={() => { onClose(); void signOut(); }} style={{ marginTop: 14 }} />
      <View style={styles.legal}>
        <Text style={[t.footnote, styles.link]} onPress={() => openPage(settings?.url ?? defaultServer, 'privacy')} accessibilityRole="link">Privacy Policy</Text>
        <Text style={[t.footnote, styles.link]} onPress={() => openPage(settings?.url ?? defaultServer, 'terms')} accessibilityRole="link">Terms</Text>
      </View>
    </ScrollView>
  </Sheet>;
}

function Unreachable() {
  const { error, refresh, signOut } = useApp();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  return <View style={[styles.center, { paddingTop: insets.top }]}>
    <Aura size={56} mode={busy ? 'thinking' : 'idle'} />
    <Text style={[t.title2, { marginTop: 24, textAlign: 'center' }]}>Can't reach Aeri</Text>
    <Text style={[t.subhead, { marginTop: 8, textAlign: 'center', maxWidth: 300 }]}>{error?.replace(/^Can't reach Aeri(?: at (\S+))?\.\s*/, (_, where) => where ? `No answer from ${where}. ` : '')}</Text>
    <Button label="Try again" onPress={async () => { setBusy(true); await refresh(); setBusy(false); }} loading={busy} style={{ marginTop: 28, alignSelf: 'stretch' }} />
    <Button label="Sign out" tone="plain" onPress={() => void signOut()} style={{ marginTop: 6 }} />
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
  const top = useMemo(() => skyFor()[0], []);
  const bottomGap = Math.max(insets.bottom, 14);
  const bottomInset = 64 + bottomGap + 10;
  const nav = useMemo(() => ({
    go: (next: Tab) => { setVisited(seen => new Set(seen).add(next)); setTab(next); void refresh(); },
    openSettings: () => setSettingsOpen(true), openReview: setReviewing, bottomInset, keyboard,
  }), [bottomInset, keyboard, refresh]);
  if (loading) return <View style={styles.root} />;
  if (!settings) return <SignInScreen />;
  if (!state) return <View style={styles.root}><Sky /><Unreachable /><SettingsSheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} /></View>;
  return <NavContext.Provider value={nav}>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
      <Sky />
      {tabs.map(({ key }) => visited.has(key) && <TabScreen key={key} active={tab === key}>
        {key === 'agent' ? <AgentTab /> : key === 'memory' ? <MemoryTab /> : <TasksTab />}
      </TabScreen>)}
      {/* Content scrolling up fades under the status bar instead of colliding with the clock. */}
      {tab !== 'agent' && <LinearGradient pointerEvents="none" colors={[top, top, `${top}00`]} locations={[0, 0.6, 1]} style={[styles.statusFade, { height: insets.top + 14 }]} />}
      {/* Content fades out before it reaches the floating tab bar. */}
      {!keyboard && tab !== 'agent' && <LinearGradient pointerEvents="none" colors={['rgba(242,247,251,0)', 'rgba(242,247,251,0.92)', c.canvas]} locations={[0, 0.45, 1]} style={[styles.tabFade, { height: bottomInset + 18 }]} />}
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
  steps: { marginTop: 10, marginHorizontal: 4, color: c.ink, lineHeight: 20 },
  link: { color: c.accent, fontWeight: '600' },
  legal: { flexDirection: 'row', justifyContent: 'center', gap: 20, marginTop: 14 },
  tabDock: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  tabFade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  statusFade: { position: 'absolute', left: 0, right: 0, top: 0 },
  tabBar: { borderRadius: radius.pill, overflow: 'hidden', width: '86%', maxWidth: 360 },
  tabRow: { flexDirection: 'row', padding: 5, height: 64 },
  tabItem: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, borderRadius: radius.pill },
  tabActive: { backgroundColor: 'rgba(27,120,191,0.1)' },
  tabLabel: { fontSize: 11, lineHeight: 13, fontWeight: '600', color: c.ink2 },
  badge: { position: 'absolute', top: -2, right: -5, width: 9, height: 9, borderRadius: 5, backgroundColor: c.sunrise, borderWidth: 1.5, borderColor: c.white },
});
