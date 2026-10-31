import { createHash } from 'node:crypto';
import type Kernel from '@onkernel/sdk';
import type { BrowserCreateParams } from '@onkernel/sdk/resources/browsers/browsers';
import type { SiteSetup } from './site-config.js';

/**
 * Warm browsers per store (Kernel Browser Pools). A pool already runs the store's working setup and, for a signed-in
 * store, the person's saved sign-in, so a cart starts in about a second instead of booting a browser. Pools load the
 * profile read-only and refresh when the sign-in is updated. If a pool can't serve, Aeri starts a browser as before.
 *
 * Set KERNEL_POOLS=0 to turn pools off (an idle warm browser is billed while it waits). Signed-in pools are one per
 * person per store, so they are off unless KERNEL_SIGNED_IN_POOLS=1; guest pools are shared and hold nobody's data.
 */
const enabled = (profile?: string) => process.env.KERNEL_POOLS !== '0' && (!profile || process.env.KERNEL_SIGNED_IN_POOLS === '1');
// A signed-in pool belongs to one person's profile; its name carries a short hash of that profile, never the profile.
const owner = (profile?: string) => profile ? `signed-in-${createHash('sha256').update(profile).digest('hex').slice(0, 10)}` : 'guest';
const size = () => Math.max(1, Math.min(3, Number(process.env.KERNEL_POOL_SIZE ?? 1) || 1));
const poolName = (setup: SiteSetup, profile?: string) => `aeri-${setup.domain.replace(/[^a-z0-9]+/g, '-')}-${owner(profile)}-${setup.label.replace(/[^a-z0-9]+/g, '-')}`.slice(0, 63);
const ready = new Map<string, Promise<string | null>>();

type Pooled = { session_id: string; browser_live_view_url?: string | null; cdp_ws_url: string };

/** Creates the store's pool once (matching its current setup); a setup change gets a new pool and retires the old one. */
async function ensurePool(client: Kernel, setup: SiteSetup, launch: BrowserCreateParams, profile?: string): Promise<string | null> {
  const name = poolName(setup, profile);
  if (!ready.has(name)) ready.set(name, (async () => {
    try { await client.browserPools.retrieve(name); return name; }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    // Retire this store's pools that use an older setup, so only one warm browser per store is billed.
    const prefix = `aeri-${setup.domain.replace(/[^a-z0-9]+/g, '-')}-${owner(profile)}-`;
    const stale: string[] = [];
    for await (const pool of client.browserPools.list()) if (pool.name?.startsWith(prefix) && pool.name !== name) stale.push(pool.name);
    for (const old of stale) await client.browserPools.delete(old, { force: true }).catch(() => undefined);
    const proxyId = (launch.proxy && 'id' in launch.proxy ? launch.proxy.id : undefined) ?? launch.proxy_id;
    await client.browserPools.create({
      name, size: size(), stealth: launch.stealth, headless: launch.headless, ...(launch.viewport ? { viewport: launch.viewport } : {}), ...(proxyId ? { proxy_id: proxyId } : {}),
      ...(profile ? { profile: { name: profile }, refresh_on_profile_update: true } : {}), timeout_seconds: 1200, start_url: `https://www.${setup.domain}/`,
    } as never);
    return name;
  })().catch(error => { ready.delete(name); console.warn(`Browser pool for ${setup.domain} unavailable: ${(error as Error).message}`); return null; }));
  return ready.get(name)!;
}

/**
 * A browser for this store: a warm one from its pool when possible, otherwise a new one. Pooled browsers are released
 * without reuse (they hold a cart), and the pool replaces them in the background.
 */
export async function storeBrowser(client: Kernel, setup: SiteSetup | null, launch: BrowserCreateParams, profile?: string): Promise<Pooled & { pooled: boolean }> {
  if (enabled(profile) && setup) {
    const name = await ensurePool(client, setup, launch, profile);
    if (name) {
      const warm = await client.browserPools.acquire(name, { acquire_timeout_seconds: 15 }).catch(() => null);
      if (warm?.session_id) return { ...(warm as unknown as Pooled), pooled: true };
    }
  }
  return { ...(await client.browsers.create(launch) as unknown as Pooled), pooled: false };
}

/** Warms a store's pool ahead of time (for example right after the person signs in). */
export async function warmStore(client: Kernel, setup: SiteSetup, launch: BrowserCreateParams, profile?: string) {
  if (enabled(profile)) await ensurePool(client, setup, launch, profile);
}
