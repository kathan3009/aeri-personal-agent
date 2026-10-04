import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState } from '@personal-agent/core';

type Providers = Record<'gemini' | 'neon' | 'aiGateway' | 'kernel' | 'exa' | 'vapi' | 'agentMail', boolean>;
type Settings = { url: string; token: string };
const settingsKey = 'aeri.settings';
const getSavedSettings = () => Platform.OS === 'web' ? Promise.resolve(sessionStorage.getItem(settingsKey)) : SecureStore.getItemAsync(settingsKey);
const saveSettings = (value: string) => Platform.OS === 'web' ? Promise.resolve(sessionStorage.setItem(settingsKey, value)) : SecureStore.setItemAsync(settingsKey, value);
const clearSettings = () => Platform.OS === 'web' ? Promise.resolve(sessionStorage.removeItem(settingsKey)) : SecureStore.deleteItemAsync(settingsKey);
type AppContextValue = {
  settings: Settings | null; state: AppState | null; providers: Providers | null; loading: boolean; error: string | null;
  phoneNumber: string | null;
  connect: (url: string, token: string) => Promise<void>; disconnect: () => Promise<void>; refresh: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  upload: <T>(path: string, uri: string, kind: 'video' | 'audio', mimeType: string) => Promise<T>;
};
const Context = createContext<AppContextValue | null>(null);

const reach = async (url: string, init: RequestInit) => {
  try { return await fetch(url, init); }
  catch { throw new Error("Can't reach Aeri. Check that the server is running and this device is on the same network."); }
};
const problem = (status: number, message?: string) => status === 401 ? "That access code wasn't accepted." : message ?? `Aeri returned an error (${status}).`;

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
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
      const result = await request<{ state: AppState; providers: Providers; phoneNumber: string | null }>('/v1/bootstrap');
      setState(result.state); setProviders(result.providers); setPhoneNumber(result.phoneNumber); setError(null);
    } catch (cause) { setError((cause as Error).message); }
  }, [request, settings]);
  useEffect(() => { (async () => {
    const saved = await getSavedSettings();
    if (saved) { try { setSettings(JSON.parse(saved)); } catch { /* reconnect manually */ } }
    setLoading(false);
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
    setSettings(next); setState(json.state); setProviders(json.providers); setPhoneNumber(json.phoneNumber); setError(null);
  }, []);
  const disconnect = useCallback(async () => { await clearSettings(); setSettings(null); setState(null); setProviders(null); setPhoneNumber(null); }, []);
  const upload = useCallback(async <T,>(path: string, uri: string, kind: 'video' | 'audio', mimeType: string): Promise<T> => {
    const form = new FormData();
    const extension = kind === 'audio' ? 'm4a' : mimeType === 'video/quicktime' ? 'mov' : 'mp4';
    const name = `${kind}-${Date.now()}.${extension}`;
    // The browser preview hands back blob URLs; native platforms stream the file from its URI.
    if (Platform.OS === 'web') form.append(kind, new File([await (await fetch(uri)).blob()], name, { type: mimeType }));
    else form.append(kind, { uri, name, type: mimeType } as unknown as Blob);
    return request<T>(path, { method: 'POST', body: form });
  }, [request]);
  const value = useMemo(() => ({ settings, state, providers, phoneNumber, loading, error, connect, disconnect, refresh, request, upload }), [settings, state, providers, phoneNumber, loading, error, connect, disconnect, refresh, request, upload]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useApp() { const value = useContext(Context); if (!value) throw new Error('AppProvider missing'); return value; }
