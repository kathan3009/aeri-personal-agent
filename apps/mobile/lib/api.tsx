import * as SecureStore from 'expo-secure-store';
import { AppState as NativeAppState, Platform } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState } from '@personal-agent/core';

export type Providers = Record<'gemini' | 'neon' | 'aiGateway' | 'kernel' | 'exa' | 'agentMail' | 'vision' | 'voice' | 'frames', boolean>;
type Settings = { url: string; token: string };
const settingsKey = 'aeri.settings';
const getSavedSettings = () => Platform.OS === 'web' ? Promise.resolve(sessionStorage.getItem(settingsKey)) : SecureStore.getItemAsync(settingsKey);
const saveSettings = (value: string) => Platform.OS === 'web' ? Promise.resolve(sessionStorage.setItem(settingsKey, value)) : SecureStore.setItemAsync(settingsKey, value);
const clearSettings = () => Platform.OS === 'web' ? Promise.resolve(sessionStorage.removeItem(settingsKey)) : SecureStore.deleteItemAsync(settingsKey);
type AppContextValue = {
  settings: Settings | null; state: AppState | null; providers: Providers | null; loading: boolean; error: string | null;
  connect: (url: string, token: string) => Promise<void>; disconnect: () => Promise<void>; refresh: () => Promise<void>;
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
    throw new Error(`Can't reach Aeri at ${where}. Check that the server is running and this device is on the same network.`);
  }
  finally { clearTimeout(timer); }
};
const problem = (status: number, message?: string) => status === 401 ? "That access code wasn't accepted." : message ?? `Aeri returned an error (${status}).`;

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!settings) throw new Error('Connect to your agent first');
    const response = await reach(`${settings.url.replace(/\/$/, '')}${path}`, {
      ...init, headers: { Authorization: `Bearer ${settings.token}`, ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(problem(response.status, (json as { error?: string }).error));
    return json as T;
  }, [settings]);
  const refresh = useCallback(async () => {
    if (!settings) return;
    try {
      const result = await request<{ state: AppState; providers: Providers }>('/v1/bootstrap');
      setState(result.state); setProviders(result.providers); setError(null);
    } catch (cause) { setError((cause as Error).message); }
  }, [request, settings]);
  useEffect(() => { (async () => {
    try {
      const saved = await getSavedSettings();
      if (saved) setSettings(JSON.parse(saved));
    } catch { /* unreadable settings: reconnect manually */ }
    finally { setLoading(false); }
  })(); }, []);
  useEffect(() => { if (settings) void refresh(); }, [settings, refresh]);
  const connect = useCallback(async (url: string, token: string) => {
    const normalized = url.trim().replace(/\/$/, '');
    if (!/^https?:\/\/[^\s/]+/.test(normalized)) throw new Error('Enter the server address, starting with http:// or https://');
    if (!token.trim()) throw new Error('Enter your access code');
    const response = await reach(`${normalized}/v1/bootstrap`, { headers: { Authorization: `Bearer ${token.trim()}` } });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(problem(response.status, json.error));
    const next = { url: normalized, token: token.trim() };
    await saveSettings(JSON.stringify(next));
    setSettings(next); setState(json.state); setProviders(json.providers); setError(null);
  }, []);
  const disconnect = useCallback(async () => { await clearSettings(); setSettings(null); setState(null); setProviders(null); }, []);
  const upload = useCallback(async <T,>(path: string, uri: string, field: 'video' | 'audio' | 'image', mimeType: string, fields: Record<string, string> = {}, fileName?: string): Promise<T> => {
    const form = new FormData();
    const extension = field === 'audio' ? 'm4a' : mimeType === 'video/quicktime' ? 'mov' : mimeType === 'video/webm' ? 'webm' : field === 'image' ? (mimeType === 'image/png' ? 'png' : mimeType === 'image/heic' ? 'heic' : 'jpg') : 'mp4';
    const name = fileName ?? `${field}-${Date.now()}.${extension}`;
    // The browser preview hands back blob URLs; native platforms stream the file from its URI.
    if (Platform.OS === 'web') form.append(field, new File([await (await fetch(uri)).blob()], name, { type: mimeType }));
    else form.append(field, { uri, name, type: mimeType } as unknown as Blob);
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
  const value = useMemo(() => ({ settings, state, providers, loading, error, connect, disconnect, refresh, request, upload, frame }), [settings, state, providers, loading, error, connect, disconnect, refresh, request, upload, frame]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useApp() { const value = useContext(Context); if (!value) throw new Error('AppProvider missing'); return value; }
