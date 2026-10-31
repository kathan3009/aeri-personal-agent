import { useEffect, useRef, useState } from 'react';
import { Animated, AppState, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState, type RecordingOptions } from 'expo-audio';
import * as Speech from 'expo-speech';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { haptic } from '../lib/haptics';
import { c, radius, skyFor, t } from '../lib/theme';
import { Aura, useReducedMotion } from './ui';

type Phase = 'off' | 'starting' | 'listening' | 'thinking' | 'speaking' | 'paused';
type Turn = { you: string; aeri: string };

// Speech only needs a small mono file; it uploads faster and stays under the transcription limit.
const options: RecordingOptions = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, sampleRate: 22050, bitRate: 64000, isMeteringEnabled: true };
const nativeDriver = Platform.OS !== 'web';
const SILENCE_MS = 1300;     // a pause this long ends your turn
const WAIT_MS = 9000;        // stop listening if nothing is said
const LONGEST_MS = 60000;    // one turn never runs longer than this

/** The clearest installed English voice: Premium, then Enhanced, then the system default. */
async function bestVoice() {
  try {
    const voices = (await Speech.getAvailableVoicesAsync()).filter(v => v.language.startsWith('en-US') || v.language.startsWith('en_US'));
    const rank = (v: Speech.Voice) => /premium/i.test(v.identifier) ? 2 : v.quality === Speech.VoiceQuality.Enhanced ? 1 : 0;
    return voices.sort((a, b) => rank(b) - rank(a))[0]?.identifier;
  } catch { return undefined; }
}

const sayable = (text: string) => text.replace(/\*\*/g, '').replace(/https?:\/\/\S+/g, 'the link in the chat');

/**
 * Hands-free conversation: Aeri listens, notices when you stop, answers out loud, then listens again.
 * Expo Go can't stream audio both ways, so each turn is a short recording sent when you pause.
 */
export function VoiceMode({ visible, onClose, onTurn }: { visible: boolean; onClose: () => void; onTurn: () => Promise<void> }) {
  const { upload, providers } = useApp();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const recorder = useAudioRecorder(options);
  const status = useAudioRecorderState(recorder, 90);
  const [phase, setPhase] = useState<Phase>('off');
  const [heard, setHeard] = useState(false);
  // Without audio levels the turn can't end itself, so the person taps when done.
  const [manual, setManual] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const phaseRef = useRef<Phase>('off');
  const session = useRef(0);
  const misses = useRef(0);
  const voice = useRef<string | undefined>(undefined);
  const vad = useRef({ started: 0, floor: 0, loud: 0, lastLoud: 0, heard: false });
  const level = useRef(new Animated.Value(0)).current;
  const scroll = useRef<ScrollView>(null);
  const set = (next: Phase) => { phaseRef.current = next; setPhase(next); };

  useEffect(() => { void bestVoice().then(id => { voice.current = id; }); }, []);

  const quietAudio = () => setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => undefined);
  // On unmount Expo may release the native recorder before this cleanup runs; even reading `isRecording` then throws.
  const stopRecording = async () => { try { if (recorder.isRecording) await recorder.stop(); } catch { /* already released */ } };

  const pause = async (message?: string) => {
    set('paused'); setNote(message ?? null);
    await stopRecording(); await quietAudio();
  };

  const listen = async () => {
    const mine = session.current;
    set('starting'); setNote(null); setHeard(false);
    try {
      await Speech.stop().catch(() => undefined);
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (mine !== session.current) return;
      if (!permission.granted) return void pause('Microphone access is off. Turn it on in the Settings app to talk with Aeri.');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      if (mine !== session.current) return void stopRecording();
      recorder.record();
      vad.current = { started: Date.now(), floor: 0, loud: 0, lastLoud: 0, heard: false };
      haptic.press(); set('listening');
    } catch (error) { if (mine === session.current) void pause((error as Error).message); }
  };

  const speak = (reply: string, mine: number) => {
    set('speaking');
    // Recording mode routes sound to the earpiece on iPhone; Aeri speaks through the speaker.
    void quietAudio().then(() => {
      if (mine !== session.current) return;
      Speech.speak(sayable(reply), {
        language: 'en-US', voice: voice.current, rate: 1.0,
        onDone: () => { if (mine === session.current && phaseRef.current === 'speaking') void listen(); },
        onError: () => { if (mine === session.current) void pause(); },
      });
    });
  };

  const send = async () => {
    const mine = session.current;
    if (phaseRef.current !== 'listening') return;
    set('thinking'); haptic.tap(); level.setValue(0);
    try {
      await recorder.stop(); await quietAudio();
      if (!recorder.uri) throw new Error('No audio was captured. Try again.');
      const result = await upload<{ transcript: string; reply: string }>('/v1/voice', recorder.uri, 'audio', 'audio/m4a');
      if (mine !== session.current) return;
      misses.current = 0;
      setTurns(prior => [...prior.slice(-5), { you: result.transcript, aeri: result.reply }]);
      void onTurn();
      speak(result.reply, mine);
    } catch (error) {
      if (mine !== session.current) return;
      const message = (error as Error).message;
      if (/no speech/i.test(message) && misses.current < 2) { misses.current += 1; await listen(); setNote('I didn’t catch that. Please say it again.'); return; }
      void pause(message.replace(/^Neon AI Gateway: /, ''));
    }
  };

  // Turn-taking: learn the room's noise for half a second, then end the turn after a pause in speech.
  useEffect(() => {
    if (phase !== 'listening') return;
    const v = vad.current, now = Date.now(), elapsed = now - v.started;
    if (status.metering == null) { if (elapsed > 1200 && !manual) setManual(true); if (elapsed > LONGEST_MS) void send(); return; }
    const db = status.metering;
    if (!reduced) Animated.timing(level, { toValue: Math.max(0, Math.min(1, (db + 52) / 40)), duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: nativeDriver }).start();
    if (elapsed < 500) { v.floor = v.floor === 0 ? db : Math.min(v.floor, db); return; }
    const threshold = Math.min(-24, Math.max(-46, v.floor + 13));
    if (db > threshold) { v.loud += 1; v.lastLoud = now; if (!v.heard && v.loud >= 2) { v.heard = true; setHeard(true); } }
    else v.loud = 0;
    if (v.heard && now - v.lastLoud > SILENCE_MS) void send();
    else if (!v.heard && elapsed > WAIT_MS) void pause('Tap the circle when you’re ready to talk.');
    else if (elapsed > LONGEST_MS) void send();
  }, [status.metering, status.durationMillis, phase]);

  // Opening starts a conversation; closing ends it and releases the microphone.
  useEffect(() => {
    if (!visible) return;
    session.current += 1; misses.current = 0; setTurns([]);
    if (providers?.voice) void listen();
    else { set('paused'); setNote('Voice isn’t available right now. You can type, or use your keyboard’s dictation.'); }
    const sub = AppState.addEventListener('change', next => { if (next !== 'active' && phaseRef.current !== 'paused') { session.current += 1; void Speech.stop(); void pause(); } });
    return () => {
      sub.remove(); session.current += 1; set('off');
      void Speech.stop().catch(() => undefined); void stopRecording().then(quietAudio);
    };
  }, [visible]);

  const tapOrb = () => {
    const p = phaseRef.current;
    if (p === 'listening') { if (Date.now() - vad.current.started > 800) void send(); }
    else if (p === 'speaking') { session.current += 1; void Speech.stop(); void listen(); }
    else if (p === 'paused' && providers?.voice) { session.current += 1; misses.current = 0; void listen(); }
  };

  const caption = { off: '', starting: 'Getting ready…', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', paused: 'Paused' }[phase];
  const hint = note ?? { off: '', starting: '', listening: manual ? 'Tap the circle when you’re done.' : heard ? 'Pause when you’re done, or tap to send now.' : 'Tell Aeri what you have, need or want remembered.', thinking: 'Working on it.', speaking: 'Tap the circle to interrupt.', paused: 'Tap the circle to talk.' }[phase];
  const orbLabel = { off: '', starting: 'Getting ready', listening: 'Send now', thinking: 'Thinking', speaking: 'Interrupt and talk', paused: 'Start talking' }[phase];
  const sky = skyFor();

  return <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose} statusBarTranslucent>
    <View style={[styles.root, { paddingTop: insets.top + 6, paddingBottom: Math.max(insets.bottom, 16) + 8 }]}>
      <LinearGradient pointerEvents="none" colors={[sky[0], sky[1], c.canvas]} locations={[0, 0.5, 1]} style={StyleSheet.absoluteFill} />
      <View style={styles.top}>
        <Text style={t.headline}>Talk with Aeri</Text>
        <Pressable onPress={() => { haptic.tap(); onClose(); }} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="End conversation">
          <X size={20} color={c.ink} strokeWidth={2.2} />
        </Pressable>
      </View>

      <ScrollView ref={scroll} style={styles.turns} contentContainerStyle={styles.turnsContent} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} showsVerticalScrollIndicator={false}>
        {turns.length === 0 && <Text style={styles.prompt}>Speak naturally. For example: “We’re out of oat milk,” “Where are the batteries?” or “Add AA batteries to my list.”</Text>}
        {turns.map((turn, index) => {
          const latest = index === turns.length - 1;
          return <View key={index} style={[styles.turn, !latest && { opacity: 0.45 }]}>
            <Text style={styles.you} selectable>{turn.you}</Text>
            <Text style={latest ? styles.aeri : styles.aeriOld} selectable>{turn.aeri}</Text>
          </View>;
        })}
      </ScrollView>

      <View style={styles.stage}>
        <Pressable onPress={tapOrb} disabled={phase === 'thinking' || phase === 'starting' || phase === 'off'} accessibilityRole="button" accessibilityLabel={orbLabel} style={styles.orbHit}>
          <Animated.View pointerEvents="none" style={[styles.ring, { opacity: phase === 'listening' ? level.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.7] }) : 0, transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] }) }] }]} />
          <Aura size={148} mode={phase === 'listening' ? 'listening' : phase === 'thinking' || phase === 'starting' ? 'thinking' : phase === 'speaking' ? 'speaking' : 'idle'} />
        </Pressable>
        <Text style={styles.caption} accessibilityLiveRegion="polite">{caption}</Text>
        <Text style={[styles.hint, note && phase === 'paused' && { color: c.ember }]}>{hint}</Text>
      </View>

      <Pressable onPress={() => { haptic.tap(); onClose(); }} style={({ pressed }) => [styles.end, pressed && { opacity: 0.7 }]} accessibilityRole="button" accessibilityLabel="End conversation">
        <Text style={styles.endText}>End</Text>
      </Pressable>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: c.canvas, paddingHorizontal: 24 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  close: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center' },
  turns: { flex: 1, marginTop: 8 },
  turnsContent: { flexGrow: 1, justifyContent: 'flex-end', paddingVertical: 12, gap: 22 },
  prompt: { ...t.title3, fontWeight: '400', color: c.ink2, lineHeight: 28 },
  turn: { gap: 8 },
  you: { ...t.callout, color: c.ink2 },
  aeri: { fontSize: 24, lineHeight: 31, fontWeight: '500', letterSpacing: -0.4, color: c.ink },
  aeriOld: { ...t.body, color: c.ink },
  stage: { alignItems: 'center', paddingTop: 12, paddingBottom: 18 },
  orbHit: { width: 220, height: 220, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 148, height: 148, borderRadius: 74, backgroundColor: 'rgba(78,155,218,0.35)' },
  caption: { ...t.title3, marginTop: 6, textAlign: 'center' },
  hint: { ...t.subhead, marginTop: 6, textAlign: 'center', maxWidth: 300, minHeight: 40 },
  end: { alignSelf: 'center', minWidth: 140, minHeight: 50, borderRadius: radius.pill, backgroundColor: c.emberTint, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  endText: { fontSize: 17, fontWeight: '600', color: c.ember },
});
