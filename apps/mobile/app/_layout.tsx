import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../lib/api';
import { FeedbackProvider } from '../lib/feedback';
import { StoreViewProvider } from '../lib/store-view';

export default function Layout() {
  return <SafeAreaProvider><AppProvider><FeedbackProvider><StoreViewProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></StoreViewProvider></FeedbackProvider></AppProvider></SafeAreaProvider>;
}
