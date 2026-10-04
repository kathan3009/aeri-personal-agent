import { GoogleGenAI, type Part } from '@google/genai';
import { productSpecSchema, rawVideoMapSchema, type ProductSpec, type RawVideoMap } from '@personal-agent/core';
import { z } from 'zod';
import { reserveGatewayRequests } from './gateway-budget.js';
import { ProviderError, withProvider } from './providers.js';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Video and image understanding. Direct Gemini (GEMINI_API_KEY) is the primary path. The Neon AI Gateway's native
 * Gemini route is used only after `npm run probe:gateway-video` has passed and NEON_AI_GATEWAY_VIDEO_VERIFIED=1 is set,
 * because Gateway video support is documented only indirectly. Without either, callers fall back to labeled samples.
 */
export type Perception = { kind: 'gemini' | 'gateway'; model: string; ai: GoogleGenAI };
export type MediaInput = { kind: 'file'; data: Uint8Array; mimeType: string } | { kind: 'youtube'; url: string };

const gatewayKey = () => process.env.NEON_AI_GATEWAY_API_KEY || process.env.NEON_AI_GATEWAY_TOKEN;
export function perception(): Perception | null {
  if (process.env.GEMINI_API_KEY) return { kind: 'gemini', model: process.env.GEMINI_VIDEO_MODEL || 'gemini-3.8-flash', ai: new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) };
  const key = gatewayKey(), base = process.env.NEON_AI_GATEWAY_BASE_URL, model = process.env.NEON_AI_GATEWAY_VISION_MODEL;
  if (key && base && model && process.env.NEON_AI_GATEWAY_VIDEO_VERIFIED === '1') {
    // The Gateway ignores x-goog-api-key and authenticates the bearer token; the SDK still requires a placeholder key.
    return { kind: 'gateway', model, ai: new GoogleGenAI({ apiKey: 'neon-gateway', httpOptions: { baseUrl: `${base.replace(/\/$/, '')}/gemini`, headers: { Authorization: `Bearer ${key}` } } }) };
  }
  return null;
}
export const perceptionLabel = (p: Perception | null) => p ? (p.kind === 'gemini' ? 'Gemini' : 'Neon AI Gateway (Gemini)') : null;

export const videoMimeTypes = ['video/mp4', 'video/mpeg', 'video/mov', 'video/quicktime', 'video/avi', 'video/x-flv', 'video/webm', 'video/wmv', 'video/3gpp', 'video/x-m4v'];
const imageMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const geminiVideoMime = (mime: string) => mime === 'video/quicktime' ? 'video/mov' : mime === 'video/x-m4v' ? 'video/mp4' : mime;
const INLINE_LIMIT = 18_000_000;
const gatewayInlineLimit = () => Number(process.env.NEON_AI_GATEWAY_INLINE_MAX_BYTES || 3_000_000);

async function mediaPart(p: Perception, input: MediaInput, cleanup: Array<() => Promise<unknown>>): Promise<Part> {
  if (input.kind === 'youtube') return { fileData: { fileUri: input.url, mimeType: 'video/mp4' } };
  const mimeType = input.mimeType.startsWith('video/') ? geminiVideoMime(input.mimeType) : input.mimeType;
  // Short phone clips are sampled at 2 fps so brief label moments are less likely to be skipped (Gemini's default is 1).
  const videoMetadata = input.mimeType.startsWith('video/') ? { fps: 2 } : undefined;
  if (p.kind === 'gateway') {
    if (input.data.byteLength > gatewayInlineLimit()) throw new ProviderError('Neon AI Gateway', `this clip is ${(input.data.byteLength / 1e6).toFixed(1)} MB; the Gateway route accepts about ${(gatewayInlineLimit() / 1e6).toFixed(0)} MB. Record a shorter clip`);
    return { inlineData: { data: Buffer.from(input.data).toString('base64'), mimeType }, videoMetadata };
  }
  if (input.data.byteLength < INLINE_LIMIT) return { inlineData: { data: Buffer.from(input.data).toString('base64'), mimeType }, videoMetadata };
  let file = await p.ai.files.upload({ file: new Blob([new Uint8Array(input.data)], { type: mimeType }), config: { mimeType } });
  const name = file.name!;
  cleanup.push(() => p.ai.files.delete({ name }).catch(() => undefined));
  for (let attempt = 0; file.state === 'PROCESSING' && attempt < 45; attempt++) { await delay(2000); file = await p.ai.files.get({ name }); }
  if (file.state !== 'ACTIVE' || !file.uri) throw new Error('the video could not be processed');
  return { fileData: { fileUri: file.uri, mimeType }, videoMetadata };
}

const extractJson = (text: string): unknown => {
  const clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(clean); }
  catch { const start = clean.search(/[[{]/); const end = Math.max(clean.lastIndexOf('}'), clean.lastIndexOf(']')); if (start >= 0 && end > start) return JSON.parse(clean.slice(start, end + 1)); throw new Error('the model did not return readable JSON'); }
};

async function ask<T>(p: Perception, input: MediaInput, prompt: string, schema: z.ZodType<T>): Promise<T> {
  const provider = p.kind === 'gemini' ? 'Gemini' : 'Neon AI Gateway';
  const cleanup: Array<() => Promise<unknown>> = [];
  try {
    return await withProvider(provider, async () => {
      const part = await mediaPart(p, input, cleanup);
      if (p.kind === 'gateway') await reserveGatewayRequests();
      const response = await p.ai.models.generateContent({ model: p.model, contents: [{ role: 'user', parts: [part, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 8192 } });
      const text = response.text ?? '';
      if (!text.trim()) throw new Error('the model returned no answer');
      const parsed = schema.safeParse(extractJson(text));
      if (!parsed.success) throw new Error(`the model's answer did not match the expected shape (${parsed.error.issues[0]?.path.join('.') ?? 'root'})`);
      return parsed.data;
    });
  } finally { await Promise.all(cleanup.map(run => run())); }
}

export const householdPrompt = `You are mapping what is VISIBLE in a short phone video of a home storage area: fridge, freezer, pantry, shelf, cabinet, counter, closet or drawer. The person may narrate while filming.
Return ONLY JSON with this shape:
{"summary": "one sentence", "durationSec": number,
 "places": [{"id": "p1", "name": "Fridge", "kind": "fridge|freezer|pantry|shelf|cabinet|counter|closet|drawer|other", "start": "M:SS", "end": "M:SS"}],
 "items": [{"name": "generic product name", "brand": "string or null", "variant": "flavor/type/color or null", "size": "pack size text or null", "place": "place id", "position": "e.g. door, top shelf, or null", "category": "grocery|household|clothing|personal_care|other", "perishable": true|false, "count": number|null, "amount": number|null, "unit": "each|g|kg|ml|l|oz|lb", "countCertain": true|false, "evidence": "label|visual|spoken|inferred", "evidenceNote": "short phrase: what text you read, what you saw, or what was said", "timestamps": ["M:SS"], "confidence": 0.0-1.0, "closeUp": "what to film closer, or null"}],
 "unclear": [{"description": "what you could not identify", "place": "place id", "timestamp": "M:SS", "ask": "what the person should show or say"}]}
Rules:
- List only objects actually visible in the frames, or explicitly named by the person's voice. Never add typical items that are not shown. Never guess the contents of closed or opaque containers; put them in "unclear".
- Use evidence "label" only when you can read text on the packaging. Give a brand only if it is legible or spoken; never infer a brand from color or shape.
- One entry per distinct product per place. count = separate units visible (cartons, cans, bottles, shirts), not servings. If units overlap, are partly hidden, or you are not sure, set countCertain false and say in closeUp what to show.
- If a label is too small or blurry to read, keep the item with a generic name, lower confidence, and a closeUp request.
- For clothing, give type and color; give a size only if a size tag is legible.
- Every item needs at least one timestamp inside the video where it is clearly visible (or spoken).`;

export async function perceiveHousehold(p: Perception, input: MediaInput): Promise<RawVideoMap> {
  return ask(p, input, householdPrompt, rawVideoMapSchema);
}

const unitEnum = z.enum(['each', 'g', 'kg', 'ml', 'l', 'oz', 'lb', 'cup', 'tbsp', 'tsp']);
export const rawRecipeSchema = z.object({
  title: z.string().min(1), servings: z.number().positive().max(48).catch(2), isRecipe: z.boolean().optional(),
  ingredients: z.array(z.object({ name: z.string().min(1), amount: z.number().positive().catch(1), unit: z.string().transform(u => unitEnum.safeParse(u.toLowerCase()).success ? u.toLowerCase() as z.infer<typeof unitEnum> : 'each' as const), optional: z.boolean().nullish(), timestamp: z.union([z.string(), z.number()]).nullish(), estimated: z.boolean().nullish() })),
  instructions: z.array(z.string()).default([]),
});
export type RawRecipe = z.infer<typeof rawRecipeSchema>;
const recipePrompt = `Extract the actual recipe cooked in this video, using what is shown on screen and said aloud.
Return ONLY JSON: {"isRecipe": true|false, "title": string, "servings": number, "ingredients": [{"name": string, "amount": number, "unit": "each|g|kg|ml|l|oz|lb|cup|tbsp|tsp", "optional": boolean, "timestamp": "M:SS where it is shown or said", "estimated": true if the amount was not stated or shown}], "instructions": [string]}.
Do not invent an unrelated recipe. If the video is not a recipe, return {"isRecipe": false, "title": "Not a recipe", "servings": 1, "ingredients": [], "instructions": []}.`;
export async function perceiveRecipe(p: Perception, input: MediaInput): Promise<RawRecipe> {
  return ask(p, input, recipePrompt, rawRecipeSchema);
}

const photoPrompt = (instruction: string) => `The person photographed a product and said: "${instruction.replace(/"/g, "'").slice(0, 300)}".
Describe only what the photo shows. Return ONLY JSON: {"category": "grocery|household|clothing|personal_care|electronics|other", "name": "generic product name", "brand": string|null, "productLine": string|null, "variant": "flavor/style/color or null", "size": "pack size or garment size exactly as printed, or null", "color": string|null, "material": string|null, "visibleText": [every legible word group on the product], "barcode": "digits if fully legible, else null", "uncertain": ["brand"|"variant"|"size"|"name"|"color" for anything you cannot read with certainty], "closeUp": "what to photograph closer, or null", "confidence": 0.0-1.0}.
Never guess a brand or size from shape or color; mark it uncertain instead.`;
const rawSpecSchema = z.object({
  category: z.string().nullish(), name: z.string().min(1), brand: z.string().nullish(), productLine: z.string().nullish(), variant: z.string().nullish(),
  size: z.string().nullish(), color: z.string().nullish(), material: z.string().nullish(), visibleText: z.array(z.string()).nullish(), barcode: z.string().nullish(),
  uncertain: z.array(z.string()).nullish(), closeUp: z.string().nullish(), confidence: z.number().nullish(),
});
export async function perceiveProduct(p: Perception, data: Uint8Array, mimeType: string, instruction: string): Promise<ProductSpec> {
  if (!imageMimeTypes.includes(mimeType)) throw new Error('Use a JPEG, PNG, WebP or HEIC photo');
  const raw = await ask(p, { kind: 'file', data, mimeType }, photoPrompt(instruction), rawSpecSchema);
  const v = (s?: string | null) => s && !/^(null|unknown|none)$/i.test(s.trim()) ? s.trim() : undefined;
  const allowed = ['name', 'brand', 'variant', 'size', 'color'] as const;
  return productSpecSchema.parse({
    category: ['grocery', 'household', 'clothing', 'personal_care', 'electronics'].includes(raw.category ?? '') ? raw.category : 'other',
    name: raw.name, brand: v(raw.brand), productLine: v(raw.productLine), variant: v(raw.variant), size: v(raw.size), color: v(raw.color), material: v(raw.material),
    visibleText: raw.visibleText ?? [], barcode: v(raw.barcode), confidence: Math.max(0, Math.min(1, raw.confidence ?? 0.5)), closeUp: v(raw.closeUp),
    uncertain: (raw.uncertain ?? []).filter((f): f is (typeof allowed)[number] => (allowed as readonly string[]).includes(f)),
  });
}
