import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { currentUserId } from './context.js';

/**
 * Daily usage ledger: AI model requests (including possible tool steps) and private store browser runs, counted for
 * the whole server and for each person. These are local limits, not provider billing caps.
 */
type Kind = 'ai' | 'browser';
type Ledger = { day: string; used: number; users?: Record<string, number>; browser?: number; browserUsers?: Record<string, number> };

let queue: Promise<unknown> = Promise.resolve();
const file = () => resolve(import.meta.dirname, '../../../', process.env.DATA_DIR ?? '.data', 'gateway-quota.json');
const today = () => new Date().toISOString().slice(0, 10);
const setting = (name: string, fallback: number, max: number) => {
  const configured = Number(process.env[name] ?? fallback);
  return Number.isInteger(configured) ? Math.max(0, Math.min(max, configured)) : 0;
};
// About 500 short agent steps a day costs a few dollars of Gateway credit; set the env values to tighten them.
const limits = (kind: Kind) => kind === 'ai'
  ? { total: setting('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', 500, 100_000), perUser: setting('AERI_USER_DAILY_AI_REQUESTS', 200, 100_000) }
  : { total: setting('AERI_DAILY_BROWSER_RUNS', 200, 100_000), perUser: setting('AERI_USER_DAILY_BROWSER_RUNS', 12, 10_000) };

async function load(): Promise<Ledger> {
  try {
    const saved = JSON.parse(await readFile(file(), 'utf8')) as Ledger;
    if (saved.day !== today()) return { day: today(), used: 0 };
    if (!Number.isInteger(saved.used) || saved.used < 0) throw new Error('Invalid Gateway quota ledger');
    return saved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { day: today(), used: 0 };
    throw error;
  }
}
async function save(ledger: Ledger) {
  await mkdir(dirname(file()), { recursive: true });
  await writeFile(`${file()}.tmp`, JSON.stringify(ledger), { mode: 0o600 });
  await rename(`${file()}.tmp`, file());
}
const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };

function reserve(kind: Kind, count: number, message: { total: string; user: string }): Promise<void> {
  const user = currentUserId();
  return serial(async () => {
    const ledger = await load(), { total, perUser } = limits(kind);
    const usersKey = kind === 'ai' ? 'users' : 'browserUsers';
    const used = kind === 'ai' ? ledger.used : ledger.browser ?? 0;
    const mine = user ? ledger[usersKey]?.[user] ?? 0 : 0;
    if (!Number.isInteger(count) || count < 1 || used + count > total) throw new Error(message.total);
    if (user && mine + count > perUser) throw new Error(message.user);
    if (kind === 'ai') ledger.used = used + count; else ledger.browser = used + count;
    if (user) ledger[usersKey] = { ...ledger[usersKey], [user]: mine + count };
    await save(ledger);
  });
}
function refund(kind: Kind, count: number, user = currentUserId()): Promise<void> {
  if (!Number.isInteger(count) || count < 1) return Promise.resolve();
  return serial(async () => {
    const ledger = await load().catch(() => null);
    if (!ledger) return;
    const usersKey = kind === 'ai' ? 'users' : 'browserUsers';
    if (kind === 'ai') ledger.used = Math.max(0, ledger.used - count); else ledger.browser = Math.max(0, (ledger.browser ?? 0) - count);
    if (user && ledger[usersKey]?.[user]) ledger[usersKey]![user] = Math.max(0, ledger[usersKey]![user] - count);
    await save(ledger);
  });
}

export const reserveGatewayRequests = (count = 1) => reserve('ai', count, {
  total: 'Gateway daily request limit reached. Try tomorrow or use text memory commands.',
  user: 'You’ve reached today’s limit for Aeri’s AI. It resets at midnight UTC.',
});
/** Gives back reserved requests an agent run didn't use, so a one-step answer counts as one. */
export const refundGatewayRequests = (count: number) => refund('ai', count);

/** One private store browser run (a store cart, a page check). Browsers are billed by the minute. */
export const reserveBrowserRun = () => reserve('browser', 1, {
  total: 'Aeri has reached today’s limit for store visits. Try again tomorrow.',
  user: 'You’ve reached today’s limit for store visits. It resets at midnight UTC.',
});
export const refundBrowserRun = () => refund('browser', 1);

/** What one person has used today, for Settings. */
export async function usageFor(userId: string) {
  const ledger = await load().catch(() => ({ day: today(), used: 0 } as Ledger));
  return { day: ledger.day, ai: { used: ledger.users?.[userId] ?? 0, limit: limits('ai').perUser }, browser: { used: ledger.browserUsers?.[userId] ?? 0, limit: limits('browser').perUser } };
}

/** Agent runs report each model call as a step; the final step holds the reply (earlier ones are tool calls). */
export function agentRun(result: { text?: string; steps?: Array<{ text?: string }> }, reserved: number) {
  const steps = result.steps?.length ?? reserved;
  const final = result.steps?.length ? result.steps[result.steps.length - 1].text?.trim() : undefined;
  return { text: final || result.text?.trim() || '', unused: Math.max(0, reserved - Math.max(1, steps)) };
}
