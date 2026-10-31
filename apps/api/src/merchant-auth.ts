import Kernel from '@onkernel/sdk';
import type { BrowserCreateParams } from '@onkernel/sdk/resources/browsers/browsers';
import type { ManagedAuth } from '@onkernel/sdk/resources/auth/connections';

export const retailerDomains = ['target.com', 'walmart.com', 'wholefoodsmarket.com', 'kroger.com', 'safeway.com', 'costco.com', 'instacart.com', 'amazon.com', 'heb.com', 'publix.com', 'aldi.us', 'sprouts.com', 'cvs.com', 'walgreens.com', 'uniqlo.com', 'oldnavy.gap.com', 'gap.com', 'nordstrom.com'] as const;
// Two-part public suffixes that need one more label to name a store (example.co.uk).
const twoPartSuffix = /\.(co|com|org|net|gov|ac)\.[a-z]{2}$/;
/** The store's site, e.g. "target.com" for https://www.target.com/p/123 or "oldnavy.gap.com" for a known sub-brand. */
export function registrableDomain(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(host) || /^\d+(\.\d+){3}$/.test(host)) return null;
  // Reserved and private names are never real stores.
  if (/\.(test|example|invalid|localhost|local|internal|lan|home|corp)$/.test(host)) return null;
  const known = [...retailerDomains].sort((a, b) => b.length - a.length).find(d => host === d || host.endsWith(`.${d}`));
  if (known) return known;
  const labels = host.split('.');
  return labels.slice(twoPartSuffix.test(host) ? -3 : -2).join('.');
}
/** Any store can be used; the person consents per store before Aeri signs in or opens a cart there. */
export function retailerDomain(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS retailer URL');
  const domain = registrableDomain(url.hostname);
  if (!domain) throw new Error('That isn’t a store website address');
  return domain;
}

export type MerchantAuthState = { connectionId: string; domain: string; status: string; flowStatus?: string | null; expiresAt?: string | null; hostedUrl?: string };
const publicState = (c: ManagedAuth): MerchantAuthState => ({ connectionId: c.id, domain: c.domain, status: c.status, flowStatus: c.flow_status, expiresAt: c.flow_expires_at,
  ...(c.flow_status === 'IN_PROGRESS' && c.hosted_url ? { hostedUrl: c.hosted_url } : {}) });

/** Called only after the app's user explicitly chooses Connect. Never accepts account passwords. */
/** `browser` is the store's working setup (stealth and proxy), so sign-in and later carts come from the same kind of IP. */
/** `remember` lets Kernel keep the sign-in details (in its vault, never Aeri's) so it can sign back in when a session expires. */
export async function beginMerchantAuth(client: Kernel, storeUrl: string, accountScope: string, consent: boolean, browser?: { stealth?: boolean; proxy?: { id: string } }, remember = false): Promise<MerchantAuthState> {
  if (!consent) throw new Error('Connecting a retailer account requires explicit consent');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(accountScope)) throw new Error('Invalid account scope');
  const domain = retailerDomain(storeUrl), profile = `aeri-${accountScope}-${domain.replace(/\./g, '-')}`;
  let connection: ManagedAuth | undefined;
  // SDK iterator follows every pagination page. Match both domain AND the app-owned account profile.
  for await (const item of client.auth.connections.list({ domain, profile_name: profile })) {
    if (item.domain === domain && item.profile_name === profile) { connection = item; break; }
  }
  // Health checks every few hours tell Aeri when a session expired; re-sign-in only happens with remembered details.
  connection ??= await client.auth.connections.create({ domain, profile_name: profile, allowed_domains: [domain], save_credentials: remember,
    health_checks: true, health_check_interval: Number(process.env.KERNEL_HEALTH_CHECK_SECONDS ?? 21_600), auto_reauth: remember, record_session: false, browser: { telemetry: { enabled: false }, ...(browser?.stealth !== undefined ? { stealth: browser.stealth } : {}), ...(browser?.proxy ? { proxy: browser.proxy } : {}) } } as never);
  const expires = connection.flow_expires_at ? Date.parse(connection.flow_expires_at) : Infinity;
  if (connection.status === 'AUTHENTICATED' || (connection.flow_status === 'IN_PROGRESS' && expires > Date.now())) return publicState(connection);
  const login = await client.auth.connections.login(connection.id);
  return { connectionId: connection.id, domain, status: 'NEEDS_AUTH', flowStatus: 'IN_PROGRESS', hostedUrl: login.hosted_url, expiresAt: login.flow_expires_at };
}

/** Poll this instead of starting another login; it cannot return credentials, cookies or CDP URLs. */
export async function merchantAuthStatus(client: Kernel, connectionId: string, storeUrl: string): Promise<MerchantAuthState> {
  const connection = await client.auth.connections.retrieve(connectionId);
  if (connection.domain !== retailerDomain(storeUrl)) throw new Error('Account connection belongs to another retailer');
  return publicState(connection);
}

/** The service closes sessions using this connection first; explicit Disconnect removes its saved profile too. */
export async function disconnectMerchantAuth(client: Kernel, connectionId: string, storeUrl: string, accountScope: string): Promise<void> {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(accountScope)) throw new Error('Invalid account scope');
  const domain = retailerDomain(storeUrl), profile = `aeri-${accountScope}-${domain.replace(/\./g, '-')}`;
  let connection: ManagedAuth | undefined;
  try { connection = await client.auth.connections.retrieve(connectionId); }
  catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
  if (connection) {
    if (connection.domain !== domain || connection.profile_name !== profile) throw new Error('Account connection does not belong to this account');
    await client.auth.connections.delete(connectionId);
  }
  // Supports retry after connection deletion succeeded but profile cleanup failed.
  try { await client.profiles.delete(profile); }
  catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
}

/** `base` is the store's own launch setup (see site-config); a saved sign-in adds its profile and keeps its proxy. */
export async function merchantBrowserOptions(client: Kernel, storeUrl: string, connectionId?: string, base: BrowserCreateParams = { stealth: true, headless: false }): Promise<BrowserCreateParams> {
  const options: BrowserCreateParams = { timeout_seconds: 1200, ...base };
  if (!connectionId) return options;
  const connection = await client.auth.connections.retrieve(connectionId);
  if (connection.domain !== retailerDomain(storeUrl)) throw new Error('Account connection belongs to another retailer');
  if (connection.status !== 'AUTHENTICATED' || (connection.flow_status && connection.flow_status !== 'SUCCESS')) throw new Error('Complete the retailer login before preparing the cart');
  // Keep a sign-in's own proxy only when it names a real proxy. A "default" or "direct" mode would replace the store's
  // working setup with Kernel's datacenter egress whenever stealth is off (exactly what Target blocks).
  const named = connection.browser?.proxy && ('id' in connection.browser.proxy && connection.browser.proxy.id || 'name' in connection.browser.proxy && connection.browser.proxy.name);
  const signedInProxy = named ? { proxy: connection.browser!.proxy! } : connection.proxy_id ? { proxy_id: connection.proxy_id } : null;
  const { proxy: siteProxy, ...rest } = options;
  // Read-only: Kernel's sign-in flow (and its automatic re-sign-in) keeps the profile's login fresh. Saving every
  // shopping session back into it let one stuck session block every later browser for that store, and two visits at
  // once would overwrite each other.
  return { ...rest, ...(signedInProxy ?? (siteProxy ? { proxy: siteProxy } : {})), profile: { name: connection.profile_name, save_changes: false },
    telemetry: { enabled: false } };
}
