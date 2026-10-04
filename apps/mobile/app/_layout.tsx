import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../lib/api';

export default function Layout() {
  return <SafeAreaProvider><AppProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></AppProvider></SafeAreaProvider>;
}
