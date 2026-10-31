import Kernel from '@onkernel/sdk';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { Webhook } from 'svix';
import { correctionSchema, unitSchema } from '@personal-agent/core';
import { normalizeEmail, type Accounts, type User } from './accounts.js';
import { runAs } from './context.js';
import { usageFor } from './gateway-budget.js';
import { privacyPage, termsPage } from './legal.js';
import { hasFfmpeg, readFrame, removeFrames } from './media.js';
import { closeSession } from './market.js';
import { disconnectMerchantAuth } from './merchant-auth.js';
import { captureError, logRequest } from './monitoring.js';
import type { AppEnv, People } from './people.js';
import { ProviderError, providerStatus, scrub, transcribeAudio } from './providers.js';
import { createLimiter } from './rate-limit.js';
import { registerRetailerRoutes } from './retailer-api.js';
import { connectMailbox, disconnectMailbox, mailboxConfigured, mailboxStatus, recordEmail, sendSignInCode } from './mailbox.js';
import { siteSetupReport } from './site-config.js';

export type AppDeps = {
  accounts: Accounts;
  people: People;
  /** Sends a sign-in code; false when email isn't set up. Tests pass their own. */
  sendCode?: (email: string, code: string) => Promise<boolean>;
  kernel?: () => Kernel | null;
  retailer?: { client?: Kernel; now?: () => string };
};

const publicUser = (user: User) => ({ email: user.email, createdAt: user.createdAt, mailbox: user.mailbox ? { address: user.mailbox.address } : null });
const clientAddress = (c: Context) => c.req.header('fly-client-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0].trim() ?? 'local';
// Requests that run AI models or private browsers get a tighter per-person limit than reading and editing.
const heavy = /^\/v1\/(chat|voice|photos|scans|videos|recipes|carts\/[^/]+\/(compare|checkout|finish|research|summary))(\/|$)/;

export function createApp(deps: AppDeps) {
  const { accounts, people } = deps;
  const app = new Hono<AppEnv>();
  const limit = createLimiter();
  const sendCode = deps.sendCode ?? sendSignInCode;
  const kernel = deps.kernel ?? (() => process.env.KERNEL_API_KEY ? new Kernel({ apiKey: process.env.KERNEL_API_KEY }) : null);
  const admins = new Set((process.env.AERI_ADMIN_EMAILS ?? '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean));

  if (process.env.NODE_ENV !== 'production') app.use('/v1/*', cors({ origin: origin => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : '', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    logRequest({ method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started, userId: c.get('person')?.user.id });
  });
  app.get('/health', c => c.json({ ok: true, service: 'aeri-api' }));
  app.get('/privacy', c => c.html(privacyPage()));
  app.get('/terms', c => c.html(termsPage()));
  app.onError((error, c) => {
    if (error instanceof ProviderError) return c.json({ error: error.message, provider: error.provider }, 502);
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : scrub(error.message);
    const status = /not found/i.test(message) ? 404 : /limit|too many|wait \d+ seconds/i.test(message) ? 429 : /failed|could not|needs|not configured|isn’t set up/i.test(message) ? 503 : 400;
    if (status >= 500 || !(error instanceof z.ZodError) && status === 400 && /cannot read|undefined|is not a function/i.test(error.message)) captureError(error, { userId: c.get('person')?.user.id, route: c.req.routePath });
    return c.json({ error: message }, status);
  });

  // ── Sign in: a one-time code sent to the person's email ─────────────────
  app.post('/v1/auth/code', async c => {
    const address = limit(`code-ip:${clientAddress(c)}`, 10, 15 * 60_000);
    if (!address.ok) return c.json({ error: `Too many attempts. Try again in ${Math.ceil(address.retryAfter / 60)} minutes.` }, 429);
    const { email } = z.object({ email: z.string().max(254) }).parse(await c.req.json());
    const { code, email: normalized } = await accounts.requestCode(email);
    const sent = await sendCode(normalized, code);
    if (!sent) {
      // Without email, only a development server may show the code (so it can be tested on a laptop).
      if (process.env.NODE_ENV === 'production') return c.json({ error: 'Sign-in emails aren’t set up on this server.' }, 503);
      console.warn(`[auth] development sign-in code for ${normalized}: ${code}`);
      return c.json({ sent: false, devCode: code });
    }
    return c.json({ sent: true });
  });
  app.post('/v1/auth/verify', async c => {
    const address = limit(`verify-ip:${clientAddress(c)}`, 30, 15 * 60_000);
    if (!address.ok) return c.json({ error: `Too many attempts. Try again in ${Math.ceil(address.retryAfter / 60)} minutes.` }, 429);
    const body = z.object({ email: z.string().max(254), code: z.string().max(20), acceptTerms: z.boolean().optional() }).parse(await c.req.json());
    const { token, user: signedIn, created } = await accounts.verifyCode(body.email, body.code, body.acceptTerms === true);
    let user = signedIn;
    // The owner's Aeri address from before accounts (already in their Gmail forwarding) is linked right away.
    if (created && user.id === 'default' && process.env.AGENTMAIL_INBOX_ID && mailboxConfigured()) {
      user = await connectMailbox(user).then(mailbox => accounts.setMailbox(user.id, mailbox)).catch(() => user);
    }
    if (created) await runAs(user.id, () => people.forUser(user).service.recoverInterrupted()).catch(() => undefined);
    return c.json({ token, user: publicUser(user), created });
  });

  // ── Everything else is for a signed-in person, and only ever their own data ──
  app.use('/v1/*', async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const user = token ? await accounts.userForToken(token) : null;
    if (!user) return c.json({ error: 'Your session ended. Sign in again.' }, 401);
    const allowed = limit(`person:${user.id}`, 300, 60_000).ok && (!heavy.test(c.req.path) || limit(`heavy:${user.id}`, 30, 60_000).ok);
    if (!allowed) return c.json({ error: 'Too many requests. Wait a moment and try again.' }, 429);
    c.set('person', people.forUser(user));
    return runAs(user.id, () => next());
  });
  app.post('/v1/auth/sign-out', async c => { await accounts.signOut(c.req.header('authorization')!.replace(/^Bearer\s+/i, '')); return c.json({ ok: true }); });
  app.get('/v1/me', async c => { const { user } = c.get('person'); return c.json({ user: publicUser(user), usage: await usageFor(user.id) }); });
  // A copy of everything Aeri keeps for this person.
  app.get('/v1/account/export', async c => {
    const { user, store } = c.get('person');
    c.header('Content-Disposition', 'attachment; filename="aeri-export.json"');
    return c.json({ exportedAt: new Date().toISOString(), account: publicUser(user), stores: (await store.listMerchantConnections()).map(entry => entry.merchant), state: await store.read() });
  });
  // Deletes the account and everything that belongs to it: store sign-ins at Kernel, open store browsers, the Aeri
  // inbox, saved frames and all stored data. Requires typing the account email, so it can't happen by accident.
  app.delete('/v1/account', async c => {
    const { user, store, service } = c.get('person');
    const { confirm } = z.object({ confirm: z.string() }).parse(await c.req.json().catch(() => ({})));
    if (normalizeEmail(confirm) !== user.email) return c.json({ error: 'Type your account email to confirm.' }, 400);
    await service.idle();
    const client = kernel(), state = await store.read();
    for (const cart of state.carts) { const live = await store.getLiveView(cart.id); await closeSession(live?.sessionId ?? cart.checkout?.sessionId); }
    if (client) for (const entry of await store.listMerchantConnections()) await disconnectMerchantAuth(client, entry.connectionId, `https://${entry.merchant}`, user.kernelScope).catch(error => captureError(error, { userId: user.id, route: 'account-delete' }));
    if (user.mailbox) await disconnectMailbox(user.mailbox).catch(error => captureError(error, { userId: user.id, route: 'account-delete' }));
    for (const scan of state.scans) await removeFrames(scan.id);
    await store.wipe();
    await people.forget(user.id);
    await accounts.deleteUser(user.id);
    return c.json({ ok: true });
  });
  // The person's own Aeri email address: one tap to create it, one to remove it.
  app.get('/v1/mailbox', async c => c.json(mailboxStatus(c.get('person').user)));
  app.post('/v1/mailbox/connect', async c => {
    const person = c.get('person');
    if (!mailboxConfigured()) return c.json({ error: 'Email isn’t set up on this Aeri server yet.' }, 503);
    const mailbox = await connectMailbox(person.user);
    const user = await accounts.setMailbox(person.user.id, mailbox);
    people.forUser(user);
    return c.json(mailboxStatus(user));
  });
  app.delete('/v1/mailbox', async c => {
    const person = c.get('person');
    if (person.user.mailbox) await disconnectMailbox(person.user.mailbox);
    const user = await accounts.setMailbox(person.user.id, null);
    people.forUser(user);
    return c.json(mailboxStatus(user));
  });
  registerRetailerRoutes(app, deps.retailer ?? {});
  const wait = (c: { req: { query: (key: string) => string | undefined } }) => c.req.query('wait') === '1';
  const svc = (c: Context<AppEnv>) => c.get('person').service;
  app.get('/v1/bootstrap', async c => { const { user, store } = c.get('person'); return c.json({ state: await store.read(), account: publicUser(user), providers: { ...providerStatus(), frames: await hasFfmpeg() } }); });
  app.post('/v1/chat', async c => {
    const { text } = z.object({ text: z.string().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await svc(c).chat(text));
  });
  app.post('/v1/recipes', async c => {
    const { url } = z.object({ url: z.string().url() }).parse(await c.req.json());
    return c.json(await svc(c).recipeFromUrl(url, wait(c)));
  });
  app.post('/v1/inventory', async c => {
    const body = z.object({ name: z.string().min(1), amount: z.number().positive(), unit: unitSchema, place: z.string().max(60).optional() }).parse(await c.req.json());
    return c.json(await svc(c).addInventory(body.name, body.amount, body.unit, 'manual', body.place));
  });
  app.patch('/v1/inventory/:id', async c => {
    const body = z.object({ amount: z.number().positive().optional(), unit: unitSchema.optional(), brand: z.string().max(80).optional(), location: z.string().max(60).optional(), expiresOn: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional() }).parse(await c.req.json());
    return c.json(await svc(c).updateInventory(c.req.param('id'), body));
  });
  app.delete('/v1/inventory/:id', async c => c.json(await svc(c).removeInventory(c.req.param('id'))));
  app.post('/v1/preferences', async c => {
    const body = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(await c.req.json());
    await svc(c).setPreference(body.key, body.value);
    return c.json({ ok: true });
  });
  app.delete('/v1/preferences/:key', async c => { await svc(c).removePreference(c.req.param('key')); return c.json({ ok: true }); });
  // A recorded, library or shared video file. `purpose` picks a household map (default) or a recipe.
  app.post('/v1/scans', async c => {
    const form = await c.req.formData();
    const file = form.get('video');
    if (!(file instanceof File)) return c.json({ error: 'Video file is required' }, 400);
    if (file.size > 90_000_000) return c.json({ error: 'Video must be under 90 MB' }, 413);
    const purpose = form.get('purpose') === 'recipe' ? 'recipe' : 'household';
    const kind = z.enum(['recorded', 'library', 'file']).catch('library').parse(form.get('source'));
    const mimeType = file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
    return c.json(await svc(c).importVideo({ data: new Uint8Array(await file.arrayBuffer()), mimeType, source: { kind, label: file.name, mimeType, sizeBytes: file.size } }, purpose, wait(c)));
  });
  app.post('/v1/videos/link', async c => {
    const body = z.object({ url: z.string().url(), purpose: z.enum(['household', 'recipe']).default('recipe') }).parse(await c.req.json());
    return c.json(await svc(c).importLink(body.url, body.purpose, wait(c)));
  });
  app.post('/v1/scans/:id/confirm', async c => {
    const body = z.object({ decisions: z.record(z.string(), z.union([z.enum(['accepted', 'rejected']), correctionSchema])), unseen: z.record(z.string(), z.enum(['gone', 'keep'])).default({}) }).parse(await c.req.json());
    return c.json(await svc(c).confirmKitchen(c.req.param('id'), body.decisions, body.unseen));
  });
  app.post('/v1/scans/:id/dismiss', async c => { await svc(c).dismissScan(c.req.param('id')); return c.json({ ok: true }); });
  app.get('/v1/scans/:id/frames/:name', async c => {
    // Frames are filed by scan; only the person who made the scan can read them.
    if (!(await c.get('person').store.read()).scans.some(scan => scan.id === c.req.param('id'))) return c.json({ error: 'Frame not found' }, 404);
    const frame = await readFrame(c.req.param('id'), c.req.param('name'));
    if (!frame) return c.json({ error: 'Frame not found' }, 404);
    return c.body(frame as Uint8Array<ArrayBuffer>, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
  });
  app.post('/v1/photos', async c => {
    const form = await c.req.formData();
    const file = form.get('image');
    if (!(file instanceof File)) return c.json({ error: 'Photo is required' }, 400);
    if (file.size > 15_000_000) return c.json({ error: 'Photo must be under 15 MB' }, 413);
    const instruction = String(form.get('instruction') ?? '').slice(0, 300);
    return c.json(await svc(c).startPhotoSearch(new Uint8Array(await file.arrayBuffer()), file.type || 'image/jpeg', instruction, wait(c)));
  });
  app.delete('/v1/photos/:id', async c => c.json(await svc(c).dismissPhotoSearch(c.req.param('id'))));
  app.post('/v1/photos/:id/candidates/:candidateId/verify', async c => c.json(await svc(c).verifyCandidate(c.req.param('id'), c.req.param('candidateId'))));
  app.post('/v1/photos/:id/candidates/:candidateId/choose', async c => {
    const { acceptUncertain } = z.object({ acceptUncertain: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await svc(c).chooseCandidate(c.req.param('id'), c.req.param('candidateId'), acceptUncertain));
  });
  app.post('/v1/carts/:id/compare', async c => {
    const body = z.object({ optimize: z.enum(['lowest_total', 'nearest', 'fastest', 'preferred_store']).optional(), fulfillment: z.enum(['delivery', 'pickup', 'either']).optional(), live: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const { live, ...overrides } = body;
    return c.json(await svc(c).compare(c.req.param('id'), overrides, { live, wait: wait(c) }));
  });
  app.post('/v1/carts/:id/choose', async c => {
    const { basketId } = z.object({ basketId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await svc(c).chooseBasket(c.req.param('id'), basketId));
  });
  app.post('/v1/carts/:id/approve', async c => c.json(await svc(c).approve(c.req.param('id'))));
  app.post('/v1/carts/:id/servings', async c => {
    const { servings } = z.object({ servings: z.number().int().min(1).max(24) }).parse(await c.req.json());
    return c.json(await svc(c).setServings(c.req.param('id'), servings));
  });
  app.delete('/v1/carts/:id/items/:itemId', async c => c.json(await svc(c).removeCartItem(c.req.param('id'), c.req.param('itemId'))));
  app.post('/v1/carts/:id/items/:itemId/restore', async c => c.json(await svc(c).restoreCartItem(c.req.param('id'), c.req.param('itemId'))));
  app.post('/v1/carts/:id/research', async c => c.json(await svc(c).researchCart(c.req.param('id'))));
  app.post('/v1/carts/:id/cancel', async c => c.json(await svc(c).cancel(c.req.param('id'))));
  app.post('/v1/carts/:id/checkout', async c => c.json(await svc(c).checkout(c.req.param('id'), wait(c))));
  // Adds the items a store visit left behind (after the person confirmed their age, signed in, or to retry).
  app.post('/v1/carts/:id/finish', async c => {
    const { confirmAge } = z.object({ confirmAge: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    return c.json(await svc(c).finishItems(c.req.param('id'), { confirmAge }));
  });
  app.get('/v1/carts/:id/review', async c => c.json(await svc(c).reviewLink(c.req.param('id'))));
  app.get('/v1/carts/:id/summary', async c => c.json(await svc(c).checkoutSummary(c.req.param('id'))));
  app.post('/v1/carts/:id/purchase-approval', async c => {
    const { snapshotId, maximumTotalCents } = z.object({ snapshotId: z.string().min(1), maximumTotalCents: z.number().int().nonnegative() }).parse(await c.req.json());
    return c.json(await svc(c).approvePurchase(c.req.param('id'), snapshotId, maximumTotalCents));
  });
  app.post('/v1/carts/:id/ordered', async c => {
    const { reference } = z.object({ reference: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    return c.json(await svc(c).markOrdered(c.req.param('id'), reference));
  });
  app.post('/v1/carts/:id/received', async c => {
    const { outcome } = z.object({ outcome: z.record(z.string(), z.enum(['received', 'missing', 'substituted'])).default({}) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await svc(c).markReceived(c.req.param('id'), outcome));
  });
  app.post('/v1/voice', async c => {
    const form = await c.req.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) return c.json({ error: 'Audio file is required' }, 400);
    if (file.size > 20_000_000) return c.json({ error: 'Audio must be under 20 MB' }, 413);
    const transcript = await transcribeAudio(new Uint8Array(await file.arrayBuffer()), file.type || 'audio/m4a');
    return c.json({ transcript, ...await svc(c).chat(transcript, 'voice') });
  });
  // Which browser setup Aeri uses for each store, and how it has gone (diagnostics, for admins only).
  app.get('/v1/sites', async c => admins.has(c.get('person').user.email) ? c.json(await siteSetupReport()) : c.json({ error: 'Not found' }, 404));
  app.post('/webhooks/agentmail', async c => {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'AgentMail webhook not configured' }, 503);
    const payload = await c.req.text();
    let event: { event_id?: string; event_type?: string; message?: { inbox_id?: string; message_id?: string; subject?: string; preview?: string; text?: string; from?: string | string[]; from_?: string | string[]; sender?: string } };
    try {
      new Webhook(secret).verify(payload, {
        'svix-id': c.req.header('svix-id') ?? '',
        'svix-timestamp': c.req.header('svix-timestamp') ?? '',
        'svix-signature': c.req.header('svix-signature') ?? '',
      });
      event = z.object({ event_id: z.string().max(1000).optional(), event_type: z.string().max(100), message: z.object({ inbox_id: z.string().max(500).optional(), message_id: z.string().max(1000).optional(), subject: z.string().max(10000).optional(), preview: z.string().max(100000).optional(), text: z.string().max(1000000).optional(), from: z.union([z.string().max(500), z.array(z.string().max(500)).max(20)]).optional(), from_: z.union([z.string().max(500), z.array(z.string().max(500)).max(20)]).optional(), sender: z.string().max(500).optional() }).optional() }).parse(JSON.parse(payload));
    } catch { return c.json({ error: 'Invalid webhook signature' }, 401); }
    if (event.event_type !== 'message.received') return c.json({ ok: true });
    const eventId = event.event_id ?? c.req.header('svix-id')!;
    if (!eventId) return c.json({ ok: true });
    const message = event.message;
    // Mail is routed by inbox: each person's address belongs to them alone. Unknown inboxes are ignored.
    const owner = message?.inbox_id ? await accounts.userForInbox(message.inbox_id) : null;
    if (!owner) return c.json({ ok: true });
    await runAs(owner.id, () => recordEmail(people.forUser(owner).store, { id: message?.message_id ?? eventId, subject: message?.subject, preview: message?.preview, text: message?.text, sender: message?.sender ?? message?.from_ ?? message?.from }, message!.inbox_id));
    return c.json({ ok: true });
  });
  return app;
}
