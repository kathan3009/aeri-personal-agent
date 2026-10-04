import * as WebBrowser from 'expo-web-browser';
import { Linking, Platform } from 'react-native';

/** Shows the retailer or Kernel live view inside the native app. */
export async function openRetailerBrowser(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('The store link must use HTTPS.');

  if (Platform.OS === 'web') {
    await Linking.openURL(url);
    return;
  }

  await WebBrowser.openBrowserAsync(url, {
    presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    dismissButtonStyle: 'done',
    enableBarCollapsing: false,
  });
}
