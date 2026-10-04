import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import * as Speech from 'expo-speech';
import { AuiIf, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, type ChatModelAdapter, type ThreadMessageLike } from '@assistant-ui/react-native';
import { ArrowUp, Camera, Mic, Square, Sparkles } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { c } from '../lib/theme';

function Bubble() {
  const role = useAuiState(s => s.message.role);
  const user = role === 'user';
  return <MessagePrimitive.Root style={[styles.bubble, user ? styles.userBubble : styles.assistantBubble]}>
    {!user && <Text style={styles.bubbleLabel}>AERI</Text>}
    <MessagePrimitive.Content renderText={({ part }) => <Text style={[styles.bubbleText, user && { color: c.white }]}>{part.text}</Text>} />
  </MessagePrimitive.Root>;
}

function ChatThread({ onScan, onVoice, recording, busy }: { onScan: () => void; onVoice: () => void; recording: boolean; busy: boolean }) {
  return <View style={{ flex: 1 }}>
    <ThreadPrimitive.Root style={{ flex: 1 }}>
      <ThreadPrimitive.MessagesFlatList autoScroll contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 24, flexGrow: 1 }}
        ListHeaderComponent={<AuiIf condition={s => s.thread.isEmpty}>
          <View style={styles.emptyWrap}>
            <LinearGradient colors={['#DDF2FB', '#EDF8FD', '#FFFFFF']} style={styles.hero}>
              <View style={styles.heroGlow} /><View style={styles.heroGlowSmall} />
              <View style={styles.sparkle}><Sparkles size={25} color={c.blue} strokeWidth={1.7} /></View>
              <Text style={styles.heroTitle}>A little more ease{ '\n' }in your every day.</Text>
              <Text style={styles.heroSubtitle}>Share a recipe, show me your kitchen, or tell me what to remember. I’ll take it from there.</Text>
              <Pressable onPress={onScan} style={styles.scanButton}><Camera size={17} color={c.deep} strokeWidth={1.8} /><Text style={styles.scanText}>Scan my kitchen</Text></Pressable>
            </LinearGradient>
            <Text style={styles.tryTitle}>TRY ASKING</Text>
            <Text style={styles.tryExample}>“I have 3 eggs.”</Text>
            <Text style={styles.tryExample}>“Make a cart from this YouTube recipe.”</Text>
          </View>
        </AuiIf>}>
        {() => <Bubble />}
      </ThreadPrimitive.MessagesFlatList>
      <AuiIf condition={s => s.thread.isRunning}><View style={styles.thinking}><ActivityIndicator size="small" color={c.blue} /><Text style={styles.thinkingText}>Aeri is thinking</Text></View></AuiIf>
      <View style={styles.composerOuter}>
        <ComposerPrimitive.Root style={styles.composer}>
          <ComposerPrimitive.Input placeholder="Ask me anything..." placeholderTextColor="#8BA3B2" multiline style={styles.composerInput} />
          <ComposerPrimitive.Send style={styles.sendButton}><ArrowUp size={20} color={c.white} strokeWidth={2.2} /></ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
        <Pressable onPress={onVoice} disabled={busy} style={[styles.voiceButton, recording && { backgroundColor: '#FCE6E5' }]} accessibilityLabel={recording ? 'Stop voice note' : 'Record voice note'}>
          {recording ? <Square size={17} color={c.danger} fill={c.danger} /> : <Mic size={20} color={c.deep} strokeWidth={1.8} />}
        </Pressable>
      </View>
      <Text style={styles.composerHint}>{recording ? 'Recording — tap to send' : 'Your agent remembers what matters to you'}</Text>
    </ThreadPrimitive.Root>
  </View>;
}

export function AgentTab() {
  const { state, request, upload, refresh, providers } = useApp();
  const [busy, setBusy] = useState(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recording = useAudioRecorderState(recorder).isRecording;
  const initialMessages = useRef<ThreadMessageLike[]>(state?.messages.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: new Date(m.createdAt) })) ?? []);
  const adapter = useMemo<ChatModelAdapter>(() => ({
    async run({ messages }) {
      const last = messages[messages.length - 1];
      const text = last?.content.filter(part => part.type === 'text').map(part => part.text).join(' ') ?? '';
      const result = await request<{ reply: string }>('/v1/chat', { method: 'POST', body: JSON.stringify({ text }) });
      void refresh();
      return { content: [{ type: 'text', text: result.reply }] };
    },
  }), [request, refresh]);
  const runtime = useLocalRuntime(adapter, { initialMessages: initialMessages.current });
  const processVideo = async (camera: boolean) => {
    try {
      setBusy(true);
      const result = camera ? await ImagePicker.launchCameraAsync({ mediaTypes: ['videos'], videoMaxDuration: 40, videoQuality: 0 })
        : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'] });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        await upload('/v1/scans', asset.uri, 'video', asset.mimeType ?? 'video/mp4');
        await refresh();
        Alert.alert('Kitchen scan ready', 'Review the items in Memory before I remember them.');
      }
    } catch (error) { Alert.alert('Could not scan', (error as Error).message); }
    finally { setBusy(false); }
  };
  const onScan = () => Alert.alert('Show Aeri your kitchen', 'A short, steady video works best.', [
    { text: 'Record video', onPress: () => void processVideo(true) },
    { text: 'Choose video', onPress: () => void processVideo(false) },
    { text: 'Cancel', style: 'cancel' },
  ]);
  const onVoice = async () => {
    if (recording) {
      try {
        setBusy(true); await recorder.stop();
        if (recorder.uri) {
          const result = await upload<{ transcript: string; reply: string }>('/v1/voice', recorder.uri, 'audio', 'audio/m4a');
          const latest = await request<{ state: { messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; createdAt: string }> } }>('/v1/bootstrap');
          runtime.thread.reset(latest.state.messages.map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: new Date(m.createdAt) })));
          await refresh();
          Speech.speak(result.reply, { language: 'en-US', rate: .96 });
        }
      } catch (error) { Alert.alert('Voice note failed', (error as Error).message); }
      finally { setBusy(false); }
      return;
    }
    if (!providers?.gemini) { Alert.alert('Voice will be ready with a key', 'Add GEMINI_API_KEY on the server to transcribe voice notes. Text works now.'); return; }
    const permission = await AudioModule.requestRecordingPermissionsAsync();
    if (!permission.granted) { Alert.alert('Microphone access needed'); return; }
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync(); recorder.record();
  };
  return <AssistantRuntimeProvider runtime={runtime}><ChatThread onScan={onScan} onVoice={() => void onVoice()} recording={recording} busy={busy} /></AssistantRuntimeProvider>;
}

const styles = StyleSheet.create({
  emptyWrap: { flex: 1, justifyContent: 'center', paddingTop: 14, paddingBottom: 12 },
  hero: { borderRadius: 30, padding: 27, minHeight: 296, overflow: 'hidden', borderWidth: 1, borderColor: '#FFFFFF' },
  heroGlow: { position: 'absolute', width: 180, height: 180, borderRadius: 100, backgroundColor: '#B7E6F6', opacity: .5, right: -65, top: -50 },
  heroGlowSmall: { position: 'absolute', width: 80, height: 80, borderRadius: 45, backgroundColor: '#FFFFFF', opacity: .55, right: 35, top: 85 },
  sparkle: { width: 48, height: 48, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.75)', alignItems: 'center', justifyContent: 'center', marginBottom: 26 },
  heroTitle: { fontSize: 28, lineHeight: 34, letterSpacing: -.8, fontWeight: '600', color: c.deep, marginBottom: 13 },
  heroSubtitle: { fontSize: 14, lineHeight: 22, color: c.muted, maxWidth: 280, marginBottom: 27 },
  scanButton: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: '#FFFFFF', borderRadius: 100, paddingHorizontal: 17, paddingVertical: 13, shadowColor: '#9ACCDD', shadowOpacity: .15, shadowRadius: 12 },
  scanText: { fontSize: 14, fontWeight: '600', color: c.deep },
  tryTitle: { marginTop: 33, marginBottom: 12, color: c.muted, fontSize: 10, letterSpacing: 1.8, fontWeight: '700' },
  tryExample: { color: '#58788D', fontSize: 14, lineHeight: 27 },
  bubble: { paddingHorizontal: 17, paddingVertical: 13, borderRadius: 20, maxWidth: '87%', marginTop: 14 },
  userBubble: { alignSelf: 'flex-end', backgroundColor: c.blue, borderBottomRightRadius: 7 },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.92)', borderWidth: 1, borderColor: '#E4EFF4', borderBottomLeftRadius: 7 },
  bubbleLabel: { fontSize: 9, fontWeight: '800', color: c.blue, letterSpacing: 1.5, marginBottom: 6 },
  bubbleText: { fontSize: 15, lineHeight: 22, color: c.deep },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 26, paddingVertical: 5 }, thinkingText: { color: c.muted, fontSize: 12 },
  composerOuter: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 16, paddingTop: 12 },
  composer: { flex: 1, minHeight: 54, maxHeight: 110, flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', borderRadius: 25, paddingLeft: 18, paddingRight: 5, borderWidth: 1, borderColor: '#E2EDF3', shadowColor: '#88B6CA', shadowOpacity: .12, shadowRadius: 18, shadowOffset: { width: 0, height: 5 } },
  composerInput: { flex: 1, fontSize: 15, color: c.deep, maxHeight: 90, paddingVertical: 12 },
  sendButton: { width: 43, height: 43, borderRadius: 22, backgroundColor: c.blue, alignItems: 'center', justifyContent: 'center' },
  voiceButton: { width: 54, height: 54, borderRadius: 26, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2EDF3', alignItems: 'center', justifyContent: 'center' },
  composerHint: { textAlign: 'center', fontSize: 10, color: '#93AAB7', paddingTop: 8, paddingBottom: 11 },
});
