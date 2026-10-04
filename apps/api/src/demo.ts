import type { Ingredient, Recipe, Observation } from '@personal-agent/core';

export const demoRecipe = (id: string, now: string, sourceUrl?: string, title = 'Creamy tomato pasta'): Recipe => ({
  id, createdAt: now, sourceUrl, title, servings: 2, source: 'demo',
  ingredients: [
    { name: 'Pasta', quantity: { amount: 250, unit: 'g' }, optional: false },
    { name: 'Tomatoes', quantity: { amount: 4, unit: 'each' }, optional: false },
    { name: 'Garlic', quantity: { amount: 3, unit: 'each' }, optional: false },
    { name: 'Cream', quantity: { amount: 150, unit: 'ml' }, optional: false },
    { name: 'Olive oil', quantity: { amount: 2, unit: 'tbsp' }, optional: false },
  ],
  instructions: ['Boil the pasta until tender.', 'Cook chopped tomatoes and garlic in olive oil.', 'Stir in cream, toss with pasta and serve.'],
});

export const demoObservations = (id: () => string): Observation[] => [
  { id: id(), name: 'Tomatoes', quantity: { amount: 2, unit: 'each' }, confidence: .91, decision: 'pending' },
  { id: id(), name: 'Milk', quantity: { amount: 1, unit: 'l' }, confidence: .72, decision: 'pending' },
  { id: id(), name: 'Eggs', quantity: { amount: 6, unit: 'each' }, confidence: .65, decision: 'pending' },
];

const amountWord = (value: string) => ({ one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>)[value.toLowerCase()] ?? Number(value);
export function parseShoppingCommand(text: string): { kind: 'inventory' | 'consume' | 'preference' | 'recipe' | 'unknown'; key?: string; value?: string } {
  const s = text.trim();
  const quantity = '(\\d+(?:\\.\\d+)?|one|two|three|four|five|six)';
  const used = s.match(new RegExp(`(?:we used|i used|we ate|i ate)\\s+${quantity}\\s+(.+?)(?:\\s+from (?:the )?(?:fridge|pantry|kitchen))?[.!]?$`, 'i'));
  if (used) return { kind: 'consume', key: used[2].replace(/[.!]$/, ''), value: String(amountWord(used[1])) };
  const have = s.match(new RegExp(`(?:i have|we have|add)\\s+${quantity}\\s+(.+?)(?:\\s+in (?:the )?(?:fridge|pantry|kitchen))?[.!]?$`, 'i'));
  if (have) return { kind: 'inventory', key: have[2].replace(/[.!]$/, ''), value: String(amountWord(have[1])) };
  const size = s.match(/(?:my|i wear|i use)\s+(.+?)\s+(?:size is|size)\s+(.+?)[.!]?$/i);
  if (size) return { kind: 'preference', key: `${size[1]} size`, value: size[2].replace(/[.!]$/, '') };
  const clothing = s.match(/i (?:wear|use)\s+(?:a\s+)?(.+?)\s+(?:in|for)\s+(.+?)[.!]?$/i);
  if (clothing) return { kind: 'preference', key: `${clothing[2]} size`, value: clothing[1].replace(/[.!]$/, '') };
  const preference = s.match(/(?:remember that|remember)\s+(.+?)[.!]?$/i);
  if (preference) return { kind: 'preference', key: 'note', value: preference[1].replace(/[.!]$/, '') };
  if (/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(s)) return { kind: 'recipe' };
  return { kind: 'unknown' };
}

export function parseIngredients(value: unknown): Ingredient[] {
  if (!Array.isArray(value)) throw new Error('Ingredients must be an array');
  return value.map((entry: unknown) => {
    const item = entry as Record<string, unknown>;
    return { name: String(item.name), quantity: { amount: Number(item.amount ?? 1), unit: String(item.unit ?? 'each') as Ingredient['quantity']['unit'] }, optional: Boolean(item.optional) };
  });
}
