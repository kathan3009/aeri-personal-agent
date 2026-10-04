import { GoogleGenAI } from '@google/genai';
import Kernel from '@onkernel/sdk';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { createTool } from '@mastra/core/tools';
import { recipeSchema, observationSchema, type Recipe, type Observation } from '@personal-agent/core';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { demoObservations, demoRecipe } from './demo.js';

const extractJson = (text: string): unknown => {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(clean);
};

const interactionText = (outputs: Array<{ type: string; text?: string }> | undefined): string =>
  (outputs ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join(' ').trim();

export function providerStatus() {
  return {
    gemini: Boolean(process.env.GEMINI_API_KEY), neon: Boolean(process.env.DATABASE_URL),
    aiGateway: Boolean(process.env.NEON_AI_GATEWAY_API_KEY && process.env.NEON_AI_GATEWAY_BASE_URL),
    kernel: Boolean(process.env.KERNEL_API_KEY), exa: Boolean(process.env.EXA_API_KEY),
    agentMail: Boolean(process.env.AGENTMAIL_WEBHOOK_SECRET),
  };
}

const secretNames = ['APP_ACCESS_TOKEN', 'GEMINI_API_KEY', 'NEON_AI_GATEWAY_API_KEY', 'KERNEL_API_KEY', 'EXA_API_KEY', 'AGENTMAIL_WEBHOOK_SECRET', 'DATABASE_URL'];
/** Removes configured secret values and bearer-style tokens so provider failures can be shown to the user. */
export function scrub(message: string): string {
  let clean = message;
  for (const name of secretNames) { const value = process.env[name]; if (value && value.length >= 6) clean = clean.split(value).join('[hidden]'); }
  return clean.replace(/(bearer\s+|api[_-]?key[=:]\s*|key=)[^\s&"']+/gi, '$1[hidden]').slice(0, 300);
}

/** A failure inside a named third-party service. The message is safe to show in the app. */
export class ProviderError extends Error {
  constructor(public provider: string, detail: string) { super(`${provider}: ${scrub(detail)}`); this.name = 'ProviderError'; }
}
export async function withProvider<T>(provider: string, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  catch (error) { if (error instanceof ProviderError) throw error; throw new ProviderError(provider, (error as Error).message || 'request failed'); }
}

function gemini(): GoogleGenAI | null { return process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null; }

export async function understandRecipe(url: string, id: string, now: string): Promise<Recipe> {
  const ai = gemini();
  if (!ai) return demoRecipe(id, now, url);
  const response = await withProvider('Gemini', () => ai.interactions.create({
    model: process.env.GEMINI_VIDEO_MODEL ?? 'gemini-3.8-flash',
    input: [
      { type: 'video', uri: url },
      { type: 'text', text: 'Extract the actual recipe shown in this video. Return ONLY JSON with title, servings, ingredients [{name,amount,unit,optional}], and instructions. Units allowed: each,g,kg,ml,l,oz,lb,cup,tbsp,tsp. If a quantity is unclear, use a reasonable estimate and mention the uncertainty in the ingredient name. Do not invent an unrelated recipe.' },
    ], response_mime_type: 'application/json',
  }));
  const raw = await withProvider('Gemini', async () => z.object({ title: z.string(), servings: z.number(), ingredients: z.array(z.object({ name: z.string(), amount: z.number(), unit: z.enum(['each','g','kg','ml','l','oz','lb','cup','tbsp','tsp']), optional: z.boolean().optional() })), instructions: z.array(z.string()) }).parse(extractJson(interactionText(response.outputs))));
  return recipeSchema.parse({ id, createdAt: now, sourceUrl: url, source: 'gemini', title: raw.title, servings: raw.servings, ingredients: raw.ingredients.map(({ name, amount, unit, optional }) => ({ name, quantity: { amount, unit }, optional: optional ?? false })), instructions: raw.instructions });
}

export async function understandKitchenVideo(data: Uint8Array, mimeType: string, id: () => string): Promise<Observation[]> {
  const ai = gemini();
  if (!ai) return demoObservations(id);
  if (data.byteLength > 90_000_000) throw new Error('Video is too large. Please record a clip under 90 MB.');
  const videoMime = mimeType === 'video/quicktime' ? 'video/mov' : mimeType;
  if (!['video/mp4', 'video/mpeg', 'video/mpg', 'video/mov', 'video/avi', 'video/x-flv', 'video/webm', 'video/wmv', 'video/3gpp'].includes(videoMime)) throw new Error('Unsupported video format. Use MP4 or MOV.');
  let fileName: string | undefined;
  return withProvider('Gemini', async () => { try {
    let video: { type: 'video'; data?: string; uri?: string; mime_type: 'video/mp4' };
    if (data.byteLength < 18_000_000) video = { type: 'video', data: Buffer.from(data).toString('base64'), mime_type: videoMime as 'video/mp4' };
    else {
      let file = await ai.files.upload({ file: new Blob([new Uint8Array(data)], { type: videoMime }), config: { mimeType: videoMime } });
      fileName = file.name;
      for (let attempt = 0; file.state === 'PROCESSING' && attempt < 30; attempt++) {
        await delay(2000);
        file = await ai.files.get({ name: fileName! });
      }
      if (file.state !== 'ACTIVE' || !file.uri) throw new Error('Gemini could not process the kitchen video');
      video = { type: 'video', uri: file.uri, mime_type: videoMime as 'video/mp4' };
    }
    const response = await ai.interactions.create({
      model: process.env.GEMINI_VIDEO_MODEL ?? 'gemini-3.8-flash',
      input: [video, { type: 'text', text: 'Identify groceries visibly present in this kitchen video. Return ONLY JSON array [{name,amount,unit,confidence}]. Use allowed units each,g,kg,ml,l,oz,lb,cup,tbsp,tsp. Estimate quantity conservatively and confidence 0 to 1. Do not infer hidden items.' }],
      response_mime_type: 'application/json',
    });
    const parsed = z.array(z.object({ name: z.string(), amount: z.number().positive().optional(), unit: z.enum(['each','g','kg','ml','l','oz','lb','cup','tbsp','tsp']).optional(), confidence: z.number().min(0).max(1) })).parse(extractJson(interactionText(response.outputs)));
    return parsed.map(item => observationSchema.parse({ id: id(), name: item.name, confidence: item.confidence, decision: 'pending', quantity: item.amount ? { amount: item.amount, unit: item.unit ?? 'each' } : undefined }));
  } finally {
    if (fileName) await ai.files.delete({ name: fileName }).catch(() => undefined);
  } });
}

export async function transcribeAudio(data: Uint8Array, mimeType: string): Promise<string> {
  const ai = gemini();
  if (!ai) throw new Error('Voice transcription needs GEMINI_API_KEY. Text chat works now.');
  const audioMime = mimeType === 'audio/mp4' || mimeType === 'audio/x-m4a' ? 'audio/m4a' : mimeType;
  if (!['audio/m4a', 'audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/aac', 'audio/ogg', 'audio/flac'].includes(audioMime)) throw new Error('Unsupported voice format. Use M4A, MP3, or WAV.');
  return withProvider('Gemini', async () => {
  const uploaded = await ai.files.upload({ file: new Blob([new Uint8Array(data)], { type: audioMime }), config: { mimeType: audioMime } });
  if (!uploaded.name) throw new Error('Gemini did not return an audio file reference');
  try {
    let file = uploaded;
    for (let attempt = 0; file.state === 'PROCESSING' && attempt < 30; attempt++) {
      await delay(2000);
      file = await ai.files.get({ name: uploaded.name });
    }
    if (file.state !== 'ACTIVE' || !file.uri) throw new Error('Gemini could not process the voice note');
    const response = await ai.interactions.create({
      model: process.env.GEMINI_AUDIO_MODEL ?? 'gemini-3.5-transcribe',
      input: [{ type: 'audio', uri: file.uri, mime_type: audioMime as 'audio/m4a' }],
    });
    const transcript = interactionText(response.outputs);
    if (!transcript) throw new Error('No speech was detected in the voice note');
    return transcript;
  } finally { await ai.files.delete({ name: uploaded.name }).catch(() => undefined); }
  });
}

export async function researchProducts(query: string): Promise<Array<{ title: string; url: string }>> {
  if (!process.env.EXA_API_KEY) return [];
  const response = await withProvider('Exa', () => fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY! }, body: JSON.stringify({ query, type: 'auto', category: 'product', numResults: 5 }) }));
  if (!response.ok) throw new ProviderError('Exa', `search returned ${response.status}`);
  const json = await withProvider('Exa', () => response.json()) as { results?: Array<{ title?: string; url?: string }> };
  const seen = new Set<string>();
  return (json.results ?? []).flatMap(({ title, url }) => {
    if (!title?.trim() || !url) return [];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || seen.has(parsed.href)) return [];
      seen.add(parsed.href);
      return [{ title: title.trim(), url: parsed.href }];
    } catch { return []; }
  });
}

export async function prepareRetailerCheckout(items: Array<{ name: string; amount: number; unit: string }>): Promise<{ url: string; sessionId?: string; note: string; mode: 'manual' | 'kernel' }> {
  const target = process.env.KERNEL_RETAILER_URL || 'https://www.instacart.com/';
  if (!process.env.KERNEL_API_KEY) return { url: target, mode: 'manual', note: `Aeri opened ${new URL(target).hostname.replace(/^www\./, '')}. Add the ${items.length} approved items there and check out yourself.` };
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  const browser = await withProvider('Kernel', () => kernel.browsers.create({ timeout_seconds: 1200 }));
  const response = await withProvider('Kernel', () => kernel.browsers.playwright.execute(browser.session_id, {
    code: `await page.goto(${JSON.stringify(target)}); return { url: page.url(), title: await page.title() };`,
  }));
  if (!response.success) throw new ProviderError('Kernel', `could not open the store (${response.error ?? 'unknown error'})`);
  let note = `A private browser is open at the store with your ${items.length} approved items listed. Sign in, check the cart, and pay there yourself.`;
  const key = process.env.NEON_AI_GATEWAY_API_KEY, base = process.env.NEON_AI_GATEWAY_BASE_URL;
  if (key && base && items.length) {
    const origin = new URL(target).hostname;
    const snapshot = `return { url: page.url(), title: await page.title(), text: (await page.locator('body').innerText()).slice(0, 4500), inputs: await page.locator('input').evaluateAll(xs => xs.map(x => ({ placeholder: x.getAttribute('placeholder'), aria: x.getAttribute('aria-label') })).slice(0, 12)), buttons: await page.getByRole('button').allTextContents().then(xs => xs.slice(0, 25)) };`;
    const browserAction = createTool({
      id: 'retailerBrowser', description: 'Inspect the retailer page or fill a search box or click a visible product/add button. Never place an order or pay.',
      inputSchema: z.object({ action: z.enum(['inspect', 'fill', 'click']), label: z.string().optional(), value: z.string().optional() }),
      execute: async ({ action, label, value }) => {
        if (action !== 'inspect' && !label) throw new Error('A visible label is required');
        if (action === 'click' && /checkout|place order|pay|purchase|subscribe|sign in|login/i.test(label!)) throw new Error('That action is reserved for the user in live view');
        const operation = action === 'fill' ? `const field = page.getByPlaceholder(${JSON.stringify(label ?? '')}, { exact: false }).first(); if (await field.count()) await field.fill(${JSON.stringify(value ?? '')}); else await page.getByRole('textbox', { name: ${JSON.stringify(label ?? '')}, exact: false }).first().fill(${JSON.stringify(value ?? '')});`
          : action === 'click' ? `const button = page.getByRole('button', { name: ${JSON.stringify(label ?? '')}, exact: false }).first(); if (await button.count()) await button.click(); else await page.getByRole('link', { name: ${JSON.stringify(label ?? '')}, exact: false }).first().click();` : '';
        const script = `${operation} ${snapshot}`;
        const result = await kernel.browsers.playwright.execute(browser.session_id, { code: script, timeout_sec: 35 });
        if (!result.success) return { error: String(result.error ?? 'Browser action failed') };
        const page = result.result as { url?: string };
        if (page.url && new URL(page.url).hostname !== origin && !new URL(page.url).hostname.endsWith(`.${origin}`)) throw new Error('Retailer browser navigated outside the configured site');
        return page;
      },
    });
    try {
      const agent = new Agent({
        id: 'retailer-cart-agent', name: 'Retailer cart assistant',
        instructions: 'Use retailerBrowser to add only the exact approved grocery items to the retailer cart. First inspect the page. If login or delivery location is required, stop and tell the user. Never click checkout, pay, place order, or select unapproved substitutes. Do not claim an item is added unless the page confirms it. Be concise and honest about what remains.',
        model: { id: `neon/${process.env.NEON_AI_GATEWAY_MODEL ?? 'gpt-5-mini'}`, url: `${base.replace(/\/$/, '')}/v1`, apiKey: key, api: 'chat' },
        tools: { retailerBrowser: browserAction },
      });
      const mastra = new Mastra({ agents: { retailer: agent }, logger: false, workers: false });
      const answer = await mastra.getAgent('retailer').generate(`Prepare the retailer cart for these approved items: ${JSON.stringify(items)}. Stop before payment and report exactly what you could add.`, { maxSteps: 16 });
      note = answer.text || note;
    } catch (error) { note = `The browser is open, but Aeri stopped adding items: ${scrub((error as Error).message)}. Finish in the live view.`; }
  }
  return { url: browser.browser_live_view_url ?? target, sessionId: browser.session_id, note, mode: 'kernel' };
}
