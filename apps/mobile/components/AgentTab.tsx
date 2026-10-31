import { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View, type FlatList, type NativeScrollEvent, type NativeSyntheticEvent, type TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { ActionBarPrimitive, AuiIf, AssistantRuntimeProvider, ComposerPrimitive, ErrorPrimitive, MessagePrimitive, ThreadPrimitive, useAui, useAuiState, useLocalRuntime, type ChatModelAdapter, type ThreadMessageLike } from '@assistant-ui/react-native';
import { ArrowUp, Camera, ChevronRight, CircleAlert, Clapperboard, FileVideo, Film, Image as ImageIcon, Link2, Mic, Plus, ScanSearch, Video } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { pendingFor } from '../lib/pending';
import { c, greetingFor, host, lift, radius, t } from '../lib/theme';
import { OfflineNotice, SettingsButton } from './Header';
import { introDelay, Pop, Reveal, RevealWords } from './motion';
import { Activity, JumpToLatest, MessageActions, RichText, Sending, Suggestions, TimeStamp, Typing } from './Thread';
import { VoiceMode } from './VoiceMode';
import { ActionList, Aura, Button, Dot, Field, Group, noWebOutline, Row, Sheet } from './ui';

// Messages created after this point animate in; restored history appears still.
const openedAt = Date.now();

type Work = null | 'scan' | 'photo';
type Picked = { uri: string; mimeType: string; name?: string; source: 'recorded' | 'library' | 'file' };
const youtube = (value: string) => { try { const url = new URL(value.trim()); return /(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(url.hostname) ? url.toString() : null; } catch { return null; } };
const social = (value: string) => { try { const host = new URL(value.trim()).hostname.replace(/^www\./, ''); return /(^|\.)(instagram\.com|tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|threads\.net|snapchat\.com|pinterest\.com|pin\.it)$/.test(host) ? host : null; } catch { return null; } };
const videoFile = (value: string) => { try { const url = new URL(value.trim()); return url.protocol === 'https:' && /\.(mp4|mov|m4v|webm)$/i.test(url.pathname); } catch { return false; } };
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
  const index = useAuiState(s => s.message.index);
  const last = useAuiState(s => s.message.isLast);
  const running = useAuiState(s => s.message.status?.type === 'running');
  const createdAt = useAuiState(s => s.message.createdAt);
  const previous = useAuiState(s => s.message.index > 0 ? s.thread.messages[s.message.index - 1]?.createdAt : undefined);
  const fresh = createdAt.getTime() > openedAt;
  const stamp = <TimeStamp date={createdAt} previous={previous} />;
  if (role === 'user') {
    const body = <MessagePrimitive.Root style={styles.userBubble}>
      <MessagePrimitive.Content renderText={({ part }) => <UserText text={part.text} />} />
    </MessagePrimitive.Root>;
    return <>{stamp}{fresh ? <Reveal from="scale" style={styles.userWrap}>{body}</Reveal> : <View style={styles.userWrap}>{body}</View>}</>;
  }
  const body = <AssistantMessage running={running} index={index} last={last} />;
  return <>{stamp}{fresh ? <Reveal distance={12}>{body}</Reveal> : body}</>;
}

function AssistantMessage({ running, index, last }: { running: boolean; index: number; last: boolean }) {
  return <MessagePrimitive.Root style={styles.assistant}>
    {!running && <Activity index={index} />}
    {running && <Typing />}
    <MessagePrimitive.Content renderText={({ part }) => part.text ? <RichText text={part.text} style={styles.assistantText} /> : <View />} />
    {last && !running && <MessageActions />}
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

const starters = ['I have 6 eggs in the fridge', 'Where’s the olive oil?', 'We’re out of milk', 'My shoe size is 9'];

function Welcome({ onShow, onPhoto, onRecipe, onSuggest, voice }: { onShow: () => void; onPhoto: () => void; onRecipe: () => void; onSuggest: (text: string) => void; voice: boolean }) {
  const start = useRef(introDelay()).current;
  return <View style={styles.welcome}>
    <RevealWords text={greetingFor()} style={t.largeTitle} delay={start} />
    <Reveal delay={start + 220}><Text style={[t.title3, { color: c.ink2, fontWeight: '400', marginTop: 4 }]}>What can I take care of?</Text></Reveal>
    <Group style={{ marginTop: 28 }} inset={62}>
      <Reveal delay={start + 380}><Row title="Show me a shelf, fridge or closet" subtitle="Film 20 to 40 seconds. I'll map what's there; you confirm." onPress={onShow} chevron left={<View style={styles.rowIcon}><Video size={19} color={c.accent} strokeWidth={1.9} /></View>} /></Reveal>
      <Reveal delay={start + 460}><Row title="Find something from a photo" subtitle="Snap it, say what you want. I'll compare stores." onPress={onPhoto} chevron left={<View style={styles.rowIcon}><ScanSearch size={19} color={c.accent} strokeWidth={1.9} /></View>} /></Reveal>
      <Reveal delay={start + 540}><Row title="Shop for a recipe video" subtitle="Paste a YouTube link. I'll list only what you're missing." onPress={onRecipe} chevron left={<View style={styles.rowIcon}><Clapperboard size={19} color={c.accent} strokeWidth={1.9} /></View>} /></Reveal>
    </Group>
    <Reveal delay={start + 640}><Text style={[t.footnote, styles.hint]}>Or start with one of these:</Text></Reveal>
    <Reveal delay={start + 700}><Suggestions items={starters} onPick={onSuggest} /></Reveal>
  </View>;
}

function Dock() {
  const { state } = useApp();
  const { go, keyboard } = useNav();
  const pending = useMemo(() => pendingFor(state), [state]);
  if (!pending.length || keyboard) return null;
  const [first] = pending;
  const quiet = !!first.quiet;
  return <Reveal key={first.key + first.title} distance={14}><Pressable onPress={() => { haptic.tap(); go(first.tab); }} style={({ pressed }) => [styles.dockWrap, pressed && { opacity: 0.7 }]}
    accessibilityRole="button" accessibilityLabel={`${first.title}. ${first.detail}.${pending.length > 1 ? ` ${pending.length - 1} more waiting.` : ''}`}>
    <View style={[styles.dock, quiet ? styles.dockQuiet : styles.dockAttention]}>
      <Dot color={quiet ? c.ink3 : c.sunrise} size={8} />
      <Text style={styles.dockText} numberOfLines={1}><Text style={styles.dockTitle}>{first.title}</Text>  {first.detail}</Text>
      {pending.length > 1 && <Text style={[t.number, styles.more]}>+{pending.length - 1}</Text>}
      <ChevronRight size={16} color={c.ink2} strokeWidth={2.2} />
    </View>
  </Pressable></Reveal>;
}

function Conversation({ work, linkOpen, setLinkOpen, onAttach, onScan, onPhoto, onVoice, voice }: { work: Work; linkOpen: boolean; setLinkOpen: (open: boolean) => void; onAttach: () => void; onScan: () => void; onPhoto: () => void; onVoice: () => void; voice: boolean }) {
  const aui = useAui();
  const insets = useSafeAreaInsets();
  const { bottomInset, keyboard } = useNav();
  const running = useAuiState(s => s.thread.isRunning);
  const empty = useAuiState(s => s.composer.text.trim().length === 0);
  const input = useRef<TextInput>(null);
  const list = useRef<FlatList>(null);
  const [away, setAway] = useState(false);
  const [link, setLink] = useState('');
  const onScroll = ({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }: NativeSyntheticEvent<NativeScrollEvent>) =>
    setAway(contentSize.height - layoutMeasurement.height - contentOffset.y > 240);
  const suggest = (text: string) => { aui.composer.setText(text); input.current?.focus(); };
  const mode = running || work ? 'thinking' : 'idle';
  const status = work === 'scan' ? 'Sending your video' : work === 'photo' ? 'Sending your photo' : running ? 'Thinking' : null;
  const linkOk = !!youtube(link) || videoFile(link);
  const sendLink = () => {
    if (!linkOk) return;
    setLinkOpen(false); setLink('');
    aui.composer.setText(link.trim()); aui.composer.send();
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
    <View style={{ flex: 1 }}>
      <ThreadPrimitive.MessagesFlatList {...({ ref: list } as object)} autoScroll keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.messages} showsVerticalScrollIndicator={false}
        onScroll={onScroll} scrollEventThrottle={64}
        ListFooterComponent={work === 'scan' || work === 'photo' ? <Sending kind={work} /> : null}
        ListHeaderComponent={<AuiIf condition={s => s.thread.isEmpty}><Welcome onShow={onScan} onPhoto={onPhoto} onRecipe={() => setLinkOpen(true)} onSuggest={suggest} voice={voice} /></AuiIf>}>
        {() => <Message />}
      </ThreadPrimitive.MessagesFlatList>
      <JumpToLatest visible={away} bottom={12} onPress={() => list.current?.scrollToEnd({ animated: true })} />
    </View>
    <Dock />
    <View style={[styles.composerWrap, { paddingBottom: keyboard ? 8 : bottomInset }]}>
      <ComposerPrimitive.Root style={[styles.composer, lift]}>
        <Pressable onPress={() => { haptic.tap(); onAttach(); }} hitSlop={6} style={styles.plus} accessibilityRole="button" accessibilityLabel="Add a video, photo or link">
          <Plus size={20} color={c.accent} strokeWidth={2.2} />
        </Pressable>
        <ComposerPrimitive.Input {...({ ref: input } as object)} placeholder={voice ? 'Message Aeri, or tap the mic' : 'Message Aeri'} placeholderTextColor={c.ink3}
          multiline style={styles.input} accessibilityLabel="Message Aeri" />
        {empty ? <Pressable onPress={onVoice} disabled={work !== null} style={[styles.trailing, styles.mic, work !== null && { opacity: 0.4 }]}
          accessibilityRole="button" accessibilityLabel="Talk with Aeri">
          <Mic size={19} color={c.ink} strokeWidth={1.9} />
        </Pressable>
          : <Pop on={!empty} initial><ComposerPrimitive.Send style={[styles.trailing, styles.send]} accessibilityLabel="Send"><ArrowUp size={19} color={c.white} strokeWidth={2.4} /></ComposerPrimitive.Send></Pop>}
      </ComposerPrimitive.Root>
    </View>
    <Sheet visible={linkOpen} onClose={() => setLinkOpen(false)} title="Shop for a recipe video" message="Paste a public YouTube link or a direct video file link. I'll compare the recipe with what you have and list only what's missing. Nothing is bought without your OK.">
      <Group style={{ marginTop: 18, backgroundColor: c.canvas }}>
        <Field label="Video link" value={link} onChangeText={setLink} placeholder="https://youtu.be/…" autoCapitalize="none" autoCorrect={false} keyboardType="url" autoFocus returnKeyType="go" onSubmitEditing={sendLink} />
      </Group>
      {!!link.trim() && !linkOk && <Text style={[t.footnote, { color: c.ember, marginTop: 8, marginLeft: 4 }]}>{social(link) ? `I can't open ${social(link)} videos from a link. Save the video to your phone, then choose it with +.` : "That doesn't look like a YouTube or video file link yet."}</Text>}
      <Button label="Make a shopping list" onPress={sendLink} disabled={!linkOk} style={{ marginTop: 18 }} />
    </Sheet>
  </ThreadPrimitive.Root>;
}

export function AgentTab() {
  const { state, request, upload, refresh, providers } = useApp();
  const { toast, dismissToast, ask } = useFeedback();
  const { go } = useNav();
  const [work, setWork] = useState<Work>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
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
  // Slow work (a recipe video, a store check) answers later; show those replies when they arrive.
  const serverCount = state?.messages.length ?? 0;
  useEffect(() => {
    const thread = runtime.thread.getState();
    if (!state || thread.isRunning || serverCount <= thread.messages.length) return;
    runtime.thread.reset(toThread(state.messages));
  }, [serverCount, runtime, state]);

  const [purposeFor, setPurposeFor] = useState<Picked | null>(null);
  const [photo, setPhoto] = useState<{ uri: string; mimeType: string } | null>(null);
  const [instruction, setInstruction] = useState('');
  const vision = !!providers?.vision;
  const pickVideo = async (from: Picked['source']): Promise<Picked | null> => {
    if (from === 'recorded') {
      if (!(await ImagePicker.requestCameraPermissionsAsync()).granted) { toast('Camera access is off. Turn it on in the Settings app to record.', 'error'); return null; }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['videos'], videoMaxDuration: 45, videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium });
      const asset = result.canceled ? null : result.assets[0];
      return asset ? { uri: asset.uri, mimeType: asset.mimeType ?? 'video/quicktime', source: 'recorded' } : null;
    }
    if (from === 'file') {
      const result = await DocumentPicker.getDocumentAsync({ type: ['video/*'], copyToCacheDirectory: true });
      const asset = result.canceled ? null : result.assets[0];
      return asset ? { uri: asset.uri, mimeType: asset.mimeType ?? 'video/mp4', name: asset.name, source: 'file' } : null;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], videoMaxDuration: 180 });
    const asset = result.canceled ? null : result.assets[0];
    return asset ? { uri: asset.uri, mimeType: asset.mimeType ?? 'video/mp4', name: asset.fileName ?? undefined, source: 'library' } : null;
  };
  const sendVideo = async (video: Picked, purpose: 'household' | 'recipe') => {
    try {
      setWork('scan');
      await upload('/v1/scans', video.uri, 'video', video.mimeType, { purpose, source: video.source }, video.name);
      await refresh(); haptic.success(); dismissToast();
      go(purpose === 'recipe' ? 'tasks' : 'memory');
    } catch (error) { dismissToast(); toast((error as Error).message, 'error'); }
    finally { setWork(null); }
  };
  const startVideo = async (from: Picked['source']) => {
    try {
      const video = await pickVideo(from);
      if (!video) return;
      // A clip filmed in Aeri is a walkthrough; anything else might be a recipe, so ask once.
      if (from === 'recorded') void sendVideo(video, 'household'); else setPurposeFor(video);
    } catch (error) { toast((error as Error).message, 'error'); }
  };
  const startPhoto = async (camera: boolean) => {
    try {
      if (camera && !(await ImagePicker.requestCameraPermissionsAsync()).granted) { toast('Camera access is off. Turn it on in the Settings app to take a photo.', 'error'); return; }
      const result = camera ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      const asset = result.canceled ? null : result.assets[0];
      if (!asset) return;
      setInstruction(''); setPhoto({ uri: asset.uri, mimeType: asset.mimeType ?? 'image/jpeg' });
    } catch (error) { toast((error as Error).message, 'error'); }
  };
  const sendPhoto = async () => {
    if (!photo) return;
    const picked = photo; setPhoto(null);
    try {
      setWork('photo');
      await upload('/v1/photos', picked.uri, 'image', picked.mimeType, { instruction: instruction.trim() });
      await refresh(); haptic.success(); dismissToast(); go('tasks');
    } catch (error) { dismissToast(); toast((error as Error).message, 'error'); }
    finally { setWork(null); }
  };
  const onScan = () => ask({
    title: 'Show me where things are',
    message: vision ? 'Walk slowly past one fridge, pantry, shelf or closet for 20 to 40 seconds. Say anything that’s hard to see, like “two cartons of oat milk”. You confirm everything before I remember it.' : 'Video understanding isn’t connected yet, so you’ll see a sample map. Nothing is saved until you confirm it.',
    actions: [
      ...(Platform.OS === 'web' ? [] : [{ label: 'Record a video', icon: Video, onPress: () => void startVideo('recorded') }]),
      { label: 'Choose from your library', icon: Film, onPress: () => void startVideo('library') },
      { label: 'Choose from Files', detail: 'Videos saved, AirDropped or downloaded', icon: FileVideo, onPress: () => void startVideo('file') },
    ],
  });
  const onPhoto = () => ask({
    title: 'Find something from a photo',
    message: vision ? 'A clear shot of the label works best.' : 'Photo understanding isn’t connected yet, so you’ll see a sample product and sample stores.',
    actions: [
      ...(Platform.OS === 'web' ? [] : [{ label: 'Take a photo', icon: Camera, onPress: () => void startPhoto(true) }]),
      { label: 'Choose a photo', icon: ImageIcon, onPress: () => void startPhoto(false) },
    ],
  });
  const onAttach = () => ask({
    title: 'Show Aeri something',
    actions: [
      ...(Platform.OS === 'web' ? [] : [{ label: 'Record a video', detail: 'A shelf, fridge, pantry or closet', icon: Video, onPress: () => void startVideo('recorded') }]),
      { label: 'Choose a video', detail: 'From your library or Files', icon: Film, onPress: () => void startVideo('library') },
      { label: 'Find from a photo', detail: 'Same item, or something like it', icon: ScanSearch, onPress: onPhoto },
      { label: 'Paste a recipe link', detail: 'YouTube or a video file', icon: Link2, onPress: () => setLinkOpen(true) },
    ],
  });
  // After a spoken turn, show it in the thread with what Aeri did.
  const syncVoiceTurn = async () => {
    try {
      const latest = await request<{ state: { messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> } }>('/v1/bootstrap');
      if (!runtime.thread.getState().isRunning) runtime.thread.reset(toThread(latest.state.messages));
      await refresh();
    } catch { /* the next refresh catches up */ }
  };
  return <AssistantRuntimeProvider runtime={runtime}>
    <Conversation work={work} linkOpen={linkOpen} setLinkOpen={setLinkOpen} onAttach={onAttach} onScan={onScan} onPhoto={onPhoto} voice={!!providers?.voice} onVoice={() => { haptic.press(); setVoiceOpen(true); }} />
    <Sheet visible={!!purposeFor} onClose={() => setPurposeFor(null)} title="What’s in this video?" message="I read the two kinds differently.">
      {purposeFor && <ActionList onDone={() => setPurposeFor(null)} actions={[
        { label: 'Where things are at home', detail: 'Fridge, pantry, shelf or closet', icon: Video, onPress: () => void sendVideo(purposeFor, 'household') },
        { label: 'A recipe to cook', detail: 'I’ll list what you’re missing', icon: Clapperboard, onPress: () => void sendVideo(purposeFor, 'recipe') },
      ]} />}
    </Sheet>
    <Sheet visible={!!photo} onClose={() => setPhoto(null)} title="What do you want?" message="Say it however you like. I’ll also use your saved sizes, brands and stores.">
      {photo && <Image source={{ uri: photo.uri }} style={styles.photo} accessibilityLabel="Your photo" />}
      <Group style={{ marginTop: 14, backgroundColor: c.canvas }}>
        <Field label="Instruction (optional)" value={instruction} onChangeText={setInstruction} placeholder="Same brand, smallest size, under $20" returnKeyType="go" onSubmitEditing={() => void sendPhoto()} />
      </Group>
      <View style={styles.ideas}>{['Same brand', 'Cheapest nearby', 'Something like this'].map(idea => <Pressable key={idea} onPress={() => { haptic.tap(); setInstruction(idea); }} style={styles.idea}><Text style={[t.subhead, { color: c.accent, fontWeight: '600' }]}>{idea}</Text></Pressable>)}</View>
      <Button label="Find it" icon={ScanSearch} onPress={() => void sendPhoto()} style={{ marginTop: 16 }} />
    </Sheet>
    {voiceOpen && <VoiceMode visible onClose={() => setVoiceOpen(false)} onTurn={syncVoiceTurn} />}
  </AssistantRuntimeProvider>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 8 },
  messages: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16, flexGrow: 1 },
  welcome: { paddingTop: 36, paddingBottom: 12 },
  hint: { marginTop: 22, marginHorizontal: 4, color: c.ink2 },
  photo: { width: '100%', height: 180, borderRadius: radius.group, marginTop: 16, backgroundColor: c.tint },
  ideas: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  idea: { paddingHorizontal: 12, minHeight: 34, justifyContent: 'center', borderRadius: radius.pill, backgroundColor: c.tint },
  rowIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  userWrap: { alignSelf: 'flex-end', maxWidth: '82%' },
  userBubble: { backgroundColor: c.surface, borderRadius: 20, borderBottomRightRadius: 6, paddingHorizontal: 15, paddingVertical: 10, marginTop: 18, borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(15,43,64,0.1)' },
  userText: { ...t.callout, color: c.ink },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  linkIcon: { width: 32, height: 32, borderRadius: 9, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  assistant: { alignSelf: 'stretch', marginTop: 16, paddingRight: 20 },
  assistantText: { ...t.callout, lineHeight: 24, color: c.ink },
  errorBox: { flexDirection: 'row', gap: 10, backgroundColor: c.emberTint, borderRadius: 14, padding: 12, marginTop: 4 },
  retry: { alignSelf: 'flex-start', paddingVertical: 6, marginTop: 2 },
  dockWrap: { paddingHorizontal: 16, paddingBottom: 8 },
  dock: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: radius.pill, paddingHorizontal: 14, minHeight: 40 },
  dockAttention: { backgroundColor: c.sunriseTint },
  dockQuiet: { backgroundColor: c.tint },
  dockText: { ...t.footnote, color: c.ink2, flex: 1 },
  dockTitle: { fontWeight: '600', color: c.ink },
  more: { fontSize: 13, color: c.ink2 },
  composerWrap: { paddingHorizontal: 16 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', backgroundColor: c.surface, borderRadius: 26, padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: c.hairline, minHeight: 52 },
  plus: { width: 40, height: 40, borderRadius: 20, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, ...t.callout, ...noWebOutline, color: c.ink, maxHeight: 120, paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 10 : 9, paddingBottom: Platform.OS === 'ios' ? 10 : 9, minHeight: 40 },
  trailing: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  mic: { backgroundColor: c.fill },
  send: { backgroundColor: c.accent },
});
