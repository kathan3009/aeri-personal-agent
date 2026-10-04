import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';
import { ShoppingBag } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { openRetailerBrowser } from '../lib/retailer-browser';
import { c, t } from '../lib/theme';
import { Button, Group, Row, SectionHeader, Sheet } from './ui';

const stores = [{ domain: 'target.com', name: 'Target' }, { domain: 'walmart.com', name: 'Walmart' }, { domain: 'instacart.com', name: 'Instacart' }] as const;
type Retailer = typeof stores[number];
type Connection = { connected: boolean; status: string; hostedUrl?: string; expiresAt?: string; unavailable?: boolean };
const pending = (connection?: Connection) => !!connection && !connection.connected && !connection.unavailable && !!connection.hostedUrl && !['failed', 'expired', 'disconnected'].includes(connection.status) && (!connection.expiresAt || Date.parse(connection.expiresAt) > Date.now());
const statusText = (connection?: Connection) => !connection ? 'Checking…' : connection.unavailable ? 'Unavailable' : connection.connected ? 'Connected' : pending(connection) ? 'Finish signing in' : 'Not connected';

/** Retailer access stays separate from preferences, with consent before opening a saved login. */
export function StoreConnections() {
  const { request, providers } = useApp();
  const { toast } = useFeedback();
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<Retailer | null>(null);
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshStore = useCallback(async (domain: string) => {
    const result = await request<Connection>(`/v1/retailers/${domain}/auth`);
    setConnections(prior => ({ ...prior, [domain]: result }));
    return result;
  }, [request]);
  const refreshAll = useCallback(async () => {
    setChecking(true);
    await Promise.all(stores.map(async store => {
      try { await refreshStore(store.domain); }
      catch { setConnections(prior => ({ ...prior, [store.domain]: { connected: false, status: 'unavailable', unavailable: true } })); }
    }));
    setChecking(false);
  }, [refreshStore]);
  useEffect(() => {
    if (!visible) return;
    void refreshAll();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refreshAll(); });
    return () => subscription.remove();
  }, [visible, refreshAll]);
  const hasPending = visible && Object.values(connections).some(pending);
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      for (const store of stores) if (pending(connections[store.domain])) void refreshStore(store.domain).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [hasPending, connections, refreshStore]);
  const close = () => { if (busy) return; setVisible(false); setSelected(null); setError(null); };
  const signIn = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      const current = connections[selected.domain];
      const next = pending(current) ? current : await request<Connection>(`/v1/retailers/${selected.domain}/auth`, { method: 'POST', body: JSON.stringify({ consent: true }) });
      setConnections(prior => ({ ...prior, [selected.domain]: next }));
      if (next.connected) { haptic.success(); return; }
      if (!next.hostedUrl) throw new Error('The sign-in page is not ready. Please try again.');
      await openRetailerBrowser(next.hostedUrl);
      const refreshed = await refreshStore(selected.domain);
      if (refreshed.connected) { haptic.success(); toast(`${selected.name} is connected`, 'info'); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      await request(`/v1/retailers/${selected.domain}/auth`, { method: 'DELETE' });
      await refreshStore(selected.domain); haptic.tap(); toast(`${selected.name} disconnected`, 'info');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const connection = selected ? connections[selected.domain] : undefined;
  const count = Object.values(connections).filter(value => value.connected).length;
  return <>
    <SectionHeader title="Shopping" />
    <Group><Row title="Store accounts" subtitle={count ? `${count} ${count === 1 ? 'store connected' : 'stores connected'}` : 'Sign in to use your store carts.'} chevron onPress={() => setVisible(true)}
      left={<View style={styles.icon}><ShoppingBag size={18} color={c.accent} strokeWidth={1.8} /></View>} /></Group>
    <Sheet visible={visible} onClose={close} title={selected ? selected.name : 'Store accounts'} message={selected ? undefined : 'Choose a store to manage how Aeri helps with its cart.'}>
      {!selected ? <>
        <Group style={styles.group}>
          {stores.map(store => <Row key={store.domain} title={store.name} chevron onPress={() => { setSelected(store); setError(null); }} right={<Text style={[t.footnote, { color: connections[store.domain]?.connected ? c.leaf : c.ink2 }]}>{statusText(connections[store.domain])}</Text>} />)}
        </Group>
        <Text style={styles.note}>You review every cart and complete payment at the store.</Text>
        {checking && <ActivityIndicator style={styles.progress} color={c.accent} accessibilityLabel="Checking store accounts" />}
        {!checking && Object.values(connections).some(value => value.unavailable) && <Button label="Check again" tone="plain" onPress={() => void refreshAll()} />}
      </> : <>
        <Text style={[t.body, styles.description]}>{connection?.connected ? `${selected.name} is connected. Aeri can use your saved store session when preparing a cart.` : `Continue to a private browser to sign in to ${selected.name}. Aeri saves the store session so it can prepare carts for you. Your password goes to the store and is never sent to Aeri.`}</Text>
        <Text style={styles.note}>You stay in control of every order and payment.</Text>
        {error && <Text style={[styles.note, { color: c.ember }]} accessibilityRole="alert">{error}</Text>}
        {connection?.connected
          ? <Button label="Disconnect store" tone="destructive" loading={busy} onPress={() => void disconnect()} style={styles.action} />
          : <Button label={pending(connection) ? 'Finish signing in' : `Continue to ${selected.name}`} loading={busy} disabled={!providers?.kernel} onPress={() => void signIn()} style={styles.action} accessibilityHint={`Allow Aeri to save your ${selected.name} store session, then open its sign-in page`} />}
        {!providers?.kernel && <Text style={styles.note}>Store sign-in will be available when the browser service is ready.</Text>}
        <Button label="All stores" tone="plain" disabled={busy} onPress={() => { setSelected(null); setError(null); }} />
      </>}
    </Sheet>
  </>;
}

const styles = StyleSheet.create({
  icon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  group: { marginTop: 18, backgroundColor: c.canvas },
  note: { ...t.footnote, marginTop: 14, marginHorizontal: 3 },
  description: { marginTop: 18, marginHorizontal: 3 },
  action: { marginTop: 22 },
  progress: { marginTop: 16 },
});
