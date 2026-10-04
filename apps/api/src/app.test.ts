import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Webhook } from 'svix';
import { createApp } from './app.js';
import { createStore, type Store } from './store.js';

let directory = ''; let store: Store;
afterEach(async () => { vi.unstubAllGlobals(); await store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup() { directory = await mkdtemp(join(tmpdir(), 'aeri-test-')); process.env.DATA_DIR = directory; store = createStore('', directory); return createApp(store, 'test-code'); }
const auth = { Authorization: 'Bearer test-code', 'Content-Type': 'application/json' };
async function json(response: Response) { return response.json() as Promise<any>; }

describe('authenticated household flow', () => {
  it('rejects private state without an access code', async () => {
    const app = await setup();
    expect((await app.request('/v1/bootstrap')).status).toBe(401);
    expect((await app.request('/v1/bootstrap', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  it('turns confirmed inventory and a recipe into an approved draft, preserving order boundaries', async () => {
    const app = await setup();
    expect((await app.request('/v1/inventory', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Tomatoes', amount: 2, unit: 'each' }) })).status).toBe(200);
    const recipe = await json(await app.request('/v1/recipes', { method: 'POST', headers: auth, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=demo' }) }));
    expect(recipe.recipe.source).toBe('demo');
    expect(recipe.cart.items.find((item: any) => item.name === 'Tomatoes').quantity.amount).toBe(2);
    expect(recipe.cart.status).toBe('draft');
    expect((await app.request(`/v1/carts/${recipe.cart.id}/checkout`, { method: 'POST', headers: auth })).status).toBe(400);
    const approved = await json(await app.request(`/v1/carts/${recipe.cart.id}/approve`, { method: 'POST', headers: auth }));
    expect(approved.status).toBe('approved');
    expect((await json(await app.request('/v1/bootstrap', { headers: auth }))).state.tasks.find((task: any) => task.subjectId === recipe.cart.id).status).toBe('done');
    expect((await app.request(`/v1/carts/${recipe.cart.id}/approve`, { method: 'POST', headers: auth })).status).toBe(400);
    const bootstrap = await json(await app.request('/v1/bootstrap', { headers: auth }));
    expect(bootstrap.state.carts[0].status).toBe('approved');
    expect(bootstrap.state.events.some((event: any) => event.type === 'cart.approved')).toBe(true);
  });

  it('keeps scan guesses pending until explicit confirmation', async () => {
    const app = await setup();
    const form = new FormData(); form.append('video', new File([new Uint8Array([0, 1])], 'kitchen.mp4', { type: 'video/mp4' }));
    const scan = await json(await app.request('/v1/scans', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form }));
    expect(scan.status).toBe('needs_review');
    expect(scan.source).toBe('demo');
    expect((await json(await app.request('/v1/bootstrap', { headers: auth }))).state.inventory).toEqual([]);
    const decisions = Object.fromEntries(scan.observations.map((item: any, index: number) => [item.id, index === 0 ? 'accepted' : 'rejected']));
    const confirmed = await json(await app.request(`/v1/scans/${scan.id}/confirm`, { method: 'POST', headers: auth, body: JSON.stringify({ decisions }) }));
    expect(confirmed.inventory.map((item: any) => item.name)).toEqual(['Milk']);
    expect((await app.request(`/v1/scans/${scan.id}/confirm`, { method: 'POST', headers: auth, body: JSON.stringify({ decisions }) })).status).toBe(400);
  });

  it('verifies signed AgentMail receipts and deduplicates delivery', async () => {
    const secret = `whsec_${Buffer.from('receipt-secret-32-bytes-long-enough').toString('base64')}`;
    const old = process.env.AGENTMAIL_WEBHOOK_SECRET;
    process.env.AGENTMAIL_WEBHOOK_SECRET = secret;
    try {
      const app = await setup();
      const payload = JSON.stringify({ event_id: 'email-1', event_type: 'message.received', message: { subject: 'Your grocery order' } });
      const timestamp = new Date();
      const headers = { 'svix-id': 'msg_1', 'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)), 'svix-signature': new Webhook(secret).sign('msg_1', timestamp, payload) };
      expect((await app.request('/webhooks/agentmail', { method: 'POST', headers, body: payload })).status).toBe(200);
      expect((await app.request('/webhooks/agentmail', { method: 'POST', headers, body: payload })).status).toBe(200);
      const state = (await json(await app.request('/v1/bootstrap', { headers: auth }))).state;
      expect(state.events.filter((event: any) => event.type === 'email.received')).toHaveLength(1);
      expect(state.tasks.filter((task: any) => task.kind === 'receipt')).toHaveLength(1);
      expect((await app.request('/webhooks/agentmail', { method: 'POST', headers: { ...headers, 'svix-signature': 'bad' }, body: payload })).status).toBe(401);
    } finally { if (old === undefined) delete process.env.AGENTMAIL_WEBHOOK_SECRET; else process.env.AGENTMAIL_WEBHOOK_SECRET = old; }
  });

  it('walks an approved cart through store handoff, order reference and delivery without skipping a step', async () => {
    const app = await setup();
    const post = (path: string, body?: unknown) => app.request(path, { method: 'POST', headers: auth, body: body ? JSON.stringify(body) : undefined });
    await post('/v1/inventory', { name: 'Garlic', amount: 3, unit: 'each' });
    const chat = await json(await post('/v1/chat', { text: 'Make this https://youtu.be/abc123' }));
    expect(chat.reply).toMatch(/sample recipe/);
    let state = (await json(await app.request('/v1/bootstrap', { headers: auth }))).state;
    const cart = state.carts[0];
    expect(state.recipes[0].title).not.toMatch(/demo/i);
    expect(cart.items.map((item: any) => item.name)).not.toContain('Garlic');
    expect((await post(`/v1/carts/${cart.id}/ordered`, { reference: 'A-1' })).status).toBe(400);
    await post(`/v1/carts/${cart.id}/approve`);
    const checkout = await json(await post(`/v1/carts/${cart.id}/checkout`));
    expect(checkout.mode).toBe('manual');
    expect(checkout.cart.checkout).toMatchObject({ mode: 'manual' });
    expect(checkout.cart.status).toBe('checkout_ready');
    expect((await post(`/v1/carts/${cart.id}/received`)).status).toBe(400);
    expect((await post(`/v1/carts/${cart.id}/ordered`, { reference: '   ' })).status).toBe(400);
    const ordered = await json(await post(`/v1/carts/${cart.id}/ordered`, { reference: '  IC-48213  ' }));
    expect(ordered.orderReference).toBe('IC-48213');
    expect((await post(`/v1/carts/${cart.id}/cancel`)).status).toBe(400);
    await post(`/v1/carts/${cart.id}/received`);
    state = (await json(await app.request('/v1/bootstrap', { headers: auth }))).state;
    expect(state.carts[0].receivedAt).toBeTruthy();
    expect(state.inventory.find((item: any) => item.name === 'Pasta').quantity).toEqual({ amount: 250, unit: 'g' });
    expect((await post(`/v1/carts/${cart.id}/received`)).status).toBe(400);
  });

  it('discards an unordered list and removes a remembered item', async () => {
    const app = await setup();
    const post = (path: string, body?: unknown) => app.request(path, { method: 'POST', headers: auth, body: body ? JSON.stringify(body) : undefined });
    const { cart } = await json(await post('/v1/recipes', { url: 'https://www.youtube.com/watch?v=demo' }));
    expect((await json(await post(`/v1/carts/${cart.id}/cancel`))).status).toBe('cancelled');
    expect((await post(`/v1/carts/${cart.id}/approve`)).status).toBe(400);
    const item = await json(await post('/v1/inventory', { name: 'Milk', amount: 1, unit: 'l' }));
    expect((await app.request(`/v1/inventory/${item.id}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await json(await app.request('/v1/bootstrap', { headers: auth }))).state.inventory).toEqual([]);
    expect((await app.request(`/v1/inventory/${item.id}`, { method: 'DELETE', headers: auth })).status).toBe(404);
    await post('/v1/preferences', { key: 'shirt size', value: 'M' });
    expect((await app.request(`/v1/preferences/${encodeURIComponent('shirt size')}`, { method: 'DELETE', headers: auth })).status).toBe(200);
    expect((await json(await app.request('/v1/bootstrap', { headers: auth }))).state.preferences).toEqual({});
  });

  it('keeps separate free-form notes instead of overwriting them', async () => {
    const app = await setup();
    const say = (text: string) => app.request('/v1/chat', { method: 'POST', headers: auth, body: JSON.stringify({ text }) });
    await say('Remember that we avoid peanuts');
    await say('Remember that our favorite store is Trader Joe’s');
    const preferences = (await json(await app.request('/v1/bootstrap', { headers: auth }))).state.preferences;
    expect(Object.values(preferences)).toEqual(['we avoid peanuts', 'our favorite store is Trader Joe’s']);
  });

  it('reports a gateway failure by provider without leaking the key', async () => {
    const priorKey = process.env.NEON_AI_GATEWAY_API_KEY, priorBase = process.env.NEON_AI_GATEWAY_BASE_URL;
    process.env.NEON_AI_GATEWAY_API_KEY = 'gateway-secret-value-123';
    process.env.NEON_AI_GATEWAY_BASE_URL = 'https://gateway.example';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { message: 'Invalid API key gateway-secret-value-123' } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
    try {
      const app = await setup();
      const response = await app.request('/v1/chat', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'What should I cook tonight?' }) });
      const body = await json(response);
      expect(response.status).toBe(502);
      expect(body.provider).toBe('Neon AI Gateway');
      expect(body.error).toMatch(/^Neon AI Gateway: /);
      expect(body.error).not.toContain('gateway-secret-value-123');
    } finally {
      if (priorKey === undefined) delete process.env.NEON_AI_GATEWAY_API_KEY; else process.env.NEON_AI_GATEWAY_API_KEY = priorKey;
      if (priorBase === undefined) delete process.env.NEON_AI_GATEWAY_BASE_URL; else process.env.NEON_AI_GATEWAY_BASE_URL = priorBase;
    }
  });

  it('runs the Mastra agent through a custom OpenAI-compatible gateway', async () => {
    const priorKey = process.env.NEON_AI_GATEWAY_API_KEY, priorBase = process.env.NEON_AI_GATEWAY_BASE_URL;
    process.env.NEON_AI_GATEWAY_API_KEY = 'mock-gateway-key';
    process.env.NEON_AI_GATEWAY_BASE_URL = 'https://gateway.example';
    const requests: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', created: 1, model: 'gpt-5-mini', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'I can help plan that.' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const app = await setup();
      const reply = await json(await app.request('/v1/chat', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'Can you suggest a dinner?' }) }));
      expect(reply.reply).toBe('I can help plan that.');
      expect(requests[0].url).toBe('https://gateway.example/v1/chat/completions');
      expect(requests[0].body.model).toBe(process.env.NEON_AI_GATEWAY_MODEL ?? 'gpt-5-4-mini');
    } finally {
      if (priorKey === undefined) delete process.env.NEON_AI_GATEWAY_API_KEY; else process.env.NEON_AI_GATEWAY_API_KEY = priorKey;
      if (priorBase === undefined) delete process.env.NEON_AI_GATEWAY_BASE_URL; else process.env.NEON_AI_GATEWAY_BASE_URL = priorBase;
    }
  });

  it('lets the Mastra loop update household memory through a tool call', async () => {
    const priorKey = process.env.NEON_AI_GATEWAY_API_KEY, priorBase = process.env.NEON_AI_GATEWAY_BASE_URL;
    process.env.NEON_AI_GATEWAY_API_KEY = 'mock-gateway-key';
    process.env.NEON_AI_GATEWAY_BASE_URL = 'https://gateway.example';
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      const message = calls === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'tool-1', type: 'function', function: { name: 'rememberPreference', arguments: JSON.stringify({ key: 'shoe size', value: '9' }) } }] }
        : { role: 'assistant', content: 'I saved your shoe size as 9.' };
      return new Response(JSON.stringify({ id: `chatcmpl-${calls}`, object: 'chat.completion', created: 1, model: 'gpt-5-mini', choices: [{ index: 0, finish_reason: calls === 1 ? 'tool_calls' : 'stop', message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    try {
      const app = await setup();
      const reply = await json(await app.request('/v1/chat', { method: 'POST', headers: auth, body: JSON.stringify({ text: 'Please remember that I wear size 9 shoes.' }) }));
      expect(reply.reply).toBe('I saved your shoe size as 9.');
      expect(calls).toBe(2);
      expect((await json(await app.request('/v1/bootstrap', { headers: auth }))).state.preferences['shoe size']).toBe('9');
    } finally {
      if (priorKey === undefined) delete process.env.NEON_AI_GATEWAY_API_KEY; else process.env.NEON_AI_GATEWAY_API_KEY = priorKey;
      if (priorBase === undefined) delete process.env.NEON_AI_GATEWAY_BASE_URL; else process.env.NEON_AI_GATEWAY_BASE_URL = priorBase;
    }
  });
});
