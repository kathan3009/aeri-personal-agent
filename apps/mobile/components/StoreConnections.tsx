import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Switch, Text, View } from 'react-native';
import { ShoppingBag } from 'lucide-react-native';
import { useApp } from '../lib/api';
import { useFeedback } from '../lib/feedback';
import { haptic } from '../lib/haptics';
import { useStoreView } from '../lib/store-view';
import { c, t } from '../lib/theme';
import { Button, Field, Group, Row, SectionHeader, Sheet } from './ui';

type Retailer = { domain: string; name: string };
const names: Record<string, string> = { 'target.com': 'Target', 'walmart.com': 'Walmart', 'instacart.com': 'Instacart', 'amazon.com': 'Amazon', 'costco.com': 'Costco', 'kroger.com': 'Kroger', 'wholefoodsmarket.com': 'Whole Foods', 'traderjoes.com': 'Trader Joe’s' };
const retailer = (domain: string): Retailer => ({ domain, name: names[domain] ?? domain.split('.')[0].replace(/^\w/, letter => letter.toUpperCase()) });
/** "https://www.bestbuy.com/site/x" or "Best Buy.com" → "bestbuy.com". The server checks it again. */
const domainFrom = (value: string) => {
  try { return new URL(value.includes('://') ? value.trim() : `https://${value.trim()}`).hostname.toLowerCase().replace(/^www\./, '').replace(/\s+/g, ''); }
  catch { return ''; }
};
type Connection = { connected: boolean; status: string; flowStatus?: string; hostedUrl?: string; expiresAt?: string; unavailable?: boolean };
const pending = (connection?: Connection) => !!connection && !connection.connected && !connection.unavailable && !!connection.hostedUrl && !['failed', 'expired', 'disconnected'].includes(connection.status) && (!connection.expiresAt || Date.parse(connection.expiresAt) > Date.now());
/** A sign-in that was started and then failed, expired or was abandoned. */
const interrupted = (connection?: Connection) => !!connection && !connection.connected && !connection.unavailable && !pending(connection) && !['NOT_CONNECTED', 'disconnected'].includes(connection.status);
const statusText = (connection?: Connection) => !connection ? 'Checking…' : connection.unavailable ? 'Unavailable' : connection.connected ? 'Connected' : pending(connection) ? 'Finish signing in' : interrupted(connection) ? 'Didn’t finish' : 'Not connected';

/** Retailer access stays separate from preferences, with consent before opening a saved login. */
export function StoreConnections() {
  const { request, providers } = useApp();
  const { toast } = useFeedback();
  const storeView = useStoreView();
  const [visible, setVisible] = useState(false);
  const [selected, setSelected] = useState<Retailer | null>(null);
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const [stores, setStores] = useState<Retailer[]>(['target.com', 'walmart.com', 'instacart.com'].map(retailer));
  const [adding, setAdding] = useState('');
  const [remember, setRemember] = useState(true);
  const storesRef = useRef(stores); storesRef.current = stores;
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
    let list = storesRef.current;
    try {
      const known = await request<{ connected: string[]; suggested: string[] }>('/v1/retailers');
      list = [...new Set([...known.connected, ...known.suggested, ...storesRef.current.map(s => s.domain)])].map(retailer);
      setStores(list);
    } catch { /* keep the stores already shown */ }
    await Promise.all(list.map(async store => {
      try { await refreshStore(store.domain); }
      catch { setConnections(prior => ({ ...prior, [store.domain]: { connected: false, status: 'unavailable', unavailable: true } })); }
    }));
    setChecking(false);
  }, [refreshStore, request]);
  useEffect(() => {
    if (!visible) return;
    void refreshAll();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') void refreshAll(); });
    return () => subscription.remove();
  }, [visible, refreshAll]);
  const hasPending = visible && Object.values(connections).some(pending);
  const add = () => {
    const domain = domainFrom(adding);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) { setError('Enter the store’s website, like bestbuy.com'); return; }
    const store = retailer(domain);
    setStores(prior => prior.some(s => s.domain === domain) ? prior : [...prior, store]);
    setAdding(''); setError(null); setSelected(store); haptic.tap();
    void refreshStore(domain).catch(cause => setError((cause as Error).message));
  };
  useEffect(() => {
    if (!hasPending) return;
    const timer = setInterval(() => {
      for (const store of stores) if (pending(connections[store.domain])) void refreshStore(store.domain).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [hasPending, connections, refreshStore, stores]);
  const close = () => { if (busy) return; setVisible(false); setSelected(null); setError(null); };
  /** `fresh` throws away a stuck or mistaken sign-in and opens a new one. */
  const signIn = async (fresh = false) => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      // The store keeps an unfinished sign-in open, so starting over clears it before asking for a new one.
      if (fresh) await request(`/v1/retailers/${selected.domain}/auth`, { method: 'DELETE' });
      const current = fresh ? undefined : connections[selected.domain];
      const next = pending(current) ? current! : await request<Connection>(`/v1/retailers/${selected.domain}/auth`, { method: 'POST', body: JSON.stringify({ consent: true, remember }) });
      setConnections(prior => ({ ...prior, [selected.domain]: next }));
      if (next.connected) { haptic.success(); return; }
      if (!next.hostedUrl) throw new Error('The sign-in page is not ready. Please try again.');
      // One sheet at a time on iPhone: step out of Store accounts while the store's sign-in page is open.
      setVisible(false);
      await new Promise(resolve => setTimeout(resolve, 380));
      const domain = selected.domain;
      await storeView.open({ url: next.hostedUrl, title: `Sign in to ${selected.name}`, kind: 'signin',
        code: async () => (await request<{ code: { code: string } | null }>(`/v1/retailers/${domain}/code`)).code?.code ?? null });
      setVisible(true);
      const refreshed = await refreshStore(selected.domain);
      if (refreshed.connected) { haptic.success(); toast(`${selected.name} is connected`, 'info'); }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const disconnect = async (cancelling = false) => {
    if (!selected || busy) return;
    setBusy(true); setError(null);
    try {
      await request(`/v1/retailers/${selected.domain}/auth`, { method: 'DELETE' });
      await refreshStore(selected.domain); haptic.tap(); toast(cancelling ? `${selected.name} sign-in cancelled` : `${selected.name} disconnected`, 'info');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const connection = selected ? connections[selected.domain] : undefined;
  const count = Object.values(connections).filter(value => value.connected).length;
  return <>
    <SectionHeader title="Shopping" />
    <Group><Row title="Store accounts" subtitle={count ? `${count} ${count === 1 ? 'store connected' : 'stores connected'}` : 'Sign in to use your store carts.'} chevron onPress={() => setVisible(true)}
      left={<View style={styles.icon}><ShoppingBag size={18} color={c.accent} strokeWidth={1.8} /></View>} /></Group>
    <Sheet visible={visible} onClose={close} title={selected ? selected.name : 'Store accounts'} message={selected ? undefined : 'Sign in to the stores you use so Aeri can fill your carts.'}>
      {!selected ? <>
        <Group style={styles.group}>
          {stores.map(store => <Row key={store.domain} title={store.name} chevron onPress={() => { setSelected(store); setError(null); }} right={<Text style={[t.footnote, { color: connections[store.domain]?.connected ? c.leaf : c.ink2 }]}>{statusText(connections[store.domain])}</Text>} />)}
        </Group>
        <Group style={[styles.group, { marginTop: 12 }]}>
          <Field label="Another store" value={adding} onChangeText={setAdding} placeholder="Its website, like bestbuy.com" autoCapitalize="none" autoCorrect={false} keyboardType="url" returnKeyType="go" onSubmitEditing={add} />
        </Group>
        {!!adding.trim() && <Button label="Add store" tone="secondary" onPress={add} style={{ marginTop: 10 }} />}
        {error && <Text style={[styles.note, { color: c.ember }]} accessibilityRole="alert">{error}</Text>}
        <Text style={styles.note}>Aeri also finds stores by searching for each item. You review every cart and complete payment at the store.</Text>
        {checking && <ActivityIndicator style={styles.progress} color={c.accent} accessibilityLabel="Checking store accounts" />}
        {!checking && Object.values(connections).some(value => value.unavailable) && <Button label="Check again" tone="plain" onPress={() => void refreshAll()} />}
      </> : <>
        <Text style={[t.body, styles.description]}>{connection?.connected ? `${selected.name} is connected. Aeri can use your saved store session when preparing a cart.` : `Continue to a private browser to sign in to ${selected.name}. Aeri saves the store session so it can prepare carts for you. Your password goes to the store and is never sent to Aeri.`}</Text>
        {!connection?.connected && <View style={styles.remember}>
          <View style={{ flex: 1 }}>
            <Text style={[t.callout, { color: c.ink }]}>Stay signed in</Text>
            <Text style={[t.footnote, { marginTop: 2 }]}>Kernel keeps your sign-in details encrypted and signs you back in when the session expires. Aeri never sees your password.</Text>
          </View>
          <Switch value={remember} onValueChange={setRemember} trackColor={{ true: c.accent }} accessibilityLabel="Stay signed in" />
        </View>}
        <Text style={styles.note}>You stay in control of every order and payment.</Text>
        {pending(connection) && <Text style={styles.note}>A sign-in is already open. Finish it, or start over if you made a mistake or it stopped working.</Text>}
        {interrupted(connection) && <Text style={[styles.note, { color: '#875810' }]}>The last sign-in didn’t finish. Start again whenever you’re ready.</Text>}
        {error && <Text style={[styles.note, { color: c.ember }]} accessibilityRole="alert">{error}</Text>}
        {connection?.connected
          ? <Button label="Disconnect store" tone="destructive" loading={busy} onPress={() => void disconnect()} style={styles.action} />
          : <Button label={pending(connection) ? 'Finish signing in' : interrupted(connection) ? 'Sign in again' : `Continue to ${selected.name}`} loading={busy} disabled={!providers?.kernel} onPress={() => void signIn(interrupted(connection))} style={styles.action} accessibilityHint={`Allow Aeri to save your ${selected.name} store session, then open its sign-in page`} />}
        {pending(connection) && <View style={styles.restart}>
          <Button label="Start over" tone="secondary" disabled={busy || !providers?.kernel} onPress={() => void signIn(true)} style={{ flex: 1 }} accessibilityHint={`Discards this ${selected.name} sign-in and opens a new one`} />
          <Button label="Cancel sign-in" tone="secondary" disabled={busy} onPress={() => void disconnect(true)} style={{ flex: 1 }} accessibilityHint={`Stops connecting ${selected.name}`} />
        </View>}
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
  remember: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 16, padding: 14, borderRadius: 16, backgroundColor: c.canvas },
  restart: { flexDirection: 'row', gap: 10, marginTop: 10 },
  progress: { marginTop: 16 },
});
