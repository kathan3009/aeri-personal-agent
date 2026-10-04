import { createHash } from 'node:crypto';
import Kernel from '@onkernel/sdk';
import type { Hono } from 'hono';
import { z } from 'zod';
import { beginMerchantAuth, disconnectMerchantAuth, merchantAuthStatus, retailerDomain, retailerDomains } from './merchant-auth.js';
import type { Store } from './store.js';

type Options = { client?: Kernel; now?: () => string };
/** Root app installs its access-token middleware before registering these routes. IDs come only from private Store metadata. */
export function registerRetailerRoutes(app: Hono, store: Store, accessToken: string, options: Options = {}): void {
  const accountScope = createHash('sha256').update(accessToken).digest('hex').slice(0, 24);
  const now = options.now ?? (() => new Date().toISOString());
  const client = () => {
    if (options.client) return options.client;
    if (!process.env.KERNEL_API_KEY) throw new Error('Kernel is not configured for retailer account connections');
    return new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  };
  const domainParam = (input: string) => {
    const value = z.enum(retailerDomains).parse(input);
    return retailerDomain(value);
  };
  // Serialize create/disconnect so concurrent taps cannot exceed the free-plan connection limit or race profile deletion.
  let mutation: Promise<unknown> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>) => { const next = mutation.then(action); mutation = next.catch(() => {}); return next; };
  const presentation = (state: Awaited<ReturnType<typeof merchantAuthStatus>>) => ({ connected: state.status === 'AUTHENTICATED' && (!state.flowStatus || state.flowStatus === 'SUCCESS'),
    status: state.status, flowStatus: state.flowStatus, ...(state.hostedUrl ? { hostedUrl: state.hostedUrl } : {}), ...(state.expiresAt ? { expiresAt: state.expiresAt } : {}) });

  app.get('/v1/retailers/:domain/auth', async c => {
    const domain = domainParam(c.req.param('domain')), saved = await store.getMerchantConnection(domain);
    if (!saved) return c.json({ connected: false, status: 'NOT_CONNECTED' });
    return c.json(presentation(await merchantAuthStatus(client(), saved.connectionId, `https://${domain}`)));
  });
  app.post('/v1/retailers/:domain/auth', async c => {
    const domain = domainParam(c.req.param('domain'));
    z.object({ consent: z.literal(true) }).strict().parse(await c.req.json());
    return serialize(async () => {
      const saved = await store.getMerchantConnection(domain);
      if (!saved) {
        const existing = await Promise.all(retailerDomains.map(d => store.getMerchantConnection(d)));
        if (existing.filter(Boolean).length >= 3) return c.json({ error: 'The free plan supports three retailer connections; disconnect one first' }, 409);
      }
      const auth = await beginMerchantAuth(client(), `https://${domain}`, accountScope, true);
      await store.setMerchantConnection({ merchant: domain, connectionId: auth.connectionId, createdAt: saved?.createdAt ?? now() });
      // Never save hosted URLs, cookies, passwords or profile details in app state or event history.
      return c.json(presentation(auth));
    });
  });
  app.delete('/v1/retailers/:domain/auth', async c => {
    const domain = domainParam(c.req.param('domain'));
    return serialize(async () => {
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
