import { Platform, type TextStyle, type ViewStyle } from 'react-native';

// "Clear air": a cool near-white canvas under a faint band of sky, one deep sky accent,
// and three small signals (sunrise = needs you, leaf = confirmed, ember = problem).
export const c = {
  canvas: '#F2F7FB',
  surface: '#FFFFFF',
  ink: '#0F2B40',
  ink2: '#557086',
  ink3: '#8AA0B2',
  hairline: 'rgba(15,43,64,0.08)',
  fill: 'rgba(15,43,64,0.05)',
  accent: '#1B78BF',
  accentPressed: '#15639F',
  tint: '#E3F0FA',
  tintStrong: '#CFE5F6',
  leaf: '#1F8466',
  leafTint: '#DCF1E9',
  ember: '#B4473F',
  emberTint: '#FBE9E7',
  sunrise: '#E0911F',
  sunriseTint: '#FCF1DF',
  white: '#FFFFFF',
};

const rounded = Platform.select({ ios: 'ui-rounded', web: 'ui-rounded, -apple-system, system-ui, sans-serif', default: undefined });

// Apple's text styles, tuned slightly tighter at display sizes.
export const t = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.6, color: c.ink },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3, color: c.ink },
  title3: { fontSize: 20, lineHeight: 25, fontWeight: '600', letterSpacing: -0.2, color: c.ink },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2, color: c.ink },
  body: { fontSize: 17, lineHeight: 24, fontWeight: '400', letterSpacing: -0.2, color: c.ink },
  callout: { fontSize: 16, lineHeight: 22, fontWeight: '400', letterSpacing: -0.15, color: c.ink },
  subhead: { fontSize: 15, lineHeight: 20, fontWeight: '400', letterSpacing: -0.1, color: c.ink2 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', color: c.ink2 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500', color: c.ink3 },
  // Counts and quantities read like household labels: rounded, tabular.
  number: { fontFamily: rounded, fontVariant: ['tabular-nums'], fontWeight: '600', color: c.ink },
} satisfies Record<string, TextStyle>;

export const radius = { row: 12, group: 16, dock: 22, sheet: 28, pill: 999 };
export const space = { gutter: 20, section: 28 };

// Sky-tinted shadow, used only on things that float above the canvas.
export const lift: ViewStyle = Platform.select({
  web: { boxShadow: '0 10px 30px rgba(39, 96, 140, 0.12), 0 1px 2px rgba(39, 96, 140, 0.08)' } as ViewStyle,
  default: { shadowColor: '#27608C', shadowOpacity: 0.12, shadowRadius: 22, shadowOffset: { width: 0, height: 10 }, elevation: 6 },
});

// The sky above the content shifts gently through the day; it never gets dark.
export function skyFor(date = new Date()): [string, string, string] {
  const hour = date.getHours();
  if (hour >= 5 && hour < 11) return ['#D5EDF8', '#E9F4FA', c.canvas];
  if (hour >= 11 && hour < 17) return ['#D3E7F8', '#E8F2FB', c.canvas];
  if (hour >= 17 && hour < 21) return ['#E0E2F6', '#ECEFF9', c.canvas];
  return ['#DAE1F3', '#EAEEF8', c.canvas];
}

export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  return hour < 5 ? 'Good evening.' : hour < 12 ? 'Good morning.' : hour < 17 ? 'Good afternoon.' : 'Good evening.';
}

const units: Record<string, string> = { each: '', g: 'g', kg: 'kg', ml: 'ml', l: 'L', oz: 'oz', lb: 'lb', cup: 'cup', tbsp: 'tbsp', tsp: 'tsp' };
export const amount = (n: number) => Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
export const quantity = (q: { amount: number; unit: string }) => {
  const unit = units[q.unit] ?? q.unit;
  return unit ? `${amount(q.amount)} ${unit}${q.unit === 'cup' && q.amount !== 1 ? 's' : ''}` : amount(q.amount);
};
export const titleCase = (value: string) => value.replace(/^\s*\w/, letter => letter.toUpperCase());
export const host = (url?: string) => { try { return url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch { return ''; } };
