import { afterEach, expect, it, vi } from 'vitest';
import { ProviderError, researchProducts } from './providers.js';

const previousKey = process.env.EXA_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (previousKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = previousKey;
});

it('searches grocery products and returns only distinct HTTPS product links', async () => {
  process.env.EXA_API_KEY = 'test-exa-key';
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [
    { title: 'Fresh tomatoes', url: 'https://shop.example/tomatoes' },
    { title: 'Fresh tomatoes again', url: 'https://shop.example/tomatoes' },
    { title: 'Unsafe link', url: 'javascript:alert(1)' },
    { title: '', url: 'https://shop.example/empty' },
    { title: 'Garlic', url: 'https://shop.example/garlic' },
  ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetcher);

  expect(await researchProducts('buy fresh tomatoes groceries online')).toEqual([
    { title: 'Fresh tomatoes', url: 'https://shop.example/tomatoes' },
    { title: 'Garlic', url: 'https://shop.example/garlic' },
  ]);
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://api.exa.ai/search');
  expect(options.headers).toMatchObject({ 'x-api-key': 'test-exa-key' });
  expect(JSON.parse(String(options.body))).toMatchObject({ type: 'auto', numResults: 5 });
});

it('names an Exa API failure without exposing its key', async () => {
  process.env.EXA_API_KEY = 'test-exa-key';
  vi.stubGlobal('fetch', async () => new Response('failed', { status: 401 }));
  await expect(researchProducts('tomatoes')).rejects.toMatchObject({ provider: 'Exa', message: 'Exa: search returned 401' } satisfies Partial<ProviderError>);
});
