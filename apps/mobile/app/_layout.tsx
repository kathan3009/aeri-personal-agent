import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../lib/api';
import { FeedbackProvider } from '../lib/feedback';

export default function Layout() {
  return <SafeAreaProvider><AppProvider><FeedbackProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></FeedbackProvider></AppProvider></SafeAreaProvider>;
}
