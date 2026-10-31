import { z } from 'zod';

export const unitSchema = z.enum(['each', 'g', 'kg', 'ml', 'l', 'oz', 'lb', 'cup', 'tbsp', 'tsp']);
export type Unit = z.infer<typeof unitSchema>;
export const quantitySchema = z.object({ amount: z.number().positive(), unit: unitSchema });
export type Quantity = z.infer<typeof quantitySchema>;

export type Dimension = 'mass' | 'volume' | 'count';
export const toBase = (q: Quantity): { amount: number; dimension: Dimension } => {
  switch (q.unit) {
    case 'kg': return { amount: q.amount * 1000, dimension: 'mass' };
    case 'g': return { amount: q.amount, dimension: 'mass' };
    case 'lb': return { amount: q.amount * 453.592, dimension: 'mass' };
    case 'oz': return { amount: q.amount * 28.3495, dimension: 'mass' };
    case 'l': return { amount: q.amount * 1000, dimension: 'volume' };
    case 'ml': return { amount: q.amount, dimension: 'volume' };
    case 'cup': return { amount: q.amount * 236.588, dimension: 'volume' };
    case 'tbsp': return { amount: q.amount * 14.7868, dimension: 'volume' };
    case 'tsp': return { amount: q.amount * 4.92892, dimension: 'volume' };
    case 'each': return { amount: q.amount, dimension: 'count' };
  }
};

/** Reads a pack size such as "32 oz", "1.5 L", "half gallon" or "12 ct" into a quantity, when it is unambiguous. */
export function parsePackSize(text?: string | null): Quantity | null {
  if (!text) return null;
  const s = text.toLowerCase().replace(/,/g, '.');
  if (/half[\s-]?gallon/.test(s)) return { amount: 1892.71, unit: 'ml' };
  if (/\bgallon\b/.test(s)) return { amount: 3785.41, unit: 'ml' };
  const m = s.match(/(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|kg|g|grams?|ml|l|liters?|litres?|ct|count|pack|pk|each|eggs?)\b/);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!(amount > 0)) return null;
  const unit = m[2].replace(/\s+/g, '');
  if (unit.startsWith('fl')) return { amount: amount * 29.5735, unit: 'ml' };
  if (/^(oz|ounce)/.test(unit)) return { amount, unit: 'oz' };
  if (/^(lb|pound)/.test(unit)) return { amount, unit: 'lb' };
  if (unit === 'kg') return { amount, unit: 'kg' };
  if (/^(g|gram)/.test(unit)) return { amount, unit: 'g' };
  if (unit === 'ml') return { amount, unit: 'ml' };
  if (/^(l|liter|litre)/.test(unit)) return { amount, unit: 'l' };
  return { amount, unit: 'each' };
}
