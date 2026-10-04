import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { createStore, type Store } from './store.js';

let directory = ''; let store: Store;
const saved = { ...process.env };
beforeEach(() => { for (const key of ['GEMINI_API_KEY', 'NEON_AI_GATEWAY_API_KEY', 'NEON_AI_GATEWAY_TOKEN', 'NEON_AI_GATEWAY_BASE_URL', 'KERNEL_API_KEY', 'EXA_API_KEY']) delete process.env[key]; });
afterEach(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); process.env = { ...saved }; await store?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function setup() {
  directory = await mkdtemp(join(tmpdir(), 'aeri-flow-'));
  process.env.DATA_DIR = directory; // frames and temp clips stay inside the test directory
  store = createStore('', directory);
  return createApp(store, 'test-code');
}
const auth = { Authorization: 'Bearer test-code', 'Content-Type': 'application/json' };
const json = async (response: Response) => { const body = await response.json() as any; if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`); return body; };
const state = async (app: Awaited<ReturnType<typeof setup>>) => (await json(await app.request('/v1/bootstrap', { headers: auth }))).state;
const post = (app: Awaited<ReturnType<typeof setup>>, path: string, body?: unknown) => app.request(path, { method: 'POST', headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
const ffmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

// A reply in the exact shape Gemini returns for generateContent, recorded as a fixture until a key is available.
const geminiReply = (payload: unknown) => new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP', index: 0 }], usageMetadata: { promptTokenCount: 9000, candidatesTokenCount: 400, totalTokenCount: 9400 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('recorded video to confirmed memory', () => {
  it('maps a sample walkthrough, takes corrections, and only confirmed facts change the next shopping list', async () => {
    const app = await setup();
    const form = new FormData(); form.append('video', new File([new Uint8Array([0, 0, 0, 24])], 'walk.mov', { type: 'video/quicktime' })); form.append('source', 'recorded');
    const scan = await json(await app.request('/v1/scans', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form }));
    expect(scan.source).toBe('demo');
    expect(scan.video).toMatchObject({ kind: 'recorded', mimeType: 'video/quicktime' });
    expect(scan.places.map((p: any) => p.name)).toEqual(['Fridge', 'Pantry shelf']);
    expect(scan.unclear[0].ask).toMatch(/Move the cereal box/);
    const byName = Object.fromEntries(scan.observations.map((o: any) => [o.name, o]));
    expect(byName.Tomatoes.countCertain).toBe(false);
    expect(byName['Olive oil']).toMatchObject({ evidence: 'inferred' });
    expect(byName['Olive oil'].confidence).toBeLessThanOrEqual(0.5);
    // Accepting an uncertain count without giving one is refused.
    const all = Object.fromEntries(scan.observations.map((o: any) => [o.id, 'rejected']));
    const refused = await post(app, `/v1/scans/${scan.id}/confirm`, { decisions: { ...all, [byName.Tomatoes.id]: 'accepted' } });
    expect(refused.status).toBe(400);
    expect((await refused.json() as any).error).toMatch(/how many tomatoes/);
    const confirmed = await json(await post(app, `/v1/scans/${scan.id}/confirm`, { decisions: { ...all, [byName.Tomatoes.id]: { decision: 'accepted', amount: 4 }, [byName.Milk.id]: 'accepted', [byName['Olive oil'].id]: { decision: 'accepted', name: 'Olive oil', brand: 'Colavita' } } }));
    expect(confirmed.inventory.map((i: any) => [i.name, i.quantity.amount, i.location])).toEqual([['Milk', 1, 'Fridge'], ['Tomatoes', 4, 'Fridge'], ['Olive oil', 1, 'Pantry shelf']]);
    expect(confirmed.inventory[2].brand).toBe('Colavita');
    let s = await state(app);
    expect(s.events.filter((e: any) => e.type === 'inventory.corrected').map((e: any) => e.data.name)).toEqual(['Tomatoes', 'Olive oil']);
    expect(s.tasks.find((t: any) => t.subjectId === scan.id).status).toBe('done');
    // The next recipe subtracts what was confirmed: 4 tomatoes are owned, so they are not bought.
    const recipe = await json(await post(app, '/v1/recipes', { url: 'https://youtu.be/demo123' }));
    expect(recipe.cart.items.map((i: any) => i.name)).not.toContain('Tomatoes');
    expect(recipe.cart.items.map((i: any) => i.name)).toContain('Olive oil'); // 1 bottle (count) can't cover 2 tbsp (volume)
    // A second walkthrough of the fridge compares with memory and asks about confirmed things it didn't see.
    const again = await json(await app.request('/v1/scans', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form }));
    expect(again.observations.find((o: any) => o.name === 'Milk').change).toMatchObject({ kind: 'same' });
    expect(again.observations.find((o: any) => o.name === 'Tomatoes').change).toMatchObject({ kind: 'fewer', previous: { amount: 4 } });
    s = await state(app);
    const reply = await json(await post(app, '/v1/chat', { text: 'Where is the milk?' }));
    expect(reply.reply).toMatch(/^Your Organic Valley whole milk is in the fridge \(door\) \(seen at 0:03/);
  });

  it.skipIf(!ffmpeg)('runs a Gemini-shaped reply through frame extraction for a real clip', async () => {
    const app = await setup();
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const clip = join(directory, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10', '-pix_fmt', 'yuv420p', clip]);
    const requests: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) });
      return geminiReply({ summary: 'A shelf', durationSec: 6, places: [{ id: 'p1', name: 'Closet shelf', kind: 'closet', start: '0:00', end: '0:06' }],
        items: [{ name: 'Jacket', variant: 'blue', place: 'p1', position: 'top shelf', category: 'clothing', count: 1, unit: 'each', countCertain: true, evidence: 'visual', timestamps: ['0:02'], confidence: 0.88 },
          { name: 'Shoes', place: 'p1', count: 2, countCertain: false, evidence: 'visual', timestamps: ['0:04', '0:09'], confidence: 0.6 }],
        unclear: [{ description: 'box on the floor', place: 'p1', timestamp: '0:05', ask: 'Open the box' }] });
    });
    const form = new FormData(); form.append('video', new File([await readFile(clip)], 'clip.mp4', { type: 'video/mp4' })); form.append('source', 'library');
    const scan = await json(await app.request('/v1/scans?wait=1', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form }));
    expect(requests[0].url).toMatch(/models\/gemini-3\.8-flash:generateContent/);
    const parts = requests[0].body.contents[0].parts;
    expect(parts[0]).toMatchObject({ inlineData: { mimeType: 'video/mp4' }, videoMetadata: { fps: 2 } });
    expect(scan).toMatchObject({ source: 'gemini', status: 'needs_review' });
    expect(scan.video.durationSec).toBeCloseTo(6, 0);
    expect(scan.observations[1].sightings.map((s: any) => s.startSec)).toEqual([4, 6]); // clamped to the clip
    const frame = scan.observations[0].sightings[0].frame;
    expect(frame).toMatch(/\.jpg$/);
    expect((await app.request(`/v1/scans/${scan.id}/frames/${frame}`)).status).toBe(401);
    const image = await app.request(`/v1/scans/${scan.id}/frames/${frame}`, { headers: auth });
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(500);
    expect((await app.request(`/v1/scans/${scan.id}/frames/..%2F..%2Fstate.json`, { headers: auth })).status).toBe(404);
    // Confirming keeps only accepted frames as evidence.
    const [jacket, shoes] = scan.observations;
    await json(await post(app, `/v1/scans/${scan.id}/confirm`, { decisions: { [jacket.id]: 'accepted', [shoes.id]: 'rejected' } }));
    expect((await app.request(`/v1/scans/${scan.id}/frames/${shoes.sightings[0].frame}`, { headers: auth })).status).toBe(404);
    expect((await app.request(`/v1/scans/${scan.id}/frames/${frame}`, { headers: auth })).status).toBe(200);
    const where = await json(await post(app, '/v1/chat', { text: 'Where did I last see the blue jacket?' }));
    expect(where.reply).toMatch(/^Your blue jacket is in the closet shelf \(top shelf\) \(seen at 0:02/);
  });

  it('reports a perception failure on the scan instead of inventing items', async () => {
    const app = await setup();
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: { code: 400, message: 'API key not valid test-gemini-key', status: 'INVALID_ARGUMENT' } }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
    const form = new FormData(); form.append('video', new File([new Uint8Array([1, 2, 3])], 'x.mp4', { type: 'video/mp4' }));
    const scan = await json(await app.request('/v1/scans', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form }));
    expect(scan.status).toBe('processing');
    await app.service.idle();
    const failed = (await state(app)).scans[0];
    expect(failed.status).toBe('failed');
    expect(failed.observations).toEqual([]);
    expect(failed.error).toMatch(/^Gemini: /);
    expect(failed.error).not.toContain('test-gemini-key');
  });

  it('imports YouTube links, refuses social pages honestly, and reads a recipe from YouTube with Gemini', async () => {
    const app = await setup();
    const social = await post(app, '/v1/videos/link', { url: 'https://www.instagram.com/reel/abc/', purpose: 'recipe' });
    expect(social.status).toBe(400);
    expect((await social.json() as any).error).toMatch(/can’t import videos from instagram.com/);
    expect((await json(await post(app, '/v1/chat', { text: 'make this https://www.tiktok.com/@chef/video/1' }))).reply).toMatch(/Save the video to your phone/);
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    const bodies: any[] = [];
    vi.stubGlobal('fetch', async (_: unknown, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return geminiReply({ isRecipe: true, title: 'Chana masala', servings: 4, ingredients: [{ name: 'Chickpeas', amount: 2, unit: 'each', timestamp: '1:10' }, { name: 'Onion', amount: 1, unit: 'each', timestamp: '0:40', estimated: true }], instructions: ['Cook'] }); });
    const started = await json(await post(app, '/v1/chat', { text: 'cook this https://www.youtube.com/watch?v=abc' }));
    expect(started.reply).toMatch(/watching the recipe now/);
    await app.service.idle();
    expect(bodies[0].contents[0].parts[0]).toEqual({ fileData: { fileUri: 'https://www.youtube.com/watch?v=abc', mimeType: 'video/mp4' } });
    const s = await state(app);
    expect(s.recipes[0]).toMatchObject({ title: 'Chana masala', source: 'gemini', sourceKind: 'youtube' });
    expect(s.recipes[0].ingredients[0].atSec).toBe(70);
    expect(s.messages.at(-1).content).toMatch(/^That's Chana masala\. 2 items are missing/);
  });
});

describe('photo to product', () => {
  it('labels sample matches and never puts an uncertain match on a list without acknowledgement', async () => {
    const app = await setup();
    await post(app, '/v1/preferences', { key: 'allergies', value: 'peanuts' });
    const form = new FormData(); form.append('image', new File([new Uint8Array([255, 216, 255])], 'p.jpg', { type: 'image/jpeg' })); form.append('instruction', 'same brand, under $10');
    const search = await json(await app.request('/v1/photos', { method: 'POST', headers: { Authorization: auth.Authorization }, body: form }));
    expect(search).toMatchObject({ status: 'ready', source: 'demo', discovery: 'fixture' });
    expect(search.constraints.applied).toEqual(expect.arrayContaining(['Same brand: Fage', 'Under $10', 'Avoids peanuts (saved)']));
    expect(search.candidates.map((c: any) => c.match)).toEqual(['exact', 'likely', 'likely', 'mismatch']);
    expect(search.candidates[1].warnings).toContain('Different size than 32 oz');
    const likely = search.candidates[1];
    expect((await post(app, `/v1/photos/${search.id}/candidates/${likely.id}/choose`, {})).status).toBe(400);
    expect((await post(app, `/v1/photos/${search.id}/candidates/${search.candidates[3].id}/choose`, { acceptUncertain: true })).status).toBe(400);
    const cart = await json(await post(app, `/v1/photos/${search.id}/candidates/${search.candidates[0].id}/choose`, {}));
    expect(cart).toMatchObject({ status: 'draft', origin: 'photo', merchant: 'Sample Valley Grocery', estimatedTotalCents: 649 });
    expect(cart.items[0].offer).toMatchObject({ verified: true, match: 'exact' });
    const second = await json(await post(app, `/v1/photos/${search.id}/candidates/${likely.id}/choose`, { acceptUncertain: true }));
    expect(second.items[0].check).toMatch(/likely match/);
  });
});

describe('retailer-neutral shopping', () => {
  const recipeCart = async (app: Awaited<ReturnType<typeof setup>>) => (await json(await post(app, '/v1/recipes', { url: 'https://youtu.be/demo123' }))).cart;

  it('compares sample stores by all-in cost, freezes the chosen offers, and reconciles delivery', async () => {
    const app = await setup();
    const cart = await recipeCart(app);
    const proposal = await json(await post(app, `/v1/carts/${cart.id}/compare`, {}));
    expect(proposal).toMatchObject({ source: 'fixture', status: 'ready' });
    expect(proposal.baskets.map((b: any) => b.label)).toEqual(['Sample Valley Grocery pickup', 'Sample Corner Market delivery', 'Sample Fresh Mart delivery']);
    const [best, delivery, unknown] = proposal.baskets;
    expect(best.complete).toBe(true);
    expect(delivery.totalCents).toBeGreaterThan(best.totalCents);
    expect(unknown).toMatchObject({ complete: false, missing: 1 });
    expect(proposal.explanation).toMatch(/Sample Valley Grocery pickup is the lowest all-in cost/);
    const chosen = await json(await post(app, `/v1/carts/${cart.id}/choose`, { basketId: best.id }));
    expect(chosen).toMatchObject({ merchant: 'Sample Valley Grocery', estimatedTotalCents: best.totalCents });
    expect(chosen.items.every((i: any) => i.offer?.priceCents > 0)).toBe(true);
    // A store that lacks an item can't be approved until the gap is handled.
    await json(await post(app, `/v1/carts/${cart.id}/choose`, { basketId: unknown.id }));
    expect((await post(app, `/v1/carts/${cart.id}/approve`)).status).toBe(400);
    await json(await post(app, `/v1/carts/${cart.id}/choose`, { basketId: best.id }));
    await json(await post(app, `/v1/carts/${cart.id}/approve`));
    const opened = await json(await post(app, `/v1/carts/${cart.id}/checkout`));
    expect(opened.mode).toBe('manual');
    expect(opened.note).toMatch(/sample prices/);
    expect((await json(await app.request(`/v1/carts/${cart.id}/review`, { headers: auth }))).live).toBe(false);
    await json(await post(app, `/v1/carts/${cart.id}/ordered`, { reference: 'TEST-1' }));
    const items = (await state(app)).carts[0].items;
    const missing = items.find((i: any) => i.name === 'Cream');
    const inventory = await json(await post(app, `/v1/carts/${cart.id}/received`, { outcome: { [missing.id]: 'missing' } }));
    expect(inventory.map((i: any) => i.name)).not.toContain('Cream');
    expect(inventory.map((i: any) => i.name)).toContain('Pasta');
    expect(inventory.find((i: any) => i.name === 'Pasta').quantity).toEqual({ amount: 16, unit: 'oz' });
    expect((await state(app)).events.find((e: any) => e.type === 'order.received').data.missing).toEqual(['Cream']);
  });

  it('refuses to approve against prices older than 30 minutes', async () => {
    const app = await setup();
    const cart = await recipeCart(app);
    const proposal = await json(await post(app, `/v1/carts/${cart.id}/compare`, {}));
    await json(await post(app, `/v1/carts/${cart.id}/choose`, { basketId: proposal.baskets[0].id }));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 31 * 60_000);
    const late = await post(app, `/v1/carts/${cart.id}/approve`);
    expect(late.status).toBe(400);
    expect((await late.json() as any).error).toMatch(/more than 30 minutes old/);
  });

  it('applies saved store, budget and avoid preferences to the request', async () => {
    const app = await setup();
    await post(app, '/v1/preferences', { key: 'weekly budget', value: '$5' });
    await post(app, '/v1/preferences', { key: 'favorite stores', value: 'Target and Whole Foods' });
    const cart = await recipeCart(app);
    const proposal = await json(await post(app, `/v1/carts/${cart.id}/compare`, { fulfillment: 'delivery' }));
    expect(proposal.request).toMatchObject({ budgetCents: 500, preferredMerchants: ['Target', 'Whole Foods'], fulfillment: 'delivery' });
    expect(proposal.rejected).toEqual([{ merchant: 'Sample Valley Grocery', reason: 'pickup only' }]);
    expect(proposal.baskets.every((b: any) => b.overBudget)).toBe(true);
    expect(proposal.explanation).toMatch(/over your \$5.00 budget/);
  });
});
