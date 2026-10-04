import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { Webhook } from 'svix';
import { inventoryItemSchema } from '@personal-agent/core';
import { providerStatus, transcribeAudio } from './providers.js';
import { AgentService } from './service.js';
import type { Store } from './store.js';

const compareToken = (expected: string, actual: string) => {
  const a = Buffer.from(expected), b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function createApp(store: Store, accessToken = process.env.APP_ACCESS_TOKEN ?? '') {
  const app = new Hono();
  const service = new AgentService(store);
  if (process.env.NODE_ENV !== 'production') app.use('/v1/*', cors({ origin: origin => /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin) ? origin : '', allowHeaders: ['Authorization', 'Content-Type'], allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
  app.get('/health', c => c.json({ ok: true, service: 'aeri-api' }));
  app.onError((error, c) => {
    const message = error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message;
    const status = /not found/i.test(message) ? 404 : /failed|could not|needs|not configured/i.test(message) ? 503 : 400;
    return c.json({ error: message }, status);
  });
  app.use('/v1/*', async (c, next) => {
    if (!accessToken) return c.json({ error: 'APP_ACCESS_TOKEN is not configured on the API' }, 503);
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!compareToken(accessToken, token)) return c.json({ error: 'Invalid access code' }, 401);
    await next();
  });
  app.get('/v1/bootstrap', async c => c.json({ state: await store.read(), providers: providerStatus(), phoneNumber: process.env.VAPI_PHONE_NUMBER || null }));
  app.post('/v1/chat', async c => {
    const { text } = z.object({ text: z.string().min(1).max(10000) }).parse(await c.req.json());
    return c.json(await service.chat(text));
  });
  app.post('/v1/recipes', async c => {
    const { url } = z.object({ url: z.string().url() }).parse(await c.req.json());
    return c.json(await service.recipeFromUrl(url));
  });
  app.post('/v1/inventory', async c => {
    const body = z.object({ name: z.string().min(1), amount: z.number().positive(), unit: inventoryItemSchema.shape.quantity.shape.unit }).parse(await c.req.json());
    return c.json(await service.addInventory(body.name, body.amount, body.unit));
  });
  app.post('/v1/preferences', async c => {
    const body = z.object({ key: z.string().min(1), value: z.string().min(1) }).parse(await c.req.json());
    await service.setPreference(body.key, body.value);
    return c.json({ ok: true });
  });
  app.post('/v1/scans', async c => {
    const form = await c.req.formData();
    const file = form.get('video');
    if (!(file instanceof File)) return c.json({ error: 'Video file is required' }, 400);
    if (file.size > 90_000_000) return c.json({ error: 'Video must be under 90 MB' }, 413);
    return c.json(await service.scanKitchen(new Uint8Array(await file.arrayBuffer()), file.type || 'video/mp4'));
  });
  app.post('/v1/scans/:id/confirm', async c => {
    const { decisions } = z.object({ decisions: z.record(z.string(), z.enum(['accepted', 'rejected'])) }).parse(await c.req.json());
    return c.json(await service.confirmKitchen(c.req.param('id'), decisions));
  });
  app.post('/v1/carts/:id/approve', async c => c.json(await service.approve(c.req.param('id'))));
  app.post('/v1/carts/:id/servings', async c => {
    const { servings } = z.object({ servings: z.number().int().min(1).max(24) }).parse(await c.req.json());
    return c.json(await service.setServings(c.req.param('id'), servings));
  });
  app.delete('/v1/carts/:id/items/:itemId', async c => c.json(await service.removeCartItem(c.req.param('id'), c.req.param('itemId'))));
  app.post('/v1/carts/:id/research', async c => c.json(await service.researchCart(c.req.param('id'))));
  app.post('/v1/carts/:id/checkout', async c => c.json(await service.checkout(c.req.param('id'))));
  app.post('/v1/carts/:id/ordered', async c => {
    const { reference } = z.object({ reference: z.string().min(1) }).parse(await c.req.json());
    return c.json(await service.markOrdered(c.req.param('id'), reference));
  });
  app.post('/v1/carts/:id/received', async c => c.json(await service.markReceived(c.req.param('id'))));
  app.post('/v1/voice', async c => {
    const form = await c.req.formData();
    const file = form.get('audio');
    if (!(file instanceof File)) return c.json({ error: 'Audio file is required' }, 400);
    if (file.size > 20_000_000) return c.json({ error: 'Audio must be under 20 MB' }, 413);
    const transcript = await transcribeAudio(new Uint8Array(await file.arrayBuffer()), file.type || 'audio/m4a');
    return c.json({ transcript, ...await service.chat(transcript) });
  });
  app.post('/webhooks/vapi', async c => {
    const secret = process.env.VAPI_WEBHOOK_SECRET;
    if (!secret || !compareToken(secret, c.req.header('x-vapi-secret') ?? '')) return c.json({ error: 'Unauthorized' }, 401);
    const body = await c.req.json() as { message?: { type?: string; customer?: { number?: string }; call?: { customer?: { number?: string } }; toolCallList?: Array<{ id: string; name?: string; parameters?: unknown; function?: { name?: string; arguments?: unknown } }> } };
    if (body.message?.type !== 'tool-calls') return c.json({ ok: true });
    const caller = body.message.customer?.number ?? body.message.call?.customer?.number;
    const allowed = process.env.VAPI_ALLOWED_CALLER;
    const calls = body.message.toolCallList ?? [];
    if (!allowed || caller !== allowed) return c.json({ results: calls.map(call => ({ toolCallId: call.id, error: 'This number is not paired with the personal agent.' })) });
    const results = [];
    for (const call of calls) {
      try {
        const name = call.name ?? call.function?.name;
        const rawArgs = call.parameters ?? call.function?.arguments;
        const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
        let result: string;
        if (name === 'read_memory') {
          const state = await store.read(); result = JSON.stringify({ inventory: state.inventory, preferences: state.preferences, tasks: state.tasks.slice(0, 5) });
        } else if (name === 'remember') {
          const { text, confirmed } = z.object({ text: z.string().min(1), confirmed: z.literal(true) }).parse(args);
          result = (await service.chat(text)).reply;
        } else if (name === 'start_recipe') {
          const { url, confirmed } = z.object({ url: z.string().url(), confirmed: z.literal(true) }).parse(args);
          const created = await service.recipeFromUrl(url); result = `Draft cart ${created.cart.id} created for ${created.recipe.title}. Review it in the app before checkout.`;
        } else result = `Unknown tool ${name}`;
        results.push({ name, toolCallId: call.id, result });
      } catch (error) { results.push({ toolCallId: call.id, error: (error as Error).message }); }
    }
    return c.json({ results });
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
