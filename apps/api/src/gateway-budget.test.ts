import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reserveGatewayRequests } from './gateway-budget.js';

let directory: string;
const ledger = () => join(directory, 'gateway-quota.json');
const saved = async () => JSON.parse(await readFile(ledger(), 'utf8')) as { day: string; used: number };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'aeri-gateway-quota-')); vi.stubEnv('DATA_DIR', directory);
  vi.stubEnv('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', '50'); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-04T12:00:00.000Z'));
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('persisted local Gateway request budget', () => {
  it('serializes concurrent reservations and clamps configuration to at most 100 requests', async () => {
    vi.stubEnv('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', '100000');
    const results = await Promise.allSettled(Array.from({ length: 110 }, () => reserveGatewayRequests()));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(100);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(10);
    expect(await saved()).toEqual({ day: '2026-10-04', used: 100 });
    await expect(reserveGatewayRequests()).rejects.toThrow(/daily request limit/);
  });
  it('reserves possible model/tool steps in one operation and preserves usage after module reload', async () => {
    vi.stubEnv('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', '8');
    await reserveGatewayRequests(6); vi.resetModules();
    const restarted = await import('./gateway-budget.js');
    await expect(restarted.reserveGatewayRequests(3)).rejects.toThrow(/daily request limit/);
    await restarted.reserveGatewayRequests(2);
    expect((await saved()).used).toBe(8);
  });
  it('starts a fresh daily ledger rather than treating yesterday usage as today usage', async () => {
    vi.stubEnv('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', '2'); await reserveGatewayRequests(2);
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z')); await reserveGatewayRequests();
    expect(await saved()).toEqual({ day: '2026-10-05', used: 1 });
  });
  it('fails closed on corrupt ledgers, invalid counts, and disabled or malformed limits', async () => {
    for (const count of [0, -1, 1.5, Number.NaN]) await expect(reserveGatewayRequests(count)).rejects.toThrow();
    for (const limit of ['0', '-1', 'not-a-number', '3.1']) { vi.stubEnv('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', limit); await expect(reserveGatewayRequests()).rejects.toThrow(); }
    vi.stubEnv('NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT', '10');
    await writeFile(ledger(), JSON.stringify({ day: '2026-10-04', used: '2' }));
    await expect(reserveGatewayRequests()).rejects.toThrow(/Invalid Gateway quota ledger/);
    expect(JSON.parse(await readFile(ledger(), 'utf8')).used).toBe('2');
  });
});
