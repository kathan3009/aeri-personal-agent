import { GoogleGenAI } from '@google/genai';
import Kernel from '@onkernel/sdk';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { recipeSchema, observationSchema, type Recipe, type Observation } from '@personal-agent/core';
import { z } from 'zod';
import { demoObservations, demoRecipe } from './demo.js';

const extractJson = (text: string): unknown => {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(clean);
};

export function providerStatus() {
  return {
    gemini: Boolean(process.env.GEMINI_API_KEY), neon: Boolean(process.env.DATABASE_URL),
    aiGateway: Boolean(process.env.NEON_AI_GATEWAY_API_KEY && process.env.NEON_AI_GATEWAY_BASE_URL),
    kernel: Boolean(process.env.KERNEL_API_KEY), exa: Boolean(process.env.EXA_API_KEY),
    vapi: Boolean(process.env.VAPI_WEBHOOK_SECRET && process.env.VAPI_ALLOWED_CALLER && process.env.VAPI_PHONE_NUMBER), agentMail: Boolean(process.env.AGENTMAIL_WEBHOOK_SECRET),
  };
}

function gemini(): GoogleGenAI | null { return process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null; }

export async function understandRecipe(url: string, id: string, now: string): Promise<Recipe> {
  const ai = gemini();
  if (!ai) return demoRecipe(id, now, url, 'Creamy tomato pasta · demo recipe');
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_VIDEO_MODEL ?? 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [
      { fileData: { fileUri: url, mimeType: 'video/*' } },
      { text: 'Extract the actual recipe shown in this video. Return ONLY JSON with title, servings, ingredients [{name,amount,unit,optional}], and instructions. Units allowed: each,g,kg,ml,l,oz,lb,cup,tbsp,tsp. If a quantity is unclear, use a reasonable estimate and mention the uncertainty in the ingredient name. Do not invent an unrelated recipe.' },
    ] }],
  });
  const raw = z.object({ title: z.string(), servings: z.number(), ingredients: z.array(z.object({ name: z.string(), amount: z.number(), unit: z.enum(['each','g','kg','ml','l','oz','lb','cup','tbsp','tsp']), optional: z.boolean().optional() })), instructions: z.array(z.string()) }).parse(extractJson(response.text ?? ''));
  return recipeSchema.parse({ id, createdAt: now, sourceUrl: url, source: 'gemini', title: raw.title, servings: raw.servings, ingredients: raw.ingredients.map(({ name, amount, unit, optional }) => ({ name, quantity: { amount, unit }, optional: optional ?? false })), instructions: raw.instructions });
}

export async function understandKitchenVideo(data: Uint8Array, mimeType: string, id: () => string): Promise<Observation[]> {
  const ai = gemini();
  if (!ai) return demoObservations(id);
  if (data.byteLength > 90_000_000) throw new Error('Video is too large. Please record a clip under 90 MB.');
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_VIDEO_MODEL ?? 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [
      { inlineData: { data: Buffer.from(data).toString('base64'), mimeType } },
      { text: 'Identify groceries visibly present in this kitchen video. Return ONLY JSON array [{name,amount,unit,confidence}]. Use allowed units each,g,kg,ml,l,oz,lb,cup,tbsp,tsp. Estimate quantity conservatively and confidence 0 to 1. Do not infer hidden items.' },
    ] }],
  });
  const parsed = z.array(z.object({ name: z.string(), amount: z.number().positive().optional(), unit: z.enum(['each','g','kg','ml','l','oz','lb','cup','tbsp','tsp']).optional(), confidence: z.number().min(0).max(1) })).parse(extractJson(response.text ?? ''));
  return parsed.map(item => observationSchema.parse({ id: id(), name: item.name, confidence: item.confidence, decision: 'pending', quantity: item.amount ? { amount: item.amount, unit: item.unit ?? 'each' } : undefined }));
}

export async function transcribeAudio(data: Uint8Array, mimeType: string): Promise<string> {
  const ai = gemini();
  if (!ai) throw new Error('Voice transcription needs GEMINI_API_KEY. Text chat works now.');
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_VIDEO_MODEL ?? 'gemini-2.5-flash',
    contents: [{ role: 'user', parts: [
      { inlineData: { data: Buffer.from(data).toString('base64'), mimeType } },
      { text: 'Transcribe the user speech exactly. Return only the transcription.' },
    ] }],
  });
  return (response.text ?? '').trim();
}

export async function researchProducts(query: string): Promise<Array<{ title: string; url: string }>> {
  if (!process.env.EXA_API_KEY) return [];
  const response = await fetch('https://api.exa.ai/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.EXA_API_KEY }, body: JSON.stringify({ query, type: 'auto', numResults: 5 }) });
  if (!response.ok) throw new Error(`Exa search failed: ${response.status}`);
  const json = await response.json() as { results?: Array<{ title: string; url: string }> };
  return (json.results ?? []).map(({ title, url }) => ({ title, url }));
}

export async function prepareRetailerCheckout(items: Array<{ name: string; amount: number; unit: string }>): Promise<{ url: string; sessionId?: string; note: string }> {
  const target = process.env.KERNEL_RETAILER_URL || 'https://www.instacart.com/';
  if (!process.env.KERNEL_API_KEY) return { url: target, note: 'Open the retailer and add approved items manually. Kernel key is not configured.' };
  const kernel = new Kernel({ apiKey: process.env.KERNEL_API_KEY });
  const browser = await kernel.browsers.create({ timeout_seconds: 1200 });
  const response = await kernel.browsers.playwright.execute(browser.session_id, {
    code: `await page.goto(${JSON.stringify(target)}); return { url: page.url(), title: await page.title() };`,
  });
  if (!response.success) throw new Error(`Kernel could not open the retailer: ${response.error ?? 'unknown error'}`);
  let note = `Browser is ready with ${items.length} approved items. Complete retailer login and checkout in the live view.`;
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
      const answer = await agent.generate(`Prepare the retailer cart for these approved items: ${JSON.stringify(items)}. Stop before payment and report exactly what you could add.`, { maxSteps: 16 });
      note = answer.text || note;
    } catch (error) { note = `Browser opened, but automated cart preparation stopped: ${(error as Error).message}. Finish in the live view.`; }
  }
  return { url: browser.browser_live_view_url ?? target, sessionId: browser.session_id, note };
}
