import { randomUUID } from 'node:crypto';
import type Kernel from '@onkernel/sdk';
import { findSignInCode, mailboxConfigured } from './mailbox.js';
import { warmStore } from './kernel-pools.js';
import { launchOptions, siteSetup } from './site-config.js';
import type { User } from './accounts.js';
import type { Store } from './store.js';

/**
 * Keeps store sign-ins working without the person (Kernel Managed Auth):
 * - health checks every few hours tell Aeri when a session expired,
 * - automatic re-sign-in uses credentials Kernel saved at the person's sign-in (Aeri never sees them),
 * - an emailed one-time code is read from the person's own Aeri inbox and entered for the store that asked,
 * - each sign-in uses its store's working browser setup, so the store sees the same kind of IP for sign-in and carts.
 */
export const HEALTH_CHECK_SECONDS = Number(process.env.KERNEL_HEALTH_CHECK_SECONDS ?? 21_600);
export const authDefaults = { health_checks: true, health_check_interval: HEALTH_CHECK_SECONDS, auto_reauth: true };

type Connection = Awaited<ReturnType<Kernel['auth']['connections']['retrieve']>>;
const aligned = new Set<string>();

/** The store's sign-in browser settings (stealth and named proxy) from its working setup. */
export async function signInBrowser(client: Kernel, domain: string) {
  const setup = await siteSetup(client, `https://www.${domain}/`).catch(() => null);
  const launch = setup ? await launchOptions(client, setup).catch(() => null) : null;
  return launch ? { stealth: !!launch.stealth, ...(launch.proxy && 'id' in launch.proxy && launch.proxy.id ? { proxy: { id: launch.proxy.id } } : {}) } : undefined;
}

/** Brings an older sign-in up to date once per run: health checks, re-sign-in and the store's current setup. */
export async function alignConnection(client: Kernel, connection: Connection, domain: string) {
  if (aligned.has(connection.id)) return;
  aligned.add(connection.id);
  const browser = await signInBrowser(client, domain);
  const proxyId = connection.browser?.proxy && 'id' in connection.browser.proxy ? connection.browser.proxy.id : undefined;
  const stale = !connection.health_checks || connection.auto_reauth === false || (browser && (connection.browser?.stealth !== browser.stealth || (browser.proxy && proxyId !== browser.proxy.id)));
  if (!stale) return;
  await client.auth.connections.update(connection.id, { ...authDefaults, ...(browser ? { browser: { ...browser, telemetry: { enabled: false } } } : {}) } as never)
    .catch(error => { aligned.delete(connection.id); console.warn(`Couldn't update the ${domain} sign-in: ${(error as Error).message}`); });
}

const submitted = new Set<string>();
/**
 * When a sign-in (the person's or an automatic re-sign-in) is waiting for an emailed code, fetch it from Aeri's inbox
 * (only from that store's own domain, only mail that arrived after the flow began) and enter it. Codes aren't saved.
 */
export async function answerEmailCode(client: Kernel, connection: Connection, domain: string, since: Date, inboxId: string | undefined): Promise<boolean> {
  if (!mailboxConfigured() || !inboxId || connection.flow_status !== 'IN_PROGRESS' || connection.flow_step !== 'AWAITING_INPUT') return false;
  const field = (connection.fields ?? []).find(entry => entry.type === 'code');
  if (!field) return false;
  const found = await findSignInCode(inboxId, domain, since).catch(() => null);
  if (!found || submitted.has(`${connection.id}:${found.code}`)) return false;
  submitted.add(`${connection.id}:${found.code}`);
  await client.auth.connections.submit(connection.id, { field_values: { [field.id]: found.code }, ...(connection.interaction_id ? { interaction_id: connection.interaction_id } : {}) } as never);
  return true;
}

/**
 * Every two minutes: finish automatic re-sign-ins that need an emailed code, warm signed-in stores, and tell the
 * person (once) when a store needs them to sign in again.
 */
export function startAuthWatcher(people: () => Promise<Array<{ user: User; store: Store }>>, client: () => Kernel | null, everyMs = 120_000) {
  const flowStarted = new Map<string, number>();
  const tick = async () => {
    const kernel = client();
    if (!kernel) return;
    for (const { user, store } of await people().catch(() => [])) await check(kernel, user, store);
  };
  const check = async (kernel: Kernel, user: User, store: Store) => {
    for (const saved of await store.listMerchantConnections().catch(() => [])) {
      try {
        const connection = await kernel.auth.connections.retrieve(saved.connectionId);
        await alignConnection(kernel, connection, saved.merchant);
        if (connection.flow_status === 'IN_PROGRESS') {
          if (!flowStarted.has(connection.id)) flowStarted.set(connection.id, Date.now() - 60_000);
          await answerEmailCode(kernel, connection, saved.merchant, new Date(flowStarted.get(connection.id)!), user.mailbox?.inboxId);
          continue;
        }
        flowStarted.delete(connection.id);
        if (connection.status === 'AUTHENTICATED') {
          const setup = await siteSetup(kernel, `https://www.${saved.merchant}/`).catch(() => null);
          if (setup) await warmStore(kernel, setup, await launchOptions(kernel, setup), connection.profile_name).catch(() => undefined);
          continue;
        }
        // Expired and Kernel couldn't sign back in by itself: one task asking the person to sign in again.
        await store.update(state => {
          const title = `Sign in to ${saved.merchant} again`;
          if (state.tasks.some(task => task.title === title && task.status === 'needs_review')) return;
          const at = new Date().toISOString();
          state.tasks.unshift({ id: randomUUID(), kind: 'checkout', title, status: 'needs_review', createdAt: at, updatedAt: at,
            detail: connection.can_reauth_reason === 'requires_sms_code' ? 'The store sent a text message code. Open Store accounts and sign in.' : 'Your saved session expired. Open Memory, then Store accounts, to sign in.' });
        });
      } catch { /* a store's check failing shouldn't stop the others */ }
    }
  };
  const first = setTimeout(() => void tick(), 10_000);
  const timer = setInterval(() => void tick(), everyMs);
  return () => { clearTimeout(first); clearInterval(timer); };
}
