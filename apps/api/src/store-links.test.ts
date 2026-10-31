import { afterEach, describe, expect, it, vi } from 'vitest';
import { amazonCartLink, instacartListLink } from './store-links.js';

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe('official whole-list links', () => {
  it('builds Amazon’s add-to-cart link only when every item is an Amazon product', () => {
    expect(amazonCartLink([{ name: 'Tea', amount: 1, unit: 'each', packs: 2, productUrl: 'https://www.amazon.com/Lipton-Black-Tea/dp/B000QSO98W' }, { name: 'Cups', amount: 5, unit: 'each', packs: 1, productUrl: 'https://www.amazon.com/dp/B07Y2LRK4M?th=1' }]))
      .toBe('https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B000QSO98W&Quantity.1=2&ASIN.2=B07Y2LRK4M&Quantity.2=1');
    expect(amazonCartLink([{ name: 'Tea', amount: 1, unit: 'each', packs: 1, productUrl: 'https://www.target.com/p/x/-/A-1' }])).toBeNull();
  });
  it('asks Instacart for a shopping-list page, sending spoon-sized amounts as one pack', async () => {
    vi.stubEnv('INSTACART_API_KEY', 'test-key');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ products_link_url: 'http://instacart.com/store/shopping_lists/1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const url = await instacartListLink('Evening tea', [{ name: 'Black tea bags', amount: 1, unit: 'each', packs: 1 }, { name: 'Cardamom', amount: 1, unit: 'tsp', packs: 1 }, { name: 'Milk', amount: 1, unit: 'l', packs: 1 }]);
    expect(url).toBe('https://instacart.com/store/shopping_lists/1');
    const [endpoint, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(endpoint).toBe('https://connect.instacart.com/idp/v1/products/products_link');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string).line_items).toEqual([
      { name: 'Black tea bags', quantity: 1, unit: 'each', display_text: 'Black tea bags' },
      { name: 'Cardamom', quantity: 1, unit: 'each', display_text: 'Cardamom' },
      { name: 'Milk', quantity: 1, unit: 'liter', display_text: 'Milk' },
    ]);
  });
});
