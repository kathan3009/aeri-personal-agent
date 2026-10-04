const aliases: Record<string, string> = { tomatoes: 'tomato', potatoes: 'potato', onions: 'onion', eggs: 'egg', cloves: 'clove', 'garlic cloves': 'garlic', 'garlic clove': 'garlic' };
/** Lower-cases, strips punctuation, and singularizes the last word so "Eggs" and "egg" are the same item. */
export const normalizeName = (name: string): string => {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (aliases[cleaned]) return aliases[cleaned];
  const words = cleaned.split(' ');
  const last = words[words.length - 1] ?? '';
  if (last.length > 3 && /oes$/.test(last)) words[words.length - 1] = last.slice(0, -2);
  else if (last.length > 3 && /[^su]s$/.test(last) && !/(ss|us|is|ses)$/.test(last)) words[words.length - 1] = last.slice(0, -1);
  return words.join(' ');
};
/** Rough word overlap between two product names, from 0 to 1. */
export function nameOverlap(a: string, b: string): number {
  const words = (s: string) => new Set(normalizeName(s).split(' ').map(w => normalizeName(w)).filter(w => w.length > 1));
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0; for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}
