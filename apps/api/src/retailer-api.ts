import Kernel from '@onkernel/sdk';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { beginMerchantAuth, disconnectMerchantAuth, merchantAuthStatus, retailerDomain } from './merchant-auth.js';
import { findSignInCode, mailboxConfigured } from './mailbox.js';
import { answerEmailCode, signInBrowser } from './store-auth.js';
import type { AppEnv } from './people.js';

type Options = { client?: Kernel; now?: () => string };
/** The root app signs the person in before these routes run. IDs come only from that person's private store metadata. */
// When each person's store sign-in began, so a code is only ever read for a sign-in that person started.
const signInStarted = new Map<string, number>();
// How many stores can stay signed in at once. Set KERNEL_MAX_STORE_CONNECTIONS to match your Kernel plan.
const maxConnections = () => { const n = Number(process.env.KERNEL_MAX_STORE_CONNECTIONS ?? 10); return Number.isInteger(n) && n > 0 ? n : 10; };
export function registerRetailerRoutes(app: Hono<AppEnv>, options: Options = {}): void {
  const who = (c: Context<AppEnv>) => { const { user, store } = c.get('person'); return { user, store, accountScope: user.kernelScope, started: (domain: string) => `${user.id}:${domain}` }; };
  const now = options.now ?? (() => new Date().toISOString());
  const client = () => {
    if (options.client) return options.client;
    if (!process.env.KERNEL_API_KEY) throw new Error('Kernel is not configured for retailer account connections');
    return new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  };
  const domainParam = (input: string) => {
    const value = z.string().min(3).max(253).parse(input);
    return retailerDomain(value);
  };
  // Serialize each person's create/disconnect so concurrent taps cannot exceed their connection limit or race profile deletion.
  const mutations = new Map<string, Promise<unknown>>();
  const serialize = <T>(userId: string, action: () => Promise<T>) => { const next = (mutations.get(userId) ?? Promise.resolve()).then(action); mutations.set(userId, next.catch(() => {})); return next; };
  const presentation = (state: Awaited<ReturnType<typeof merchantAuthStatus>>) => ({ connected: state.status === 'AUTHENTICATED' && (!state.flowStatus || state.flowStatus === 'SUCCESS'),
    status: state.status, flowStatus: state.flowStatus, ...(state.hostedUrl ? { hostedUrl: state.hostedUrl } : {}), ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}) });

  // Stores with a saved sign-in, plus well-known ones to suggest. The phone shows these without guessing.
  app.get('/v1/retailers', async c => c.json({ connected: (await who(c).store.listMerchantConnections()).map(entry => entry.merchant), suggested: ['target.com', 'walmart.com', 'instacart.com', 'amazon.com', 'costco.com', 'kroger.com'] }));
  // A code the store emailed for a sign-in started here in the last 15 minutes. Read on request, never stored.
  app.get('/v1/retailers/:domain/code', async c => {
    const domain = domainParam(c.req.param('domain')), { user, store, started: key } = who(c);
    const started = signInStarted.get(key(domain));
    if (!mailboxConfigured() || !user.mailbox || !started || Date.now() - started > 15 * 60_000) return c.json({ code: null });
    const saved = await store.getMerchantConnection(domain);
    if (!saved) return c.json({ code: null });
    const state = await merchantAuthStatus(client(), saved.connectionId, `https://${domain}`);
    if (state.status === 'AUTHENTICATED') { signInStarted.delete(key(domain)); return c.json({ code: null }); }
    return c.json({ code: await findSignInCode(user.mailbox.inboxId, domain, new Date(started - 30_000)) });
  });
  app.get('/v1/retailers/:domain/auth', async c => {
    const domain = domainParam(c.req.param('domain')), { user, store, started: key } = who(c), saved = await store.getMerchantConnection(domain);
    if (!saved) return c.json({ connected: false, status: 'NOT_CONNECTED' });
    // While the person is signing in, enter a code the store emailed to their Aeri inbox, if it asks for one.
    const started = signInStarted.get(key(domain));
    if (started) {
      const raw = await client().auth.connections.retrieve(saved.connectionId).catch(() => null);
      if (raw) await answerEmailCode(client(), raw, domain, new Date(started - 30_000), user.mailbox?.inboxId).catch(() => false);
    }
    return c.json(presentation(await merchantAuthStatus(client(), saved.connectionId, `https://${domain}`)));
  });
  app.post('/v1/retailers/:domain/auth', async c => {
    const domain = domainParam(c.req.param('domain')), { user, store, accountScope, started: key } = who(c);
    const { remember } = z.object({ consent: z.literal(true), remember: z.boolean().optional() }).strict().parse(await c.req.json());
    return serialize(user.id, async () => {
      const saved = await store.getMerchantConnection(domain);
      if (!saved) {
        let existing = await store.listMerchantConnections();
        if (existing.length >= maxConnections()) {
          // Failed or expired sign-ins don't hold a place; clear them before asking the person to disconnect a store.
          for (const entry of existing) {
            const state = await merchantAuthStatus(client(), entry.connectionId, `https://${entry.merchant}`).catch(error => { if ((error as { status?: number }).status === 404) return null; throw error; });
            const inProgress = state?.flowStatus === 'IN_PROGRESS' && (!state.expiresAt || Date.parse(state.expiresAt) > Date.now());
            if (state?.status === 'AUTHENTICATED' || inProgress) continue;
            if (state) await disconnectMerchantAuth(client(), entry.connectionId, `https://${entry.merchant}`, accountScope).catch(() => undefined);
            await store.deleteMerchantConnection(entry.merchant);
          }
          existing = await store.listMerchantConnections();
          if (existing.length >= maxConnections()) return c.json({ error: `You have ${existing.length} stores connected (${existing.map(entry => entry.merchant).join(', ')}). Disconnect one to add ${domain}.` }, 409);
        }
      }
      let auth: Awaited<ReturnType<typeof beginMerchantAuth>>;
      // Sign in with the store's working setup, so the session the store remembers matches the carts Aeri fills later.
      const browser = await signInBrowser(client(), domain);
      try { auth = await beginMerchantAuth(client(), `https://${domain}`, accountScope, true, browser, remember === true); }
      catch (error) {
        // The browser service's own plan limit, said plainly instead of as a provider error.
        if (/limit|quota|exceed|upgrade|plan/i.test((error as Error).message)) return c.json({ error: 'Kernel, the private browser service, won’t save more store sign-ins on your current plan. Disconnect a store, then try again.' }, 409);
        throw error;
      }
      signInStarted.set(key(domain), Date.now());
      await store.setMerchantConnection({ merchant: domain, connectionId: auth.connectionId, createdAt: saved?.createdAt ?? now() });
      // Never save hosted URLs, cookies, passwords or profile details in app state or event history.
      return c.json(presentation(auth));
    });
  });
  app.delete('/v1/retailers/:domain/auth', async c => {
    const domain = domainParam(c.req.param('domain')), { user, store, accountScope } = who(c);
    return serialize(user.id, async () => {
      const saved = await store.getMerchantConnection(domain);
      if (!saved) return c.json({ ok: true });
      const state = await store.read();
      const carts = state.carts.filter(cart => {
        try { return !!cart.checkoutUrl && retailerDomain(cart.checkoutUrl) === domain; } catch { return false; }
      });
      const kernel = client(), sessions = new Set<string>();
      for (const cart of carts) {
        const live = await store.getLiveView(cart.id);
        if (live) sessions.add(live.sessionId);
        if (cart.checkout?.sessionId && !cart.checkout.closedAt) sessions.add(cart.checkout.sessionId);
      }
      for (const session of sessions) {
        try { await kernel.browsers.deleteByID(session); }
        catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      }
      for (const cart of carts) await store.deleteLiveView(cart.id);
      await store.update(current => {
        for (const cart of current.carts.filter(cart => carts.some(prior => prior.id === cart.id))) {
          if (cart.purchaseApproval?.status === 'active') cart.purchaseApproval = { ...cart.purchaseApproval, status: 'invalidated', invalidatedAt: now(), invalidationReason: 'Retailer account disconnected' };
          delete cart.checkoutSnapshot;
          if (cart.checkout && !cart.checkout.closedAt) {
            cart.checkout.closedAt = now(); cart.checkout.status = 'failed'; delete cart.checkout.sessionId;
            cart.checkout.note = 'Retailer account disconnected. Prepare a new store cart to continue.';
            if (cart.status === 'checkout_ready') cart.status = 'approved';
            cart.updatedAt = now();
          }
        }
      });
      await disconnectMerchantAuth(kernel, saved.connectionId, `https://${domain}`, accountScope);
      await store.deleteMerchantConnection(domain);
      return c.json({ ok: true });
    });
  });
}
