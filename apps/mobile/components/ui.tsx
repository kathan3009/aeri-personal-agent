import { Children, Fragment, isValidElement, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { AccessibilityInfo, ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { BlurView } from 'expo-blur';
import { Check, ChevronRight, Minus, Plus } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptic } from '../lib/haptics';
import { c, lift, radius, t } from '../lib/theme';

const nativeDriver = Platform.OS !== 'web';
/** The browser preview draws a focus rectangle around text fields; the grouped field already shows focus with its caret. */
export const noWebOutline = Platform.select({ web: { outlineStyle: 'none' } as object, default: {} });
export const liquidGlass = Platform.OS === 'ios' && isGlassEffectAPIAvailable() && isLiquidGlassAvailable();
export type Icon = ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

/** Aeri's presence. Still when idle; it only moves while Aeri is working or listening. */
export function Aura({ size = 28, mode = 'idle' }: { size?: number; mode?: 'idle' | 'thinking' | 'listening' | 'speaking' }) {
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  const breathe = useRef(new Animated.Value(0)).current;
  const ripple = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || mode === 'idle') { spin.setValue(0); breathe.setValue(0); ripple.setValue(0); return; }
    const ease = Easing.inOut(Easing.sin);
    const loops = [
      Animated.loop(Animated.timing(spin, { toValue: 1, duration: 2600, easing: Easing.linear, useNativeDriver: nativeDriver })),
      Animated.loop(Animated.sequence([
        Animated.timing(breathe, { toValue: 1, duration: 1100, easing: ease, useNativeDriver: nativeDriver }),
        Animated.timing(breathe, { toValue: 0, duration: 1100, easing: ease, useNativeDriver: nativeDriver }),
      ])),
    ];
    if (mode === 'listening') loops.push(Animated.loop(Animated.timing(ripple, { toValue: 1, duration: 1500, easing: Easing.out(Easing.quad), useNativeDriver: nativeDriver })));
    loops.forEach(loop => loop.start());
    return () => loops.forEach(loop => loop.stop());
  }, [mode, reduced, spin, breathe, ripple]);
  const round = { width: size, height: size, borderRadius: size / 2 };
  const glow: ViewStyle = size >= 40 ? Platform.select({ web: { boxShadow: `0 ${size / 6}px ${size / 2}px rgba(43,132,202,0.28)` } as ViewStyle, default: { shadowColor: '#2B84CA', shadowOpacity: 0.28, shadowRadius: size / 3, shadowOffset: { width: 0, height: size / 6 } } }) : {};
  return <View style={[round, glow]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {mode === 'listening' && <Animated.View style={[StyleSheet.absoluteFill, round, { borderWidth: 2, borderColor: c.accent, opacity: ripple.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }), transform: [{ scale: ripple.interpolate({ inputRange: [0, 1], outputRange: [1, 1.8] }) }] }]} />}
    <Animated.View style={[round, { overflow: 'hidden', transform: [{ scale: breathe.interpolate({ inputRange: [0, 1], outputRange: [1, mode === 'listening' ? 1.1 : 1.06] }) }] }]}>
      <LinearGradient colors={['#E2F3FE', '#9FD0F3', '#4E9BDA']} start={{ x: 0.15, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }]}>
        <LinearGradient colors={['rgba(255,255,255,0.95)', 'rgba(255,255,255,0.35)', 'rgba(255,255,255,0)']} start={{ x: 0.25, y: 0.1 }} end={{ x: 0.75, y: 0.9 }} style={{ position: 'absolute', width: size * 0.78, height: size * 0.78, borderRadius: size, top: -size * 0.02, left: size * 0.02 }} />
      </Animated.View>
      <View style={[StyleSheet.absoluteFill, { borderRadius: size / 2, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: 'rgba(255,255,255,0.6)' }]} />
    </Animated.View>
  </View>;
}

type ButtonProps = { label: string; onPress: () => void; icon?: Icon; loading?: boolean; disabled?: boolean; tone?: 'primary' | 'secondary' | 'plain' | 'destructive'; style?: StyleProp<ViewStyle>; accessibilityHint?: string };
export function Button({ label, onPress, icon: IconView, loading, disabled, tone = 'primary', style, accessibilityHint }: ButtonProps) {
  const fg = tone === 'primary' ? c.white : tone === 'destructive' ? c.ember : c.accent;
  const bg = tone === 'primary' ? c.accent : tone === 'secondary' ? c.tint : 'transparent';
  const inactive = disabled || loading;
  return <Pressable onPress={() => { haptic.press(); onPress(); }} disabled={inactive} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={accessibilityHint} accessibilityState={{ disabled: !!inactive, busy: !!loading }}
    style={({ pressed }) => [styles.button, { backgroundColor: pressed && tone === 'primary' ? c.accentPressed : bg }, (tone === 'plain' || tone === 'destructive') && styles.plainButton, disabled && { opacity: 0.4 }, pressed && { transform: [{ scale: 0.985 }] }, style]}>
    {loading ? <ActivityIndicator color={fg} /> : <>
      {IconView && <IconView size={18} color={fg} strokeWidth={2} />}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </>}
  </Pressable>;
}

/** Deliberate consent: the action only happens after a sustained press. Screen readers get a direct action. */
export function HoldButton({ label, holdingLabel = 'Keep holding', doneLabel = 'Approved', onConfirm, disabled, duration = 900, accessibilityLabel, style }: { label: string; holdingLabel?: string; doneLabel?: string; onConfirm: () => Promise<boolean>; disabled?: boolean; duration?: number; accessibilityLabel: string; style?: StyleProp<ViewStyle> }) {
  const progress = useRef(new Animated.Value(0)).current;
  const phaseRef = useRef<'idle' | 'holding' | 'done'>('idle');
  const [phase, setPhase] = useState<'idle' | 'holding' | 'done'>('idle');
  const run = useRef<Animated.CompositeAnimation | null>(null);
  const set = (next: typeof phaseRef.current) => { phaseRef.current = next; setPhase(next); };
  const confirm = async () => {
    set('done'); haptic.success();
    const ok = await onConfirm();
    if (!ok) { set('idle'); Animated.timing(progress, { toValue: 0, duration: 200, useNativeDriver: false }).start(); }
  };
  const start = () => {
    if (disabled || phaseRef.current !== 'idle') return;
    haptic.press(); set('holding');
    run.current = Animated.timing(progress, { toValue: 1, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: false });
    run.current.start(({ finished }) => { if (finished && phaseRef.current === 'holding') void confirm(); });
  };
  const cancel = () => {
    if (phaseRef.current !== 'holding') return;
    run.current?.stop(); set('idle');
    Animated.spring(progress, { toValue: 0, damping: 18, stiffness: 240, useNativeDriver: false }).start();
  };
  return <Pressable onPressIn={start} onPressOut={cancel} disabled={disabled} accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityHint="Press and hold to approve"
    accessibilityState={{ disabled: !!disabled, busy: phase === 'done' }} accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'activate' && phaseRef.current === 'idle') { progress.setValue(1); void confirm(); } }}
    style={[styles.button, styles.hold, disabled && { opacity: 0.4 }, phase === 'holding' && { transform: [{ scale: 0.985 }] }, style]}>
    <Animated.View style={[styles.holdFill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }]} />
    {phase === 'done' ? <><PopIn><Check size={18} color={c.white} strokeWidth={2.4} /></PopIn><Text style={styles.buttonText}>{doneLabel}</Text></>
      : <Text style={styles.buttonText}>{phase === 'holding' ? holdingLabel : label}</Text>}
  </Pressable>;
}

/** Liquid Glass on iOS 26+, the system chrome material on earlier iPhones, and an opaque surface elsewhere. */
function PopIn({ children }: { children: ReactNode }) {
  const scale = useRef(new Animated.Value(0.3)).current;
  useEffect(() => { Animated.spring(scale, { toValue: 1, damping: 8, stiffness: 280, mass: 0.6, useNativeDriver: nativeDriver }).start(); }, [scale]);
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

export function Glass({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  // Tinted enough that text scrolling underneath never competes with the tab labels.
  if (liquidGlass) return <GlassView glassEffectStyle="regular" tintColor="rgba(242,247,251,0.82)" style={style}>{children}</GlassView>;
  if (Platform.OS === 'ios') return <View style={[lift, style, { overflow: 'visible' }]}>
    <BlurView intensity={80} tint="systemChromeMaterialLight" style={[StyleSheet.absoluteFill, styles.blur, { borderRadius: StyleSheet.flatten(style)?.borderRadius ?? 0 }]} />
    {children}
  </View>;
  return <View style={[styles.glassFallback, lift, style]}>{children}</View>;
}

/** Inset-grouped list. `inset` lines separators up with the text column, as iOS does. */
export function Group({ children, style, inset = 16 }: { children: ReactNode; style?: StyleProp<ViewStyle>; inset?: number }) {
  const items = Children.toArray(children).filter(isValidElement);
  return <View style={[styles.group, style]}>{items.map((child, index) => <Fragment key={child.key ?? index}>{index > 0 && <View style={[styles.separator, { marginLeft: inset }]} />}{child}</Fragment>)}</View>;
}

export function Row({ title, subtitle, left, right, onPress, chevron, accessibilityLabel, tone }: { title: string; subtitle?: string; left?: ReactNode; right?: ReactNode; onPress?: () => void; chevron?: boolean; accessibilityLabel?: string; tone?: 'default' | 'muted' }) {
  const body = <>
    {left}
    <View style={{ flex: 1 }}>
      <Text style={[t.callout, tone === 'muted' && { color: c.ink2 }]} numberOfLines={2}>{title}</Text>
      {!!subtitle && <Text style={[t.footnote, { marginTop: 2 }]} numberOfLines={3}>{subtitle}</Text>}
    </View>
    {right}
    {chevron && <ChevronRight size={18} color={c.ink3} strokeWidth={2} />}
  </>;
  if (!onPress) return <View style={styles.row} accessible accessibilityLabel={accessibilityLabel}>{body}</View>;
  return <Pressable onPress={() => { haptic.tap(); onPress(); }} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.fill }]}>{body}</Pressable>;
}

export function SectionHeader({ title, action, onAction, actionLabel }: { title: string; action?: string; onAction?: () => void; actionLabel?: string }) {
  return <View style={styles.sectionHeader}>
    <Text style={t.title3} accessibilityRole="header">{title}</Text>
    {action && onAction && <Pressable onPress={() => { haptic.tap(); onAction(); }} hitSlop={10} accessibilityRole="button" accessibilityLabel={actionLabel ?? action}><Text style={styles.sectionAction}>{action}</Text></Pressable>}
  </View>;
}

export function Tag({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'sample' | 'leaf' | 'attention' }) {
  const palette = { neutral: [c.tint, c.ink2], sample: [c.sunriseTint, '#875810'], leaf: [c.leafTint, c.leaf], attention: [c.sunriseTint, '#875810'] }[tone];
  return <View style={[styles.tag, { backgroundColor: palette[0] }]}><Text style={[styles.tagText, { color: palette[1] }]}>{label}</Text></View>;
}

export function Dot({ color = c.sunrise, size = 8 }: { color?: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Stepper({ value, onChange, min = 1, max = 24, disabled, label }: { value: number; onChange: (next: number) => void; min?: number; max?: number; disabled?: boolean; label: string }) {
  const step = (delta: number) => { const next = Math.min(max, Math.max(min, value + delta)); if (next !== value) { haptic.tap(); onChange(next); } };
  return <View style={styles.stepper} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ now: value, min, max }}
    accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={event => step(event.nativeEvent.actionName === 'increment' ? 1 : -1)}>
    <Pressable onPress={() => step(-1)} disabled={disabled || value <= min} hitSlop={6} style={[styles.stepButton, (disabled || value <= min) && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={`Fewer ${label.toLowerCase()}`}><Minus size={16} color={c.accent} strokeWidth={2.4} /></Pressable>
    <Text style={[t.number, styles.stepValue]}>{value}</Text>
    <Pressable onPress={() => step(1)} disabled={disabled || value >= max} hitSlop={6} style={[styles.stepButton, (disabled || value >= max) && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={`More ${label.toLowerCase()}`}><Plus size={16} color={c.accent} strokeWidth={2.4} /></Pressable>
  </View>;
}

export function Field({ label, style, ...props }: TextInputProps & { label: string }) {
  return <View style={styles.field}>
    <Text style={styles.fieldLabel}>{label}</Text>
    <TextInput placeholderTextColor={c.ink3} accessibilityLabel={label} {...props} style={[styles.fieldInput, style]} />
  </View>;
}

export function Sheet({ visible, onClose, title, message, children }: { visible: boolean; onClose: () => void; title?: string; message?: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!visible) return;
    y.setValue(1);
    Animated.spring(y, { toValue: 0, damping: 24, stiffness: 260, mass: 0.9, useNativeDriver: nativeDriver }).start();
  }, [visible, y]);
  return <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetWrap}>
      <Pressable style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
      <Animated.View accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) + 10, transform: [{ translateY: y.interpolate({ inputRange: [0, 1], outputRange: [0, 480] }) }] }]}>
        <View style={styles.grabber} />
        {!!title && <Text style={t.title3} accessibilityRole="header">{title}</Text>}
        {!!message && <Text style={[t.subhead, { marginTop: 6 }]}>{message}</Text>}
        {children}
      </Animated.View>
    </KeyboardAvoidingView>
  </Modal>;
}

export type SheetAction = { label: string; detail?: string; icon?: Icon; tone?: 'default' | 'destructive'; onPress: () => void };
export function ActionList({ actions, onDone }: { actions: SheetAction[]; onDone: () => void }) {
  return <Group style={{ marginTop: 18, backgroundColor: c.canvas }}>
    {actions.map(action => {
      const IconView = action.icon;
      const color = action.tone === 'destructive' ? c.ember : c.accent;
      return <Row key={action.label} title={action.label} subtitle={action.detail} onPress={() => { onDone(); setTimeout(action.onPress, Platform.OS === 'ios' ? 380 : 60); }}
        left={IconView && <View style={[styles.actionIcon, { backgroundColor: action.tone === 'destructive' ? c.emberTint : c.tint }]}><IconView size={19} color={color} strokeWidth={1.9} /></View>} />;
    })}
  </Group>;
}

const styles = StyleSheet.create({
  button: { minHeight: 50, borderRadius: radius.pill, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  plainButton: { minHeight: 44, paddingHorizontal: 8 },
  buttonText: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2, color: c.white },
  hold: { backgroundColor: c.accent, overflow: 'hidden' },
  holdFill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: '#0E4F80' },
  glassFallback: { backgroundColor: 'rgba(255,255,255,0.96)', borderWidth: StyleSheet.hairlineWidth, borderColor: c.hairline },
  blur: { overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.7)' },
  group: { backgroundColor: c.surface, borderRadius: radius.group, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(15,43,64,0.12)' },
  row: { minHeight: 52, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 30, marginBottom: 10, paddingHorizontal: 4 },
  sectionAction: { fontSize: 17, color: c.accent, fontWeight: '400' },
  tag: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 },
  tagText: { fontSize: 12, lineHeight: 16, fontWeight: '600' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  stepButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: c.tint, alignItems: 'center', justifyContent: 'center' },
  stepValue: { minWidth: 32, textAlign: 'center', fontSize: 17 },
  field: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 4 },
  fieldLabel: { fontSize: 13, color: c.ink2 },
  fieldInput: { fontSize: 17, color: c.ink, paddingVertical: 8, minHeight: 40, ...noWebOutline },
  sheetWrap: { flex: 1, justifyContent: 'flex-end' },
  scrim: { backgroundColor: 'rgba(15,43,64,0.3)' },
  sheet: { backgroundColor: c.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingHorizontal: 20, paddingTop: 10 },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, backgroundColor: 'rgba(15,43,64,0.16)', marginBottom: 16 },
  actionIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
});
