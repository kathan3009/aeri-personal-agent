import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

const native = Platform.OS === 'ios' || Platform.OS === 'android';
const safely = (run: () => Promise<void>) => { if (native) void run().catch(() => undefined); };

export const haptic = {
  tap: () => safely(() => Haptics.selectionAsync()),
  press: () => safely(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  success: () => safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => safely(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
};
