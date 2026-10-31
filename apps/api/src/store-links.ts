import { ProviderError, withProvider } from './providers.js';

/**
 * Official ways stores accept a whole list at once. They're more reliable than driving a browser, and the person
 * finishes in the store's own app or site where they're already signed in.
 */
export type ListLine = { name: string; amount: number; unit: string; packs: number; productUrl?: string };

export const instacartConfigured = () => !!process.env.INSTACART_API_KEY;

const instacartUnits: Record<string, string> = { each: 'each', g: 'gram', kg: 'kilogram', ml: 'milliliter', l: 'liter', oz: 'ounce', lb: 'pound', cup: 'cup', tbsp: 'tablespoon', tsp: 'teaspoon' };

/**
 * Instacart Developer Platform: a shopping-list page with every item. The person chooses a nearby store there and
 * adds everything to their Instacart cart in one tap. Spoon-sized recipe amounts are sent as "1 each" so Instacart
 * suggests a normal pack instead of a teaspoon of something.
 */
export async function instacartListLink(title: string, lines: ListLine[]): Promise<string> {
  const key = process.env.INSTACART_API_KEY;
  if (!key) throw new Error('Instacart isn’t connected');
  const base = (process.env.INSTACART_API_BASE ?? 'https://connect.instacart.com').replace(/\/$/, '');
  const small = (line: ListLine) => ['tsp', 'tbsp', 'cup'].includes(line.unit) || (['g', 'ml'].includes(line.unit) && line.amount < 250);
  const body = {
    title: title.slice(0, 120), link_type: 'shopping_list',
    line_items: lines.slice(0, 100).map(line => small(line)
      ? { name: line.name, quantity: Math.max(1, line.packs), unit: 'each', display_text: line.name }
      : { name: line.name, quantity: line.unit === 'each' ? Math.max(line.amount, line.packs) : line.amount, unit: instacartUnits[line.unit] ?? 'each', display_text: line.name }),
    landing_page_configuration: { enable_pantry_items: false },
  };
  const response = await withProvider('Instacart', () => fetch(`${base}/idp/v1/products/products_link`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  }));
  if (!response.ok) throw new ProviderError('Instacart', response.status === 401 ? 'the API key wasn’t accepted' : `the list page couldn’t be made (${response.status})`);
  const json = await response.json() as { products_link_url?: string };
  if (!json.products_link_url?.startsWith('http')) throw new ProviderError('Instacart', 'no list page came back');
  return json.products_link_url.replace(/^http:/, 'https:');
}

/** Amazon's add-to-cart form: one link that puts every listed product (by its ASIN) in the person's Amazon cart. */
export function amazonCartLink(lines: ListLine[]): string | null {
  const asins = lines.map(line => ({ line, asin: line.productUrl?.match(/amazon\.com\/(?:[^/]+\/)?(?:dp|gp\/product)\/([A-Z0-9]{10})/)?.[1] }));
  if (!asins.length || asins.some(entry => !entry.asin)) return null;
  const params = asins.flatMap(({ line, asin }, i) => [`ASIN.${i + 1}=${asin}`, `Quantity.${i + 1}=${Math.max(1, line.packs)}`]);
  return `https://www.amazon.com/gp/aws/cart/add.html?${params.join('&')}`;
}
