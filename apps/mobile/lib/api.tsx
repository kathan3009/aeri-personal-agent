import * as SecureStore from 'expo-secure-store';
import { File as DeviceFile } from 'expo-file-system';
import { AppState as NativeAppState, Platform } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState } from '@personal-agent/core';

export type Providers = Record<'gemini' | 'neon' | 'aiGateway' | 'kernel' | 'exa' | 'agentMail' | 'vision' | 'voice' | 'frames', boolean>;
type Settings = { url: string; token: string; email?: string };
export type Account = { email: string; createdAt: string; mailbox: { address: string } | null };
/** The Aeri server this build talks to. A development build can point somewhere else from the sign-in screen. */
export const defaultServer = (process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'web' ? 'http://127.0.0.1:8787' : 'http://localhost:8787')).replace(/\/$/, '');
const settingsKey = 'aeri.settings';
const getSavedSettings = () => Platform.OS === 'web' ? Promise.resolve(sessionStorage.getItem(settingsKey)) : SecureStore.getItemAsync(settingsKey);
const saveSettings = (value: string) => Platform.OS === 'web' ? Promise.resolve(sessionStorage.setItem(settingsKey, value)) : SecureStore.setItemAsync(settingsKey, value);
const clearSettings = () => Platform.OS === 'web' ? Promise.resolve(sessionStorage.removeItem(settingsKey)) : SecureStore.deleteItemAsync(settingsKey);
type AppContextValue = {
  settings: Settings | null; state: AppState | null; account: Account | null; providers: Providers | null; loading: boolean; error: string | null;
  /** Why the person was signed out (an expired session), shown on the sign-in screen. */
  signedOutReason: string | null;
  /** Emails a sign-in code. Development servers without email return the code instead. */
  sendCode: (url: string, email: string) => Promise<{ devCode?: string }>;
  verifyCode: (url: string, email: string, code: string) => Promise<void>;
  signOut: () => Promise<void>; refresh: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  upload: <T>(path: string, uri: string, field: 'video' | 'audio' | 'image', mimeType: string, fields?: Record<string, string>, name?: string) => Promise<T>;
  /** An authenticated image source for an evidence frame saved by the server. */
  frame: (scanId: string, name: string) => { uri: string; headers: Record<string, string> } | null;
};
const Context = createContext<AppContextValue | null>(null);

// Uploads and conversation can legitimately take a while; everything else should answer quickly.
const reach = async (url: string, init: RequestInit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.body instanceof FormData ? 120_000 : /\/v1\/(chat|carts\/[^/]+\/checkout)/.test(url) ? 60_000 : 15_000);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  catch {
    const where = url.replace(/^https?:\/\//, '').split('/')[0];
    if (controller.signal.aborted) throw new Error(`Aeri at ${where} took too long to answer. Try again in a moment.`);
    throw new Error(url.startsWith('https://') ? `Can't reach Aeri at ${where}. Check your internet connection and try again.` : `Can't reach Aeri at ${where}. Check that the server is running and this device is on the same network.`);
  }
  finally { clearTimeout(timer); }
};
const problem = (status: number, message?: string) => status === 401 ? 'Your session ended. Sign in again.' : message ?? `Aeri returned an error (${status}).`;
const normalize = (url: string) => {
  const value = url.trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(value)) throw new Error('Enter the server address, starting with http:// or https://');
  return value;
};
const post = async <T,>(url: string, path: string, body: unknown): Promise<T> => {
  const response = await reach(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((json as { error?: string }).error ?? `Aeri returned an error (${response.status}).`);
  return json as T;
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [signedOutReason, setSignedOutReason] = useState<string | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!settings) throw new Error('Connect to your agent first');
    const response = await reach(`${settings.url.replace(/\/$/, '')}${path}`, {
      ...init, headers: { Authorization: `Bearer ${settings.token}`, ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
    });
    const json = await response.json().catch(() => ({}));
    if (response.status === 401) { await clearSettings(); setSettings(null); setState(null); setAccount(null); setSignedOutReason('Your session ended. Sign in again.'); }
    if (!response.ok) throw new Error(problem(response.status, (json as { error?: string }).error));
    return json as T;
  }, [settings]);
  const refresh = useCallback(async () => {
    if (!settings) return;
    try {
      const result = await request<{ state: AppState; account: Account; providers: Providers }>('/v1/bootstrap');
      setState(result.state); setAccount(result.account); setProviders(result.providers); setError(null);
    } catch (cause) { setError((cause as Error).message); }
  }, [request, settings]);
  useEffect(() => { (async () => {
    try {
      const saved = await getSavedSettings();
      // Settings from before accounts (an access code) can't sign in any more; start at the sign-in screen.
      const parsed = saved ? JSON.parse(saved) as Settings : null;
      if (parsed?.token?.startsWith('aeri_')) setSettings(parsed); else if (parsed) await clearSettings();
    } catch { /* unreadable settings: reconnect manually */ }
    finally { setLoading(false); }
  })(); }, []);
  useEffect(() => { if (settings) void refresh(); }, [settings, refresh]);
  const sendCode = useCallback(async (url: string, email: string) => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error('Enter your email address');
    return post<{ sent: boolean; devCode?: string }>(normalize(url), '/v1/auth/code', { email: email.trim() });
  }, []);
  const verifyCode = useCallback(async (url: string, email: string, code: string) => {
    const server = normalize(url);
    // Continuing on the sign-in screen accepts the terms and privacy policy shown there.
    const result = await post<{ token: string; user: Account }>(server, '/v1/auth/verify', { email: email.trim(), code: code.trim(), acceptTerms: true });
    const next = { url: server, token: result.token, email: result.user.email };
    await saveSettings(JSON.stringify(next));
    setSignedOutReason(null); setAccount(result.user); setSettings(next);
  }, []);
  const signOut = useCallback(async () => {
    if (settings) await reach(`${settings.url}/v1/auth/sign-out`, { method: 'POST', headers: { Authorization: `Bearer ${settings.token}` } }).catch(() => undefined);
    await clearSettings(); setSettings(null); setState(null); setAccount(null); setProviders(null); setSignedOutReason(null);
  }, [settings]);
  const upload = useCallback(async <T,>(path: string, uri: string, field: 'video' | 'audio' | 'image', mimeType: string, fields: Record<string, string> = {}, fileName?: string): Promise<T> => {
    const form = new FormData();
    const extension = field === 'audio' ? 'm4a' : mimeType === 'video/quicktime' ? 'mov' : mimeType === 'video/webm' ? 'webm' : field === 'image' ? (mimeType === 'image/png' ? 'png' : mimeType === 'image/heic' ? 'heic' : 'jpg') : 'mp4';
    const name = fileName ?? `${field}-${Date.now()}.${extension}`;
    // The browser preview hands back blob URLs. On iPhone, Expo's fetch only accepts file parts that can
    // hand over their bytes (React Native's `{ uri }` parts are rejected before anything is sent).
    if (Platform.OS === 'web') form.append(field, new File([await (await fetch(uri)).blob()], name, { type: mimeType }));
    else form.append(field, { name, type: mimeType, bytes: async () => new Uint8Array(await new DeviceFile(uri).arrayBuffer()) } as unknown as Blob);
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    return request<T>(path, { method: 'POST', body: form });
  }, [request]);
  const frame = useCallback((scanId: string, name: string) => settings ? { uri: `${settings.url.replace(/\/$/, '')}/v1/scans/${encodeURIComponent(scanId)}/frames/${encodeURIComponent(name)}`, headers: { Authorization: `Bearer ${settings.token}` } } : null, [settings]);
  // Reopening the app shows what changed while it was away (a finished video, a delivered order).
  useEffect(() => {
    const subscription = NativeAppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    return () => subscription.remove();
  }, [refresh]);
  // While Aeri is working in the background (video, store checks), keep the screens current.
  const working = !!state && (state.scans.some(s => s.status === 'processing') || state.tasks.some(t => t.status === 'running') || state.photoSearches.some(s => s.status === 'searching') || state.proposals.some(p => p.status === 'searching') || state.carts.some(c => c.checkout?.status === 'preparing'));
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [working, refresh]);
  const value = useMemo(() => ({ settings, state, account, providers, loading, error, signedOutReason, sendCode, verifyCode, signOut, refresh, request, upload, frame }),
    [settings, state, account, providers, loading, error, signedOutReason, sendCode, verifyCode, signOut, refresh, request, upload, frame]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useApp() { const value = useContext(Context); if (!value) throw new Error('AppProvider missing'); return value; }
