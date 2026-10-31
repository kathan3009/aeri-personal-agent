import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SymbolView } from 'expo-symbols';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CircleUserRound, WifiOff } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { haptic } from '../lib/haptics';
import { useNav } from '../lib/nav';
import { c, t } from '../lib/theme';

export function SettingsButton() {
  const { openSettings } = useNav();
  return <Pressable onPress={() => { haptic.tap(); openSettings(); }} hitSlop={8} style={styles.settings} accessibilityRole="button" accessibilityLabel="Settings and connection">
    {Platform.OS === 'ios'
      ? <SymbolView name="person.crop.circle" size={27} tintColor={c.ink2} weight="light" fallback={<CircleUserRound size={28} color={c.ink2} strokeWidth={1.6} />} />
      : <CircleUserRound size={28} color={c.ink2} strokeWidth={1.6} />}
  </Pressable>;
}

/** Shown when the last refresh failed but earlier state is still on screen. */
export function OfflineNotice() {
  const { error, refresh } = useApp();
  if (!error) return null;
  return <Pressable onPress={() => { haptic.tap(); void refresh(); }} style={styles.offline} accessibilityRole="button" accessibilityLabel={`${error} Tap to retry.`}>
    <WifiOff size={16} color={c.ember} strokeWidth={2} />
    <Text style={[t.footnote, { color: c.ink, flex: 1 }]} numberOfLines={2}>{error}</Text>
    <Text style={[t.footnote, { color: c.accent, fontWeight: '600' }]}>Retry</Text>
  </Pressable>;
}

/** Large-title header used by Memory and Tasks; it scrolls with the content like iOS. */
export function LargeHeader({ title, subtitle, children }: { title: string; subtitle: string; children?: ReactNode }) {
  const insets = useSafeAreaInsets();
  return <View style={{ paddingTop: insets.top + 4 }}>
    <View style={styles.bar}><SettingsButton /></View>
    <Text style={t.largeTitle} accessibilityRole="header">{title}</Text>
    <Text style={[t.subhead, { marginTop: 4 }]}>{subtitle}</Text>
    <OfflineNotice />
    {children}
  </View>;
}

const styles = StyleSheet.create({
  bar: { height: 44, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' },
  settings: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  offline: { marginTop: 14, flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: c.emberTint, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
});
