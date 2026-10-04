import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Animated, Platform, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CircleAlert, CircleCheck } from 'lucide-react-native';
import { ActionList, Sheet, type SheetAction } from '../components/ui';
import { c, lift, t } from './theme';

type Tone = 'info' | 'success' | 'error' | 'working';
type Toast = { id: number; text: string; tone: Tone };
type Ask = { title: string; message?: string; actions: SheetAction[] };
type FeedbackValue = { toast: (text: string, tone?: Tone) => void; dismissToast: () => void; ask: (sheet: Ask) => void };
const Context = createContext<FeedbackValue | null>(null);
const nativeDriver = Platform.OS !== 'web';

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState<Toast | null>(null);
  const [sheet, setSheet] = useState<Ask | null>(null);
  const y = useRef(new Animated.Value(0)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const counter = useRef(0);
  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    Animated.timing(y, { toValue: 0, duration: 220, useNativeDriver: nativeDriver }).start(({ finished }) => { if (finished) setCurrent(null); });
  }, [y]);
  const toast = useCallback((text: string, tone: Tone = 'info') => {
    if (timer.current) clearTimeout(timer.current);
    setCurrent({ id: ++counter.current, text, tone });
    Animated.spring(y, { toValue: 1, damping: 20, stiffness: 240, useNativeDriver: nativeDriver }).start();
    if (tone !== 'working') timer.current = setTimeout(hide, tone === 'error' ? 5200 : 2800);
  }, [hide, y]);
  const value = useMemo(() => ({ toast, dismissToast: hide, ask: setSheet }), [toast, hide]);
  const ToneIcon = current?.tone === 'error' ? CircleAlert : CircleCheck;
  return <Context.Provider value={value}>
    {children}
    {current && <View pointerEvents="box-none" style={[StyleSheet.absoluteFill, { alignItems: 'center' }]}>
      <Animated.View accessibilityLiveRegion="polite" accessibilityRole="alert" style={[styles.toast, lift, { top: insets.top + 8, opacity: y, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [-24, 0] }) }, { scale: y.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }]}>
        {current.tone === 'working' ? <ActivityIndicator size="small" color={c.accent} /> : current.tone !== 'info' && <ToneIcon size={18} color={current.tone === 'error' ? c.ember : c.leaf} strokeWidth={2.2} />}
        <Text style={[t.subhead, styles.toastText]}>{current.text}</Text>
      </Animated.View>
    </View>}
    <Sheet visible={!!sheet} onClose={() => setSheet(null)} title={sheet?.title} message={sheet?.message}>
      {sheet && <ActionList actions={sheet.actions} onDone={() => setSheet(null)} />}
    </Sheet>
  </Context.Provider>;
}

export function useFeedback() { const value = useContext(Context); if (!value) throw new Error('FeedbackProvider missing'); return value; }

const styles = StyleSheet.create({
  toast: { position: 'absolute', maxWidth: 360, marginHorizontal: 20, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: 'rgba(255,255,255,0.98)', borderRadius: 22, paddingHorizontal: 16, paddingVertical: 11, borderWidth: StyleSheet.hairlineWidth, borderColor: c.hairline },
  toastText: { color: c.ink, flexShrink: 1, fontWeight: '500' },
});
