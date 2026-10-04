import * as SecureStore from 'expo-secure-store';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AppState } from '@personal-agent/core';

type Providers = Record<'gemini' | 'neon' | 'aiGateway' | 'kernel' | 'exa' | 'vapi' | 'agentMail', boolean>;
type Settings = { url: string; token: string };
type AppContextValue = {
  settings: Settings | null; state: AppState | null; providers: Providers | null; loading: boolean; error: string | null;
  phoneNumber: string | null;
  connect: (url: string, token: string) => Promise<void>; disconnect: () => Promise<void>; refresh: () => Promise<void>;
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  upload: <T>(path: string, uri: string, kind: 'video' | 'audio', mimeType: string) => Promise<T>;
};
const Context = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [state, setState] = useState<AppState | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    if (!settings) throw new Error('Connect to your agent first');
    const response = await fetch(`${settings.url.replace(/\/$/, '')}${path}`, {
      ...init, headers: { Authorization: `Bearer ${settings.token}`, ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...init.headers },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${response.status})`);
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
    const saved = await SecureStore.getItemAsync('aeri.settings');
    if (saved) { try { setSettings(JSON.parse(saved)); } catch { /* reconnect manually */ } }
    setLoading(false);
  })(); }, []);
  useEffect(() => { if (settings) void refresh(); }, [settings, refresh]);
  const connect = useCallback(async (url: string, token: string) => {
    const normalized = url.trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(normalized) || !token.trim()) throw new Error('Enter a valid API URL and access code');
    const response = await fetch(`${normalized}/v1/bootstrap`, { headers: { Authorization: `Bearer ${token.trim()}` } });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? 'Could not connect');
    const next = { url: normalized, token: token.trim() };
    await SecureStore.setItemAsync('aeri.settings', JSON.stringify(next));
    setSettings(next); setState(json.state); setProviders(json.providers); setPhoneNumber(json.phoneNumber); setError(null);
  }, []);
  const disconnect = useCallback(async () => { await SecureStore.deleteItemAsync('aeri.settings'); setSettings(null); setState(null); setProviders(null); setPhoneNumber(null); }, []);
  const upload = useCallback(async <T,>(path: string, uri: string, kind: 'video' | 'audio', mimeType: string): Promise<T> => {
    const form = new FormData();
    form.append(kind, { uri, name: `${kind}-${Date.now()}.${kind === 'video' ? 'mp4' : 'm4a'}`, type: mimeType } as unknown as Blob);
    return request<T>(path, { method: 'POST', body: form });
  }, [request]);
  const value = useMemo(() => ({ settings, state, providers, phoneNumber, loading, error, connect, disconnect, refresh, request, upload }), [settings, state, providers, phoneNumber, loading, error, connect, disconnect, refresh, request, upload]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useApp() { const value = useContext(Context); if (!value) throw new Error('AppProvider missing'); return value; }
