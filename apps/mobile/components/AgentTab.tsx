import { useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View, type TextInput } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Speech from 'expo-speech';
import { ActionBarPrimitive, AuiIf, AssistantRuntimeProvider, ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useLocalRuntime, type ChatModelAdapter, type ThreadMessageLike } from '@assistant-ui/react-native';
import { ArrowUp, ChevronRight, CircleAlert, Clapperboard, Film, Link2, Mic, PenLine, Plus, Square, Video } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { pendingFor } from '../lib/pending';
import { c, greetingFor, host, lift, radius, t } from '../lib/theme';
import { OfflineNotice, SettingsButton } from './Header';
import { Aura, Button, Dot, Field, Glass, Group, noWebOutline, Row, Sheet } from './ui';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

type Work = null | 'scan' | 'voice';
const youtube = (value: string) => { try { const url = new URL(value.trim()); return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname) ? url.toString() : null; } catch { return null; } };
const toThread = (messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }>): ThreadMessageLike[] =>
  messages.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: new Date(m.createdAt) }));

function UserText({ text }: { text: string }) {
  const link = /^https?:\/\/\S+$/.test(text.trim()) ? text.trim() : null;
  if (!link) return <Text style={styles.userText}>{text}</Text>;
  const video = !!youtube(link);
  return <View style={styles.linkChip}>
    <View style={styles.linkIcon}>{video ? <Clapperboard size={16} color={c.accent} strokeWidth={2} /> : <Link2 size={16} color={c.accent} strokeWidth={2} />}</View>
    <View style={{ flexShrink: 1 }}>
      <Text style={[t.subhead, { color: c.ink, fontWeight: '600' }]}>{video ? 'Recipe video' : 'Link'}</Text>
      <Text style={t.footnote} numberOfLines={1}>{host(link)}</Text>
    </View>
  </View>;
}

function Message() {
  const role = useAuiState(s => s.message.role);
  const running = useAuiState(s => s.message.status?.type === 'running');
  if (role === 'user') return <MessagePrimitive.Root style={styles.userBubble}>
    <MessagePrimitive.Content renderText={({ part }) => <UserText text={part.text} />} />
  </MessagePrimitive.Root>;
  return <MessagePrimitive.Root style={styles.assistant}>
    {running && <Text style={[t.callout, { color: c.ink3 }]}>Thinking…</Text>}
    <MessagePrimitive.Content renderText={({ part }) => part.text ? <Text style={styles.assistantText} selectable>{part.text}</Text> : <View />} />
    <ErrorPrimitive.Root style={styles.errorBox}>
      <CircleAlert size={17} color={c.ember} strokeWidth={2} style={{ marginTop: 1 }} />
      <View style={{ flex: 1 }}>
        <Text style={[t.subhead, { color: c.ink }]}>Aeri couldn't finish that.</Text>
        <ErrorPrimitive.Message style={[t.footnote, { marginTop: 2 }]} />
        <ActionBarPrimitive.Reload style={styles.retry} accessibilityLabel="Try again">{() => <Text style={[t.subhead, { color: c.accent, fontWeight: '600' }]}>Try again</Text>}</ActionBarPrimitive.Reload>
      </View>
    </ErrorPrimitive.Root>
  </MessagePrimitive.Root>;
}

function Welcome({ onRecipe, onKitchen, onTell }: { onRecipe: () => void; onKitchen: () => void; onTell: () => void }) {
  return <View style={styles.welcome}>
    <Text style={t.largeTitle} accessibilityRole="header">{greetingFor()}</Text>
    <Text style={[t.title3, { color: c.ink2, fontWeight: '400', marginTop: 4 }]}>What can I take care of?</Text>
    <Group style={{ marginTop: 28 }} inset={62}>
      <Row title="Shop for a recipe video" subtitle="Paste a YouTube link. I'll list only what you're missing." onPress={onRecipe} chevron left={<View style={styles.rowIcon}><Clapperboard size={19} color={c.accent} strokeWidth={1.9} /></View>} />
      <Row title="Show me your kitchen" subtitle="Record a short video. You confirm what I see." onPress={onKitchen} chevron left={<View style={styles.rowIcon}><Video size={19} color={c.accent} strokeWidth={1.9} /></View>} />
      <Row title="Tell me what you have" subtitle={'“I have 6 eggs” or “my shirt size is M”'} onPress={onTell} chevron left={<View style={styles.rowIcon}><PenLine size={19} color={c.accent} strokeWidth={1.9} /></View>} />
    </Group>
  </View>;
}

function Dock() {
  const { state } = useApp();
  const { go, keyboard } = useNav();
  const pending = useMemo(() => pendingFor(state), [state]);
  if (!pending.length || keyboard) return null;
  const [first] = pending;
  const quiet = first.title.startsWith('Waiting');
  return <Pressable onPress={() => { haptic.tap(); go(first.tab); }} style={({ pressed }) => [styles.dockWrap, pressed && { transform: [{ scale: 0.985 }] }]}
    accessibilityRole="button" accessibilityLabel={`${first.title}. ${first.detail}.${pending.length > 1 ? ` ${pending.length - 1} more waiting.` : ''}`}>
    <Glass style={styles.dock}>
      <Dot color={quiet ? c.ink3 : c.sunrise} size={9} />
      <View style={{ flex: 1 }}>
        <Text style={t.headline} numberOfLines={1}>{first.title}</Text>
        <Text style={t.footnote} numberOfLines={1}>{first.detail}</Text>
      </View>
      {pending.length > 1 && <Text style={[t.number, styles.more]}>+{pending.length - 1}</Text>}
      <ChevronRight size={18} color={c.ink3} strokeWidth={2} />
    </Glass>
  </Pressable>;
}

function Conversation({ work, recording, linkOpen, setLinkOpen, onAttach, onScan, onVoice }: { work: Work; recording: boolean; linkOpen: boolean; setLinkOpen: (open: boolean) => void; onAttach: () => void; onScan: () => void; onVoice: () => void }) {
  const aui = useAui();
  const insets = useSafeAreaInsets();
  const { bottomInset, keyboard } = useNav();
  const running = useAuiState(s => s.thread.isRunning);
  const empty = useAuiState(s => s.composer.text.trim().length === 0);
  const input = useRef<TextInput>(null);
  const [link, setLink] = useState('');
  const mode = recording ? 'listening' : running || work ? 'thinking' : 'idle';
  const status = recording ? 'Listening' : work === 'scan' ? 'Looking at your video' : work === 'voice' ? 'Understanding your voice note' : running ? 'Thinking' : null;
  const sendLink = () => {
    const url = youtube(link);
    if (!url) return;
    setLinkOpen(false); setLink('');
    aui.composer.setText(url); aui.composer.send();
  };
  return <ThreadPrimitive.Root style={{ flex: 1 }}>
    <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
      <Aura size={30} mode={mode} />
      <View style={{ flex: 1 }}>
        <Text style={t.headline}>Aeri</Text>
        {status && <Text style={[t.footnote, { marginTop: -1 }]} accessibilityLiveRegion="polite">{status}</Text>}
      </View>
      <SettingsButton />
    </View>
    <View style={{ paddingHorizontal: 20 }}><OfflineNotice /></View>
    <ThreadPrimitive.MessagesFlatList autoScroll keyboardShouldPersistTaps="handled" contentContainerStyle={styles.messages} showsVerticalScrollIndicator={false}
      ListHeaderComponent={<AuiIf condition={s => s.thread.isEmpty}><Welcome onRecipe={() => setLinkOpen(true)} onKitchen={onScan} onTell={() => { aui.composer.setText('I have '); input.current?.focus(); }} /></AuiIf>}>
      {() => <Message />}
    </ThreadPrimitive.MessagesFlatList>
    <Dock />
    <View style={[styles.composerWrap, { paddingBottom: keyboard ? 8 : bottomInset }]}>
      <ComposerPrimitive.Root style={[styles.composer, lift]}>
        <Pressable onPress={() => { haptic.tap(); onAttach(); }} disabled={recording} hitSlop={6} style={styles.plus} accessibilityRole="button" accessibilityLabel="Add a recipe link or kitchen video">
          <Plus size={20} color={c.accent} strokeWidth={2.2} />
        </Pressable>
        <ComposerPrimitive.Input {...({ ref: input } as object)} placeholder={recording ? 'Listening. Tap stop to send.' : 'Message Aeri'} placeholderTextColor={recording ? c.ember : c.ink3}
          editable={!recording} multiline style={styles.input} accessibilityLabel="Message Aeri" />
        {empty ? <Pressable onPress={onVoice} disabled={work !== null} style={[styles.trailing, recording ? styles.stop : styles.mic, work !== null && { opacity: 0.4 }]}
          accessibilityRole="button" accessibilityLabel={recording ? 'Stop and send voice note' : 'Record a voice note'}>
          {recording ? <Square size={14} color={c.white} fill={c.white} /> : <Mic size={19} color={c.ink} strokeWidth={1.9} />}
        </Pressable>
          : <ComposerPrimitive.Send style={[styles.trailing, styles.send]} accessibilityLabel="Send"><ArrowUp size={19} color={c.white} strokeWidth={2.4} /></ComposerPrimitive.Send>}
      </ComposerPrimitive.Root>
    </View>
    <Sheet visible={linkOpen} onClose={() => setLinkOpen(false)} title="Shop for a recipe video" message="Paste a public YouTube link. I'll compare the recipe with your kitchen and list only what's missing. Nothing is bought without your OK.">
      <Group style={{ marginTop: 18, backgroundColor: c.canvas }}>
        <Field label="YouTube link" value={link} onChangeText={setLink} placeholder="https://youtu.be/…" autoCapitalize="none" autoCorrect={false} keyboardType="url" autoFocus returnKeyType="go" onSubmitEditing={sendLink} />
      </Group>
      {!!link.trim() && !youtube(link) && <Text style={[t.footnote, { color: c.ember, marginTop: 8, marginLeft: 4 }]}>That doesn't look like a YouTube link yet.</Text>}
      <Button label="Make a shopping list" onPress={sendLink} disabled={!youtube(link)} style={{ marginTop: 18 }} />
    </Sheet>
  </ThreadPrimitive.Root>;
}

export function AgentTab() {
  const { state, request, upload, refresh, providers } = useApp();
  const { toast, dismissToast, ask } = useFeedback();
  const { go } = useNav();
  const [work, setWork] = useState<Work>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recording = useAudioRecorderState(recorder).isRecording;
  const initial = useRef<ThreadMessageLike[]>(toThread(state?.messages ?? []));
  const adapter = useMemo<ChatModelAdapter>(() => ({
    async run({ messages }) {
      const last = messages[messages.length - 1];
      const text = last?.content.filter(part => part.type === 'text').map(part => part.text).join(' ') ?? '';
      try { const result = await request<{ reply: string }>('/v1/chat', { method: 'POST', body: JSON.stringify({ text }) }); return { content: [{ type: 'text', text: result.reply }] }; }
      finally { void refresh(); }
    },
  }), [request, refresh]);
  const runtime = useLocalRuntime(adapter, { initialMessages: initial.current });

  const processVideo = async (camera: boolean) => {
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) { toast('Camera access is off. Turn it on in the Settings app to record your kitchen.', 'error'); return; }
      const result = camera ? await ImagePicker.launchCameraAsync({ mediaTypes: ['videos'], videoMaxDuration: 40, videoQuality: 0 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'] });
      const asset = !result.canceled ? result.assets[0] : null;
      if (!asset) return;
      setWork('scan'); toast('Looking at your video…', 'working');
      const scan = await upload<{ observations: unknown[]; source: 'demo' | 'gemini' }>('/v1/scans', asset.uri, 'video', asset.mimeType ?? 'video/mp4');
      await refresh();
      const count = scan.observations.length;
      haptic.success();
      if (!count) toast("I couldn't make out any groceries. Try a slower pan in good light.", 'info');
      else { toast(`${count} ${count === 1 ? 'thing' : 'things'} to check in Memory${scan.source === 'demo' ? ' (sample items)' : ''}`, 'success'); go('memory'); }
    } catch (error) { dismissToast(); toast((error as Error).message, 'error'); }
    finally { setWork(null); }
  };
  const onScan = () => ask({
    title: 'Show me your kitchen',
    message: providers?.gemini ? 'A slow, steady 20 to 40 second pan works best. You will confirm everything I think I see.' : 'Video understanding isn’t connected yet, so I’ll show sample items for you to confirm. Nothing is saved without your OK.',
    actions: [
      ...(Platform.OS === 'web' ? [] : [{ label: 'Record a video', icon: Video, onPress: () => void processVideo(true) }]),
      { label: 'Choose a video', icon: Film, onPress: () => void processVideo(false) },
    ],
  });
  const onAttach = () => ask({
    title: 'Add to the conversation',
    actions: [
      { label: 'Recipe video link', detail: 'Plan a shopping list from YouTube', icon: Clapperboard, onPress: () => setLinkOpen(true) },
      ...(Platform.OS === 'web' ? [] : [{ label: 'Record your kitchen', detail: 'Update what you have', icon: Video, onPress: () => void processVideo(true) }]),
      { label: 'Choose a kitchen video', detail: 'From your library', icon: Film, onPress: () => void processVideo(false) },
    ],
  });
  const onVoice = async () => {
    if (recording) {
      try {
        setWork('voice'); haptic.press(); await recorder.stop();
        if (!recorder.uri) return;
        const result = await upload<{ transcript: string; reply: string }>('/v1/voice', recorder.uri, 'audio', 'audio/m4a');
        const latest = await request<{ state: { messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> } }>('/v1/bootstrap');
        runtime.thread.reset(toThread(latest.state.messages));
        await refresh();
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        Speech.speak(result.reply, { language: 'en-US', rate: 0.96 });
      } catch (error) { toast((error as Error).message, 'error'); }
      finally { setWork(null); }
      return;
    }
    if (!providers?.gemini) { toast('Voice notes aren’t set up yet. Type for now; Settings shows what’s connected.', 'info'); return; }
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) { toast('Microphone access is off. Turn it on in the Settings app to send voice notes.', 'error'); return; }
    haptic.press();
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync(); recorder.record();
  };
  return <AssistantRuntimeProvider runtime={runtime}>
    <Conversation work={work} recording={recording} linkOpen={linkOpen} setLinkOpen={setLinkOpen} onAttach={onAttach} onScan={onScan} onVoice={() => void onVoice()} />
  </AssistantRuntimeProvider>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 8 },
  messages: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, flexGrow: 1 },
  welcome: { paddingTop: 36, paddingBottom: 12 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  userBubble: { alignSelf: 'flex-end', maxWidth: '82%', backgroundColor: c.surface, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 15, paddingVertical: 10, marginTop: 18 },
  userText: { ...t.callout, color: c.ink },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  linkIcon: { width: 32, height: 32, borderRadius: 9, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  assistant: { alignSelf: 'stretch', marginTop: 18, paddingRight: 24 },
  assistantText: { ...t.callout, lineHeight: 24, color: c.ink },
  errorBox: { flexDirection: 'row', gap: 10, backgroundColor: c.emberTint, borderRadius: 14, padding: 12, marginTop: 4 },
  retry: { alignSelf: 'flex-start', paddingVertical: 6, marginTop: 2 },
  dockWrap: { paddingHorizontal: 16, paddingBottom: 10 },
  dock: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.dock, paddingHorizontal: 16, paddingVertical: 12, overflow: 'hidden' },
  more: { fontSize: 13, color: c.ink2 },
  composerWrap: { paddingHorizontal: 16 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: c.surface, borderRadius: 26, padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: c.hairline, minHeight: 52 },
  plus: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, ...t.callout, ...noWebOutline, color: c.ink, maxHeight: 120, paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 10 : 9, paddingBottom: Platform.OS === 'ios' ? 10 : 9, minHeight: 40 },
  trailing: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  mic: { backgroundColor: c.fill },
  stop: { backgroundColor: c.ember },
  send: { backgroundColor: c.accent },
});
