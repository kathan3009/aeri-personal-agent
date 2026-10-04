import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { Webhook } from 'svix';
import { correctionSchema, unitSchema } from '@personal-agent/core';
import { hasFfmpeg, readFrame } from './media.js';
import { ProviderError, providerStatus, scrub, transcribeAudio } from './providers.js';
import { AgentService } from './service.js';
import type { Store } from './store.js';

const compareToken = (expected: string, actual: string) => {
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createApp(store: Store, accessToken = process.env.APP_ACCESS_TOKEN ?? '') {
  const app = new Hono() as Hono & { service: AgentService };
  const service = new AgentService(store);
  app.service = service;
  if (process.env.NODE_ENV !== 'production') app.use('/v1/*', cors({ origin: origin => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : '', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));
  app.get('/health', c => c.json({ ok: true, service: 'aeri-api' }));
  app.onError((error, c) => {
    if (error instanceof ProviderError) return c.json({ error: error.message, provider: error.provider }, 502);
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : scrub(error.message);
    const status = /not found/i.test(message) ? 404 : /failed|could not|needs|not configured/i.test(message) ? 503 : 400;
    return c.json({ error: message }, status);
  });
  app.use('/v1/*', async (c, next) => {
    if (!accessToken) return c.json({ error: 'APP_ACCESS_TOKEN is not configured on the API' }, 503);
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!compareToken(accessToken, token)) return c.json({ error: 'Invalid access code' }, 401);
    await next();
  });
  const wait = (c: { req: { query: (key: string) => string | undefined } }) => c.req.query('wait') === '1';
  app.get('/v1/bootstrap', async c => c.json({ state: await store.read(), providers: { ...providerStatus(), frames: await hasFfmpeg() } }));
  app.post('/v1/chat', async c => {
    const { text } = z.object({ text: z.string().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await service.chat(text));
  });
  app.post('/v1/recipes', async c => {
    const { url } = z.object({ url: z.string().url() }).parse(await c.req.json());
    return c.json(await service.recipeFromUrl(url, wait(c)));
  });
  app.post('/v1/inventory', async c => {
    const body = z.object({ name: z.string().min(1), amount: z.number().positive(), unit: unitSchema, place: z.string().max(60).optional() }).parse(await c.req.json());
    return c.json(await service.addInventory(body.name, body.amount, body.unit, 'manual', body.place));
  });
  app.patch('/v1/inventory/:id', async c => {
    const body = z.object({ amount: z.number().positive().optional(), unit: unitSchema.optional(), brand: z.string().max(80).optional(), location: z.string().max(60).optional(), expiresOn: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/).optional() }).parse(await c.req.json());
    return c.json(await service.updateInventory(c.req.param('id'), body));
  });
  app.delete('/v1/inventory/:id', async c => c.json(await service.removeInventory(c.req.param('id'))));
  app.post('/v1/preferences', async c => {
    const body = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(await c.req.json());
    await service.setPreference(body.key, body.value);
    return c.json({ ok: true });
  });
  app.delete('/v1/preferences/:key', async c => { await service.removePreference(c.req.param('key')); return c.json({ ok: true }); });
  // A recorded, library or shared video file. `purpose` picks a household map (default) or a recipe.
  app.post('/v1/scans', async c => {
    const form = await c.req.formData();
    const file = form.get('video');
    if (!(file instanceof File)) return c.json({ error: 'Video file is required' }, 400);
    if (file.size > 90_000_000) return c.json({ error: 'Video must be under 90 MB' }, 413);
    const purpose = form.get('purpose') === 'recipe' ? 'recipe' : 'household';
    const kind = z.enum(['recorded', 'library', 'file']).catch('library').parse(form.get('source'));
    const mimeType = file.type || (file.name.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
    return c.json(await service.importVideo({ data: new Uint8Array(await file.arrayBuffer()), mimeType, source: { kind, label: file.name, mimeType, sizeBytes: file.size } }, purpose, wait(c)));
  });
  app.post('/v1/videos/link', async c => {
    const body = z.object({ url: z.string().url(), purpose: z.enum(['household', 'recipe']).default('recipe') }).parse(await c.req.json());
    return c.json(await service.importLink(body.url, body.purpose, wait(c)));
  });
  app.post('/v1/scans/:id/confirm', async c => {
    const body = z.object({ decisions: z.record(z.string(), z.union([z.enum(['accepted', 'rejected']), correctionSchema])), unseen: z.record(z.string(), z.enum(['gone', 'keep'])).default({}) }).parse(await c.req.json());
    return c.json(await service.confirmKitchen(c.req.param('id'), body.decisions, body.unseen));
  });
  app.post('/v1/scans/:id/dismiss', async c => { await service.dismissScan(c.req.param('id')); return c.json({ ok: true }); });
  app.get('/v1/scans/:id/frames/:name', async c => {
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
    return c.json(await service.startPhotoSearch(new Uint8Array(await file.arrayBuffer()), file.type || 'image/jpeg', instruction, wait(c)));
  });
  app.post('/v1/photos/:id/candidates/:candidateId/verify', async c => c.json(await service.verifyCandidate(c.req.param('id'), c.req.param('candidateId'))));
  app.post('/v1/photos/:id/candidates/:candidateId/choose', async c => {
    const { acceptUncertain } = z.object({ acceptUncertain: z.boolean().default(false) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await service.chooseCandidate(c.req.param('id'), c.req.param('candidateId'), acceptUncertain));
  });
  app.post('/v1/carts/:id/compare', async c => {
    const body = z.object({ optimize: z.enum(['lowest_total', 'nearest', 'fastest', 'preferred_store']).optional(), fulfillment: z.enum(['delivery', 'pickup', 'either']).optional(), live: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
    const { live, ...overrides } = body;
    return c.json(await service.compare(c.req.param('id'), overrides, { live, wait: wait(c) }));
  });
  app.post('/v1/carts/:id/choose', async c => {
    const { basketId } = z.object({ basketId: z.string().min(1) }).parse(await c.req.json());
    return c.json(await service.chooseBasket(c.req.param('id'), basketId));
  });
  app.post('/v1/carts/:id/approve', async c => c.json(await service.approve(c.req.param('id'))));
  app.post('/v1/carts/:id/servings', async c => {
    const { servings } = z.object({ servings: z.number().int().min(1).max(24) }).parse(await c.req.json());
    return c.json(await service.setServings(c.req.param('id'), servings));
  });
  app.delete('/v1/carts/:id/items/:itemId', async c => c.json(await service.removeCartItem(c.req.param('id'), c.req.param('itemId'))));
  app.post('/v1/carts/:id/research', async c => c.json(await service.researchCart(c.req.param('id'))));
  app.post('/v1/carts/:id/cancel', async c => c.json(await service.cancel(c.req.param('id'))));
  app.post('/v1/carts/:id/checkout', async c => c.json(await service.checkout(c.req.param('id'), wait(c))));
  app.get('/v1/carts/:id/review', async c => c.json(await service.reviewLink(c.req.param('id'))));
  app.post('/v1/carts/:id/ordered', async c => {
    const { reference } = z.object({ reference: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    return c.json(await service.markOrdered(c.req.param('id'), reference));
  });
  app.post('/v1/carts/:id/received', async c => {
    const { outcome } = z.object({ outcome: z.record(z.string(), z.enum(['received', 'missing', 'substituted'])).default({}) }).parse(await c.req.json().catch(() => ({})));
    return c.json(await service.markReceived(c.req.param('id'), outcome));
  });
  app.post('/v1/voice', async c => {
    const form = await c.req.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) return c.json({ error: 'Audio file is required' }, 400);
    if (file.size > 20_000_000) return c.json({ error: 'Audio must be under 20 MB' }, 413);
    const transcript = await transcribeAudio(new Uint8Array(await file.arrayBuffer()), file.type || 'audio/m4a');
    return c.json({ transcript, ...await service.chat(transcript, 'voice') });
  });
  app.post('/webhooks/agentmail', async c => {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
    if (!secret) return c.json({ error: 'AgentMail webhook not configured' }, 503);
    const payload = await c.req.text();
    let event: { event_id?: string; event_type?: string; message?: { message_id?: string; subject?: string; preview?: string; from?: string | string[]; from_?: string | string[]; sender?: string } };
    try {
      new Webhook(secret).verify(payload, {
        'svix-id': c.req.header('svix-id') ?? '',
        'svix-timestamp': c.req.header('svix-timestamp') ?? '',
        'svix-signature': c.req.header('svix-signature') ?? '',
      });
      event = JSON.parse(payload) as typeof event;
    } catch { return c.json({ error: 'Invalid webhook signature' }, 401); }
    if (event.event_type !== 'message.received') return c.json({ ok: true });
    const eventId = event.event_id ?? c.req.header('svix-id')!;
    await store.update(state => {
      if (state.events.some(item => item.type === 'email.received' && (item.data as { eventId?: string }).eventId === eventId)) return;
      const subject = event.message?.subject ?? 'New receipt or delivery email';
      const at = new Date().toISOString();
      state.tasks.unshift({ id: randomUUID(), kind: 'receipt', title: 'Review email evidence', status: 'needs_review', detail: subject, createdAt: at, updatedAt: at });
      state.events.push({ id: randomUUID(), type: 'email.received', at, data: { eventId, messageId: event.message?.message_id, subject, preview: event.message?.preview, sender: event.message?.sender ?? event.message?.from_ ?? event.message?.from } });
    });
    return c.json({ ok: true });
  });
  return app;
}
