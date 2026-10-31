import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccounts, type Accounts } from './accounts.js';
import { createLimiter } from './rate-limit.js';

let directory = '', clock = new Date('2026-10-04T12:00:00.000Z');
const open = (extra: Parameters<typeof createAccounts>[0] = {}) => createAccounts({ dataDir: directory, secret: 'test-secret-that-is-long-enough-123', now: () => clock, ...extra });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aeri-accounts-')); clock = new Date('2026-10-04T12:00:00.000Z'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const later = (ms: number) => { clock = new Date(clock.getTime() + ms); };

describe('email code sign-in', () => {
  it('signs in with the latest code once, and new accounts must accept the terms', async () => {
    const accounts = open();
    const { code } = await accounts.requestCode('  Person@Example.com ');
    await expect(accounts.verifyCode('person@example.com', code)).rejects.toThrow(/Accept the terms/);
    const first = await accounts.verifyCode('person@example.com', code, true);
    expect(first.created).toBe(true);
    expect(first.user.email).toBe('person@example.com');
    expect(await accounts.userForToken(first.token)).toMatchObject({ id: first.user.id });
    // A code works once.
    await expect(accounts.verifyCode('person@example.com', code, true)).rejects.toThrow(/expired/);
    // The same email signs back into the same account.
    later(31_000);
    const again = await accounts.verifyCode('person@example.com', (await accounts.requestCode('person@example.com')).code);
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);
  });

  it('locks a code after five wrong guesses and expires it after ten minutes', async () => {
    const accounts = open();
    const { code } = await accounts.requestCode('a@example.com');
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await expect(accounts.verifyCode('a@example.com', wrong, true)).rejects.toThrow(/isn’t right/);
    await expect(accounts.verifyCode('a@example.com', code, true)).rejects.toThrow(/Too many wrong codes/);
    later(31_000);
    const fresh = await accounts.requestCode('a@example.com');
    later(10 * 60_000 + 1);
    await expect(accounts.verifyCode('a@example.com', fresh.code, true)).rejects.toThrow(/expired/);
  });

  it('limits how often codes are sent to one email', async () => {
    const accounts = open();
    await accounts.requestCode('b@example.com');
    await expect(accounts.requestCode('b@example.com')).rejects.toThrow(/Wait 30 seconds/);
    for (let i = 0; i < 4; i++) { later(31_000); await accounts.requestCode('b@example.com'); }
    later(31_000);
    await expect(accounts.requestCode('b@example.com')).rejects.toThrow(/Too many codes/);
    later(60 * 60_000);
    await expect(accounts.requestCode('b@example.com')).resolves.toBeTruthy();
    await expect(accounts.requestCode('not an email')).rejects.toThrow();
  });

  it('keeps only hashes of codes and sessions on disk', async () => {
    const accounts = open();
    const { code } = await accounts.requestCode('c@example.com');
    const { token } = await accounts.verifyCode('c@example.com', code, true);
    const { readFile } = await import('node:fs/promises');
    const saved = await readFile(join(directory, 'accounts.json'), 'utf8');
    expect(saved).not.toContain(token);
    expect(saved).toContain(createHash('sha256').update(token).digest('hex'));
  });

  it('ends sessions on sign out, after 90 idle days, and when the account is deleted', async () => {
    const accounts = open();
    const sign = async (email: string) => { later(31_000); return accounts.verifyCode(email, (await accounts.requestCode(email)).code, true); };
    const one = await sign('d@example.com'), two = await sign('d@example.com');
    await accounts.signOut(one.token);
    expect(await accounts.userForToken(one.token)).toBeNull();
    expect(await accounts.userForToken(two.token)).not.toBeNull();
    later(91 * 24 * 60 * 60_000);
    expect(await accounts.userForToken(two.token)).toBeNull();
    const three = await sign('d@example.com');
    await accounts.setMailbox(three.user.id, { inboxId: 'inbox_d', address: 'd@agentmail.to', connectedAt: clock.toISOString(), owned: true });
    expect((await accounts.userForInbox('inbox_d'))?.id).toBe(three.user.id);
    await accounts.deleteUser(three.user.id);
    expect(await accounts.userForToken(three.token)).toBeNull();
    expect(await accounts.userForInbox('inbox_d')).toBeNull();
    expect(await accounts.listUsers()).toHaveLength(0);
    expect(await accounts.userForToken('aeri_made-up-token-that-is-long-enough')).toBeNull();
  });

  it('gives the owner the data and store sign-ins kept before accounts existed', async () => {
    const accounts: Accounts = open({ ownerEmail: 'owner@example.com', legacyToken: 'old-access-code' });
    const owner = await accounts.verifyCode('owner@example.com', (await accounts.requestCode('owner@example.com')).code, true);
    expect(owner.user.id).toBe('default');
    expect(owner.user.kernelScope).toBe(createHash('sha256').update('old-access-code').digest('hex').slice(0, 24));
    const other = await accounts.verifyCode('x@example.com', (await accounts.requestCode('x@example.com')).code, true);
    expect(other.user.id).not.toBe('default');
    expect(other.user.kernelScope).not.toBe(owner.user.kernelScope);
  });

  it('accepts a fixed code only for the app review account', async () => {
    const accounts = open({ review: { email: 'review@example.com', code: '424242' } });
    expect((await accounts.verifyCode('review@example.com', '424242', true)).created).toBe(true);
    await expect(accounts.verifyCode('someone@example.com', '424242', true)).rejects.toThrow(/expired/);
  });
});

describe('rate limits', () => {
  it('allows a number of hits per window, then reports when to retry', () => {
    let at = 0; const limit = createLimiter(() => at);
    for (let i = 0; i < 3; i++) expect(limit('k', 3, 1000).ok).toBe(true);
    expect(limit('k', 3, 1000)).toEqual({ ok: false, retryAfter: 1 });
    expect(limit('other', 3, 1000).ok).toBe(true);
    at = 1001;
    expect(limit('k', 3, 1000).ok).toBe(true);
  });
});
