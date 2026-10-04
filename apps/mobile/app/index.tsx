import { useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Bot, Brain, ListTodo, Settings2, Sparkles } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AgentTab } from '../components/AgentTab';
import { MemoryTab } from '../components/MemoryTab';
import { TasksTab } from '../components/TasksTab';
import { useApp } from '../lib/api';
import { c } from '../lib/theme';

type Tab = 'agent' | 'memory' | 'tasks';

function ConnectScreen() {
  const { connect } = useApp();
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:8787');
  const [token, setToken] = useState(''); const [busy, setBusy] = useState(false);
  const submit = async () => { try { setBusy(true); await connect(url, token); } catch (error) { Alert.alert('Could not connect', (error as Error).message); } finally { setBusy(false); } };
  return <LinearGradient colors={['#DFF3FC', '#F5FAFD', '#FFFFFF']} style={[styles.connect, { paddingTop: insets.top + 38, paddingBottom: insets.bottom + 25 }]}>
    <View style={styles.connectOrb}><Sparkles size={31} color={c.blue} strokeWidth={1.7} /></View>
    <Text style={styles.connectTitle}>Meet Aeri.</Text><Text style={styles.connectSubtitle}>A personal agent that knows your kitchen, remembers your preferences, and helps you shop with intention.</Text>
    <View style={styles.connectCard}><Text style={styles.connectCardTitle}>Connect your agent</Text><Text style={styles.connectCaption}>Your API lives on your computer or private server.</Text>
      <Text style={styles.fieldLabel}>API ADDRESS</Text><TextInput value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.connectInput} />
      <Text style={styles.fieldLabel}>ACCESS CODE</Text><TextInput value={token} onChangeText={setToken} autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="Enter your private access code" placeholderTextColor="#9BAFBB" style={styles.connectInput} />
      <Pressable onPress={() => void submit()} disabled={busy} style={styles.connectButton}>{busy ? <ActivityIndicator color={c.white} /> : <Text style={styles.connectButtonText}>Continue with Aeri</Text>}</Pressable>
    </View>
    <Text style={styles.connectFoot}>Access code stays in your phone's secure storage.</Text>
  </LinearGradient>;
}

export default function Home() {
  const { settings, state, loading, error, disconnect, refresh, phoneNumber } = useApp();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('agent');
  if (loading) return <View style={[styles.root, { justifyContent: 'center' }]}><ActivityIndicator color={c.blue} /></View>;
  if (!settings) return <ConnectScreen />;
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.root}>
    <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
      <View style={styles.brandRow}><View style={styles.brandIcon}><Sparkles size={17} color={c.blue} strokeWidth={1.8} /></View><Text style={styles.brand}>aeri</Text></View>
      <Pressable onPress={() => Alert.alert('Aeri connection', `Connected to ${settings.url}`, [...(phoneNumber ? [{ text: 'Call Aeri', onPress: () => void Linking.openURL(`tel:${phoneNumber}`) }] : []), { text: 'Refresh', onPress: () => void refresh() }, { text: 'Disconnect', style: 'destructive' as const, onPress: () => void disconnect() }, { text: 'Cancel' }])} style={styles.settings} accessibilityLabel="Connection settings"><Settings2 size={19} color={c.muted} /></Pressable>
    </View>
    {error && <Pressable onPress={() => void refresh()} style={styles.errorBanner}><Text style={styles.errorText}>{error} · tap to retry</Text></Pressable>}
    <View style={styles.main}>
      {tab === 'agent' && (state ? <AgentTab /> : <ActivityIndicator color={c.blue} style={{ marginTop: 70 }} />)}
      {tab === 'memory' && <MemoryTab />}
      {tab === 'tasks' && <TasksTab />}
    </View>
    <View style={[styles.navWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
      {([['agent', Bot, 'Agent'], ['memory', Brain, 'Memory'], ['tasks', ListTodo, 'Tasks']] as const).map(([key, Icon, label]) => <Pressable key={key} onPress={() => { setTab(key); void refresh(); }} style={styles.navItem}>
        <View style={[styles.navIcon, tab === key && styles.navActive]}><Icon size={21} color={tab === key ? c.blue : '#95AAB5'} strokeWidth={tab === key ? 2 : 1.7} /></View>
        <Text style={[styles.navLabel, tab === key && styles.navLabelActive]}>{label}</Text>
      </Pressable>)}
    </View>
  </KeyboardAvoidingView>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.background },
  header: { paddingHorizontal: 23, paddingBottom: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, brandIcon: { width: 30, height: 30, borderRadius: 12, backgroundColor: '#DDF2F9', alignItems: 'center', justifyContent: 'center' }, brand: { color: c.deep, fontSize: 23, letterSpacing: -1.2, fontWeight: '700' },
  settings: { width: 38, height: 38, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  errorBanner: { backgroundColor: '#FCE8E6', paddingHorizontal: 22, paddingVertical: 8 }, errorText: { color: '#9D4E4C', fontSize: 12 },
  main: { flex: 1 }, navWrap: { flexDirection: 'row', backgroundColor: 'rgba(255,255,255,.96)', borderTopWidth: 1, borderTopColor: '#E8F0F4', paddingTop: 10, paddingHorizontal: 26 },
  navItem: { flex: 1, alignItems: 'center', gap: 2 }, navIcon: { width: 47, height: 33, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, navActive: { backgroundColor: '#E3F4FB' },
  navLabel: { color: '#93A7B3', fontSize: 10, fontWeight: '600' }, navLabelActive: { color: c.blue },
  connect: { flex: 1, paddingHorizontal: 26 }, connectOrb: { width: 74, height: 74, borderRadius: 26, backgroundColor: 'rgba(255,255,255,.78)', alignItems: 'center', justifyContent: 'center', marginTop: 35, marginBottom: 28 },
  connectTitle: { color: c.deep, fontSize: 42, letterSpacing: -1.8, fontWeight: '600' }, connectSubtitle: { color: c.muted, fontSize: 16, lineHeight: 25, maxWidth: 340, marginTop: 13 },
  connectCard: { backgroundColor: 'rgba(255,255,255,.9)', borderWidth: 1, borderColor: '#E7F1F6', borderRadius: 25, padding: 22, marginTop: 43, shadowColor: '#8DBAD0', shadowOpacity: .12, shadowRadius: 25, shadowOffset: { width: 0, height: 9 } },
  connectCardTitle: { color: c.deep, fontSize: 20, fontWeight: '600' }, connectCaption: { color: c.muted, fontSize: 12, marginTop: 6, marginBottom: 23 },
  fieldLabel: { color: '#83A0AF', fontSize: 10, letterSpacing: 1.2, fontWeight: '800', marginBottom: 7 }, connectInput: { backgroundColor: '#F5F9FB', borderWidth: 1, borderColor: '#E3EDF2', borderRadius: 13, padding: 13, color: c.deep, fontSize: 14, marginBottom: 17 },
  connectButton: { backgroundColor: c.blue, borderRadius: 14, minHeight: 49, alignItems: 'center', justifyContent: 'center', marginTop: 4 }, connectButtonText: { color: c.white, fontWeight: '700', fontSize: 14 },
  connectFoot: { color: '#95ABB8', textAlign: 'center', fontSize: 11, marginTop: 'auto', paddingTop: 15 },
});
