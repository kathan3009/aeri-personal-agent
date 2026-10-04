import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { c } from '../lib/theme';
import { Aura, useReducedMotion } from './ui';

const nativeDriver = Platform.OS !== 'web';
const settle = { damping: 18, stiffness: 170, mass: 0.9, useNativeDriver: nativeDriver };

/** Fades and rises content in once, after an optional delay. Shows immediately with Reduce Motion. */
export function Reveal({ children, delay = 0, distance = 14, style, from = 'below', pointerEvents }: { children: ReactNode; delay?: number; distance?: number; style?: StyleProp<ViewStyle>; from?: 'below' | 'scale'; pointerEvents?: 'box-none' | 'auto' }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) { progress.setValue(1); return; }
    const run = Animated.sequence([Animated.delay(delay), Animated.spring(progress, { toValue: 1, ...settle })]);
    run.start();
    return () => run.stop();
  }, [delay, progress, reduced]);
  const transform = from === 'scale'
    ? [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }]
    : [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }];
  return <Animated.View pointerEvents={pointerEvents} style={[style, { opacity: progress.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0, 1, 1] }), transform }]}>{children}</Animated.View>;
}

/** Letters rise into place one after another. Screen readers hear the whole word once. */
export function Wordmark({ text, style, delay = 0, stagger = 55 }: { text: string; style: StyleProp<TextStyle>; delay?: number; stagger?: number }) {
  const reduced = useReducedMotion();
  const letters = useRef(text.split('').map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduced) { letters.forEach(value => value.setValue(1)); return; }
    const run = Animated.stagger(stagger, letters.map(value => Animated.spring(value, { toValue: 1, damping: 14, stiffness: 160, mass: 0.8, useNativeDriver: nativeDriver })));
    const timer = setTimeout(() => run.start(), delay);
    return () => { clearTimeout(timer); run.stop(); };
  }, [delay, letters, reduced, stagger]);
  return <View style={styles.word} accessible accessibilityRole="header" accessibilityLabel={text}>
    {text.split('').map((letter, index) => <Animated.Text key={index} importantForAccessibility="no" style={[style, {
      opacity: letters[index],
      transform: [{ translateY: letters[index].interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }, { scale: letters[index].interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }],
    }]}>{letter}</Animated.Text>)}
  </View>;
}

/** Words of a sentence settle in sequence; used for the greeting. */
export function RevealWords({ text, style, delay = 0, stagger = 70 }: { text: string; style: StyleProp<TextStyle>; delay?: number; stagger?: number }) {
  const reduced = useReducedMotion();
  const words = text.split(' ');
  const values = useRef(words.map(() => new Animated.Value(0))).current;
  useEffect(() => {
    if (reduced) { values.forEach(value => value.setValue(1)); return; }
    const run = Animated.sequence([Animated.delay(delay), Animated.stagger(stagger, values.map(value => Animated.spring(value, { toValue: 1, ...settle })))]);
    run.start();
    return () => run.stop();
  }, [delay, reduced, stagger, values]);
  return <Text style={style} accessibilityRole="header">
    {words.map((word, index) => <Animated.Text key={index} style={{ opacity: values[index] }}>{word}{index < words.length - 1 ? ' ' : ''}</Animated.Text>)}
  </Text>;
}

/** Aeri's logo moment: the aura blooms while two rings of light diffuse outward. */
export function Bloom({ size = 72, delay = 0, mode = 'idle' }: { size?: number; delay?: number; mode?: 'idle' | 'thinking' }) {
  const reduced = useReducedMotion();
  const core = useRef(new Animated.Value(0)).current;
  const rings = useRef([new Animated.Value(0), new Animated.Value(0)]).current;
  useEffect(() => {
    if (reduced) { core.setValue(1); return; }
    const run = Animated.parallel([
      Animated.sequence([Animated.delay(delay), Animated.spring(core, { toValue: 1, damping: 11, stiffness: 120, mass: 0.9, useNativeDriver: nativeDriver })]),
      ...rings.map((ring, index) => Animated.sequence([Animated.delay(delay + 120 + index * 260), Animated.timing(ring, { toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: nativeDriver })])),
    ]);
    run.start();
    return () => run.stop();
  }, [core, delay, reduced, rings]);
  return <View style={{ width: size, height: size }}>
    {rings.map((ring, index) => <Animated.View key={index} pointerEvents="none" style={[StyleSheet.absoluteFill, {
      borderRadius: size, borderWidth: 1.5, borderColor: index === 0 ? 'rgba(43,132,202,0.45)' : 'rgba(255,255,255,0.9)',
      opacity: ring.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 1, 0] }),
      transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.9, 2.6] }) }],
    }]} />)}
    <Animated.View style={{ opacity: core.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] }), transform: [{ scale: core.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }) }] }}>
      <Aura size={size} mode={mode} />
    </Animated.View>
  </View>;
}

/** Soft light drifting slowly across the sky band. Purely decorative; still under Reduce Motion. */
export function SkyLight() {
  const reduced = useReducedMotion();
  const drift = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) return;
    const ease = Easing.inOut(Easing.sin);
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(drift, { toValue: 1, duration: 14000, easing: ease, useNativeDriver: nativeDriver }),
      Animated.timing(drift, { toValue: 0, duration: 14000, easing: ease, useNativeDriver: nativeDriver }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [drift, reduced]);
  const blob = (id: string, color: string, opacity: number) => <Svg width="100%" height="100%">
    <Defs><RadialGradient id={id} cx="50%" cy="50%" r="50%"><Stop offset="0" stopColor={color} stopOpacity={opacity} /><Stop offset="1" stopColor={color} stopOpacity={0} /></RadialGradient></Defs>
    <Rect width="100%" height="100%" fill={`url(#${id})`} />
  </Svg>;
  return <View pointerEvents="none" style={styles.sky}>
    <Animated.View style={[styles.blobA, { transform: [{ translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [-30, 40] }) }, { translateY: drift.interpolate({ inputRange: [0, 1], outputRange: [0, 18] }) }] }]}>{blob('light', '#FFFFFF', 0.75)}</Animated.View>
    <Animated.View style={[styles.blobB, { transform: [{ translateX: drift.interpolate({ inputRange: [0, 1], outputRange: [30, -36] }) }] }]}>{blob('haze', '#B9DDF6', 0.55)}</Animated.View>
  </View>;
}

/** A gentle opacity pulse for text that describes ongoing work. */
export function Shimmer({ children, style }: { children: string; style: StyleProp<TextStyle> }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.35, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: nativeDriver }),
      Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: nativeDriver }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [pulse, reduced]);
  return <Animated.Text style={[style, { opacity: pulse }]}>{children}</Animated.Text>;
}

/** Springs its child from small to full size whenever `on` becomes true (checkmarks, send button). */
export function Pop({ on, children, initial = false }: { on: boolean; children: ReactNode; initial?: boolean }) {
  const reduced = useReducedMotion();
  const scale = useRef(new Animated.Value(1)).current;
  const first = useRef(!initial);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!on || reduced) return;
    scale.setValue(0.55);
    Animated.spring(scale, { toValue: 1, damping: 9, stiffness: 260, mass: 0.6, useNativeDriver: nativeDriver }).start();
  }, [on, reduced, scale]);
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

/** Fills from 0 to 1 when `filled` turns true, so a progress segment visibly advances. */
export function Fill({ filled, color, style }: { filled: boolean; color: string; style: StyleProp<ViewStyle> }) {
  const reduced = useReducedMotion();
  const value = useRef(new Animated.Value(filled ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { value.setValue(filled ? 1 : 0); return; }
    Animated.timing(value, { toValue: filled ? 1 : 0, duration: 520, delay: 120, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
  }, [filled, reduced, value]);
  return <View style={[style, { overflow: 'hidden' }]}>
    <Animated.View style={{ height: '100%', backgroundColor: color, width: value.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) }} />
  </View>;
}

const appStartedAt = Date.now();
const VEIL_MINIMUM = 1100;
/** How long a first-screen entrance should wait so it plays as the launch veil lifts. */
export const introDelay = (extra = 0) => Math.max(0, VEIL_MINIMUM + 80 - (Date.now() - appStartedAt)) + extra;

/**
 * The launch moment for a returning person: the logo blooms while saved state loads, then lifts away.
 * When there is nothing saved (`brief`), it steps aside at once for the connect screen's own reveal.
 */
export function LaunchVeil({ ready, brief }: { ready: boolean; brief: boolean }) {
  const reduced = useReducedMotion();
  const veil = useRef(new Animated.Value(1)).current;
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!ready) return;
    const wait = brief || reduced ? 0 : Math.max(0, VEIL_MINIMUM - (Date.now() - appStartedAt));
    const timer = setTimeout(() => Animated.timing(veil, { toValue: 0, duration: brief || reduced ? 160 : 440, easing: Easing.out(Easing.quad), useNativeDriver: nativeDriver }).start(() => setGone(true)), wait);
    return () => clearTimeout(timer);
  }, [brief, ready, reduced, veil]);
  if (gone) return null;
  return <Animated.View pointerEvents={ready ? 'none' : 'auto'} style={[StyleSheet.absoluteFill, styles.veil, {
    opacity: veil, transform: [{ scale: veil.interpolate({ inputRange: [0, 1], outputRange: [1.05, 1] }) }],
  }]}>
    {!brief && <>
      <Bloom size={76} delay={120} />
      <View style={{ height: 22 }} />
      <Wordmark text="Aeri" delay={420} style={styles.veilWord} />
    </>}
  </Animated.View>;
}

const styles = StyleSheet.create({
  word: { flexDirection: 'row' },
  sky: { position: 'absolute', top: 0, left: 0, right: 0, height: 380, overflow: 'hidden' },
  blobA: { position: 'absolute', width: 340, height: 300, top: -90, left: -60 },
  blobB: { position: 'absolute', width: 300, height: 260, top: 40, right: -110 },
  veil: { backgroundColor: c.canvas, alignItems: 'center', justifyContent: 'center' },
  veilWord: { fontSize: 34, lineHeight: 40, fontWeight: '700', letterSpacing: -0.8, color: c.ink },
});
