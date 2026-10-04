import Kernel from '@onkernel/sdk';
import type { BrowserCreateParams } from '@onkernel/sdk/resources/browsers/browsers';
import type { ManagedAuth } from '@onkernel/sdk/resources/auth/connections';

export const retailerDomains = ['target.com', 'walmart.com', 'wholefoodsmarket.com', 'kroger.com', 'safeway.com', 'costco.com', 'instacart.com', 'amazon.com', 'heb.com', 'publix.com', 'aldi.us', 'sprouts.com', 'cvs.com', 'walgreens.com', 'uniqlo.com', 'oldnavy.gap.com', 'gap.com', 'nordstrom.com'] as const;
export function retailerDomain(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS retailer URL');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const domain = [...retailerDomains].sort((a, b) => b.length - a.length).find(d => host === d || host.endsWith(`.${d}`));
  if (!domain) throw new Error('This retailer is not supported for account connections');
  return domain;
}

export type MerchantAuthState = { connectionId: string; domain: string; status: string; flowStatus?: string | null; expiresAt?: string | null; hostedUrl?: string };
const publicState = (c: ManagedAuth): MerchantAuthState => ({ connectionId: c.id, domain: c.domain, status: c.status, flowStatus: c.flow_status, expiresAt: c.flow_expires_at,
  ...(c.flow_status === 'IN_PROGRESS' && c.hosted_url ? { hostedUrl: c.hosted_url } : {}) });

/** Called only after the app's user explicitly chooses Connect. Never accepts account passwords. */
export async function beginMerchantAuth(client: Kernel, storeUrl: string, accountScope: string, consent: boolean): Promise<MerchantAuthState> {
  if (!consent) throw new Error('Connecting a retailer account requires explicit consent');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(accountScope)) throw new Error('Invalid account scope');
  const domain = retailerDomain(storeUrl), profile = `aeri-${accountScope}-${domain.replace(/\./g, '-')}`;
  let connection: ManagedAuth | undefined;
  // SDK iterator follows every pagination page. Match both domain AND the app-owned account profile.
  for await (const item of client.auth.connections.list({ domain, profile_name: profile })) {
    if (item.domain === domain && item.profile_name === profile) { connection = item; break; }
  }
  connection ??= await client.auth.connections.create({ domain, profile_name: profile, allowed_domains: [domain], save_credentials: false,
    health_checks: false, auto_reauth: false, browser: { telemetry: { enabled: false } } });
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

export async function merchantBrowserOptions(client: Kernel, storeUrl: string, connectionId?: string): Promise<BrowserCreateParams> {
  const options: BrowserCreateParams = { stealth: true, headless: false, timeout_seconds: 1200 };
  if (!connectionId) return options;
  const connection = await client.auth.connections.retrieve(connectionId);
  if (connection.domain !== retailerDomain(storeUrl)) throw new Error('Account connection belongs to another retailer');
  if (connection.status !== 'AUTHENTICATED' || (connection.flow_status && connection.flow_status !== 'SUCCESS')) throw new Error('Complete the retailer login before preparing the cart');
  return { ...options, profile: { name: connection.profile_name, save_changes: true },
    ...(connection.browser?.proxy ? { proxy: connection.browser.proxy } : connection.proxy_id ? { proxy_id: connection.proxy_id } : {}),
    telemetry: { enabled: false } };
}
