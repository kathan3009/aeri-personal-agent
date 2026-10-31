import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccounts } from './accounts.js';
import { createApp } from './app.js';
import { createPeople } from './people.js';

let directory = '';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aeri-people-')); vi.stubEnv('DATA_DIR', directory); vi.stubEnv('NEON_AI_GATEWAY_API_KEY', ''); vi.stubEnv('NEON_AI_GATEWAY_TOKEN', ''); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

function server() {
  const accounts = createAccounts({ dataDir: directory, secret: 'test-secret-that-is-long-enough-123' });
  const people = createPeople(accounts, { databaseUrl: '', dataDir: directory });
  const sent = new Map<string, string>();
  const app = createApp({ accounts, people, kernel: () => null, sendCode: async (email, code) => { sent.set(email, code); return true; } });
  const json = (path: string, token?: string, init: RequestInit = {}) => app.request(path, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const post = (path: string, body: unknown, token?: string) => json(path, token, { method: 'POST', body: JSON.stringify(body) });
  const signIn = async (email: string) => {
    expect((await post('/v1/auth/code', { email })).status).toBe(200);
    const response = await post('/v1/auth/verify', { email, code: sent.get(email), acceptTerms: true });
    expect(response.status).toBe(200);
    return (await response.json() as { token: string }).token;
  };
  return { app, json, post, signIn, sent };
}

describe('each person has their own Aeri', () => {
  it('signs in with an emailed code and never shows one person another person’s data', async () => {
    const s = server();
    expect((await s.json('/v1/bootstrap')).status).toBe(401);
    const ana = await s.signIn('ana@example.com'), ben = await s.signIn('ben@example.com');
    expect((await s.post('/v1/inventory', { name: 'Oat milk', amount: 2, unit: 'each' }, ana)).status).toBe(200);
    expect((await s.post('/v1/preferences', { key: 'shoe size', value: '9' }, ana)).status).toBe(200);
    const anaState = (await (await s.json('/v1/bootstrap', ana)).json() as any);
    const benState = (await (await s.json('/v1/bootstrap', ben)).json() as any);
    expect(anaState.account.email).toBe('ana@example.com');
    expect(anaState.state.inventory.map((i: any) => i.name)).toEqual(['Oat milk']);
    expect(benState.state.inventory).toEqual([]);
    expect(benState.state.preferences).toEqual({});
    // Ben can't change Ana's things by id either.
    const itemId = anaState.state.inventory[0].id;
    expect((await s.json(`/v1/inventory/${itemId}`, ben, { method: 'DELETE' })).status).toBe(404);
    expect((await (await s.json('/v1/bootstrap', ana)).json() as any).state.inventory).toHaveLength(1);
    // Ana's files live in her own folder.
    expect(await readdir(join(directory, 'users'))).toHaveLength(2);
  });

  it('signs out one device and deletes an account with everything in it', async () => {
    const s = server();
    const ana = await s.signIn('ana@example.com');
    await s.post('/v1/inventory', { name: 'Rice', amount: 1, unit: 'each' }, ana);
    expect((await s.json('/v1/account', ana, { method: 'DELETE', body: JSON.stringify({ confirm: 'someone@example.com' }) })).status).toBe(400);
    const exported = await (await s.json('/v1/account/export', ana)).json() as any;
    expect(exported.account.email).toBe('ana@example.com');
    expect(exported.state.inventory[0].name).toBe('Rice');
    expect((await s.json('/v1/account', ana, { method: 'DELETE', body: JSON.stringify({ confirm: 'Ana@example.com' }) })).status).toBe(200);
    expect((await s.json('/v1/bootstrap', ana)).status).toBe(401);
    expect(await readdir(join(directory, 'users'))).toHaveLength(0);
    // Signing up again starts empty.
    const again = await s.signIn('ana@example.com');
    expect((await (await s.json('/v1/bootstrap', again)).json() as any).state.inventory).toEqual([]);
    expect((await s.post('/v1/auth/sign-out', {}, again)).status).toBe(200);
    expect((await s.json('/v1/bootstrap', again)).status).toBe(401);
  });

  it('keeps diagnostics for admins and limits sign-in attempts from one address', async () => {
    vi.stubEnv('AERI_ADMIN_EMAILS', 'ops@example.com');
    const s = server();
    const ana = await s.signIn('ana@example.com');
    expect((await s.json('/v1/sites', ana)).status).toBe(404);
    const ops = await s.signIn('ops@example.com');
    expect((await s.json('/v1/sites', ops)).status).toBe(200);
    for (let i = 0; i < 8; i++) await s.post('/v1/auth/code', { email: `p${i}@example.com` });
    expect((await s.post('/v1/auth/code', { email: 'last@example.com' })).status).toBe(429);
  });

  it('shows a development code only when email can’t be sent and the server isn’t in production', async () => {
    const accounts = createAccounts({ dataDir: directory, secret: 'test-secret-that-is-long-enough-123' });
    const app = createApp({ accounts, people: createPeople(accounts, { databaseUrl: '', dataDir: directory }), kernel: () => null, sendCode: async () => false });
    const ask = () => app.request('/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com' }) });
    const dev = await (await ask()).json() as any;
    expect(dev.devCode).toMatch(/^\d{6}$/);
    vi.stubEnv('NODE_ENV', 'production');
    await new Promise(done => setTimeout(done, 0));
    const response = await app.request('/v1/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'prod@example.com' }) });
    expect(response.status).toBe(503);
  });
});
