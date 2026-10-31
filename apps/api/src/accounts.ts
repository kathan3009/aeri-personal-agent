import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type postgres from 'postgres';
import { z } from 'zod';

/**
 * People and their sign-ins. Aeri signs people in with a one-time code sent to their email: no passwords to store or
 * leak. Session tokens and codes are kept only as hashes, so a copy of the data can't be used to sign in.
 */
export type Mailbox = { inboxId: string; address: string; connectedAt: string; owned: boolean };
export type User = { id: string; email: string; createdAt: string; kernelScope: string; mailbox?: Mailbox; acceptedTermsAt?: string };
type Session = { key: string; userId: string; createdAt: string; lastSeenAt: string; expiresAt: string };
type Code = { hash: string; expiresAt: string; attempts: number; sent: string[] };

export interface Accounts {
  /** Creates a sign-in code for this email (the caller sends it). Throws when asked too often. */
  requestCode(email: string): Promise<{ email: string; code: string; expiresAt: string }>;
  /** Checks a code and starts a session. A new email becomes a new account. */
  verifyCode(email: string, code: string, acceptedTerms?: boolean): Promise<{ token: string; user: User; created: boolean }>;
  userForToken(token: string): Promise<User | null>;
  signOut(token: string): Promise<void>;
  getUser(id: string): Promise<User | null>;
  setMailbox(id: string, mailbox: Mailbox | null): Promise<User>;
  userForInbox(inboxId: string): Promise<User | null>;
  listUsers(): Promise<User[]>;
  /** Removes the account and every session. The caller removes the person's data and outside resources first. */
  deleteUser(id: string): Promise<void>;
  close(): Promise<void>;
}

const CODE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;
const MIN_CODE_GAP_MS = 30_000;

export const normalizeEmail = (email: string) => z.string().trim().toLowerCase().max(254).pipe(z.email()).parse(email);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** A tiny keyed store with two backends: a local file (development, one machine) or Postgres tables. */
type Kv = {
  get<T>(collection: string, key: string): Promise<T | null>;
  put(collection: string, key: string, value: unknown): Promise<void>;
  remove(collection: string, key: string): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  close(): Promise<void>;
};

function fileKv(path: string): Kv {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>) => { const next = queue.then(work); queue = next.catch(() => undefined); return next; };
  const load = async (): Promise<Record<string, Record<string, unknown>>> => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  };
  const save = async (data: unknown) => { await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(`${path}.tmp`, JSON.stringify(data), { mode: 0o600 }); await rename(`${path}.tmp`, path); };
  return {
    get: <T>(collection: string, key: string) => serial(async () => ((await load())[collection]?.[key] as T) ?? null),
    put: (collection, key, value) => serial(async () => { const data = await load(); (data[collection] ??= {})[key] = value; await save(data); }),
    remove: (collection, key) => serial(async () => { const data = await load(); if (data[collection]) { delete data[collection][key]; await save(data); } }),
    list: <T>(collection: string) => serial(async () => Object.values((await load())[collection] ?? {}) as T[]),
    close: async () => { await queue; },
  };
}

function sqlKv(sql: postgres.Sql): Kv {
  let ready: Promise<void> | undefined;
  const setup = () => ready ??= (async () => {
    await sql`create table if not exists aeri_accounts (collection text not null, key text not null, body jsonb not null, updated_at timestamptz not null default now(), primary key (collection, key))`;
  })().catch(error => { ready = undefined; throw error; });
  return {
    get: async <T>(collection: string, key: string) => { await setup(); const rows = await sql`select body from aeri_accounts where collection = ${collection} and key = ${key}`; return rows.length ? rows[0].body as T : null; },
    put: async (collection, key, value) => { await setup(); await sql`insert into aeri_accounts (collection, key, body) values (${collection}, ${key}, ${JSON.stringify(value)}::jsonb) on conflict (collection, key) do update set body = excluded.body, updated_at = now()`; },
    remove: async (collection, key) => { await setup(); await sql`delete from aeri_accounts where collection = ${collection} and key = ${key}`; },
    list: async <T>(collection: string) => { await setup(); return (await sql`select body from aeri_accounts where collection = ${collection}`).map(row => row.body as T); },
    close: async () => undefined,
  };
}

type Options = { sql?: postgres.Sql | null; dataDir?: string; secret?: string; now?: () => Date; ownerEmail?: string; legacyToken?: string; review?: { email: string; code: string } };

export function createAccounts(options: Options = {}): Accounts {
  const kv = options.sql ? sqlKv(options.sql) : fileKv(resolve(import.meta.dirname, '../../../', options.dataDir ?? process.env.DATA_DIR ?? '.data', 'accounts.json'));
  const now = options.now ?? (() => new Date());
  // Codes are hashed with a server secret, so a leaked database row can't be turned back into a code.
  const secret = options.secret ?? process.env.AERI_SECRET ?? randomBytes(32).toString('hex');
  const owner = (options.ownerEmail ?? process.env.AERI_OWNER_EMAIL)?.trim().toLowerCase();
  const legacyToken = options.legacyToken ?? process.env.APP_ACCESS_TOKEN;
  const reviewEmail = (options.review?.email ?? process.env.AERI_REVIEW_EMAIL)?.trim().toLowerCase();
  const reviewCode = options.review?.code ?? process.env.AERI_REVIEW_CODE;
  const codeHash = (email: string, code: string) => createHmac('sha256', secret).update(`${email}:${code}`).digest('hex');

  const findByEmail = async (email: string) => { const id = await kv.get<string>('emails', email); return id ? kv.get<User>('users', id) : null; };
  const createUser = async (email: string, acceptedTerms: boolean): Promise<User> => {
    const isOwner = !!owner && email === owner;
    // The owner inherits the data and store sign-ins kept before accounts existed (scope "default", and the Kernel
    // profile names made from the old access code), so nothing has to be reconnected.
    const user: User = { id: isOwner && !(await kv.get('users', 'default')) ? 'default' : randomUUID(), email, createdAt: now().toISOString(),
      kernelScope: isOwner && legacyToken ? sha(legacyToken).slice(0, 24) : randomBytes(12).toString('hex'), ...(acceptedTerms ? { acceptedTermsAt: now().toISOString() } : {}) };
    await kv.put('users', user.id, user);
    await kv.put('emails', email, user.id);
    return user;
  };

  return {
    async requestCode(input) {
      const email = normalizeEmail(input), at = now().getTime();
      const prior = await kv.get<Code>('codes', email);
      const recent = (prior?.sent ?? []).filter(time => at - Date.parse(time) < 60 * 60_000);
      if (recent.length && at - Date.parse(recent[recent.length - 1]) < MIN_CODE_GAP_MS) throw new Error('A code was just sent. Wait 30 seconds before asking for another.');
      if (recent.length >= MAX_CODES_PER_HOUR) throw new Error('Too many codes asked for this email. Try again in an hour.');
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      const expiresAt = new Date(at + CODE_TTL_MS).toISOString();
      await kv.put('codes', email, { hash: codeHash(email, code), expiresAt, attempts: 0, sent: [...recent, now().toISOString()] } satisfies Code);
      return { email, code, expiresAt };
    },
    async verifyCode(input, code, acceptedTerms = false) {
      const email = normalizeEmail(input), clean = code.replace(/\D/g, '');
      const review = !!reviewEmail && !!reviewCode && email === reviewEmail && same(clean, reviewCode.replace(/\D/g, ''));
      if (!review) {
        const saved = await kv.get<Code>('codes', email);
        if (!saved || Date.parse(saved.expiresAt) <= now().getTime()) throw new Error('That code has expired. Ask for a new one.');
        if (saved.attempts >= MAX_ATTEMPTS) throw new Error('Too many wrong codes. Ask for a new one.');
        if (clean.length !== 6 || !same(saved.hash, codeHash(email, clean))) {
          await kv.put('codes', email, { ...saved, attempts: saved.attempts + 1 });
          throw new Error('That code isn’t right. Check the latest email from Aeri.');
        }
      }
      let user = await findByEmail(email), created = false;
      // Checked after the code (so it says nothing about who has an account) and before using it up.
      if (!user && !acceptedTerms) throw new Error('Accept the terms and privacy policy to create your account.');
      // A code works once.
      if (!review) { const saved = await kv.get<Code>('codes', email); if (saved) await kv.put('codes', email, { ...saved, hash: '', expiresAt: now().toISOString() }); }
      if (!user) { user = await createUser(email, acceptedTerms); created = true; }
      const token = `aeri_${randomBytes(32).toString('base64url')}`, at = now();
      await kv.put('sessions', sha(token), { key: sha(token), userId: user.id, createdAt: at.toISOString(), lastSeenAt: at.toISOString(), expiresAt: new Date(at.getTime() + SESSION_TTL_MS).toISOString() } satisfies Session);
      return { token, user, created };
    },
    async userForToken(token) {
      if (!/^aeri_[A-Za-z0-9_-]{20,}$/.test(token)) return null;
      const key = sha(token), session = await kv.get<Session>('sessions', key);
      if (!session) return null;
      const at = now().getTime();
      if (Date.parse(session.expiresAt) <= at) { await kv.remove('sessions', key); return null; }
      const user = await kv.get<User>('users', session.userId);
      if (!user) { await kv.remove('sessions', key); return null; }
      // Sessions slide while they are used; written at most hourly.
      if (at - Date.parse(session.lastSeenAt) > 60 * 60_000) await kv.put('sessions', key, { ...session, lastSeenAt: now().toISOString(), expiresAt: new Date(at + SESSION_TTL_MS).toISOString() });
      return user;
    },
    signOut: async token => kv.remove('sessions', sha(token)),
    getUser: id => kv.get<User>('users', id),
    async setMailbox(id, mailbox) {
      const user = await kv.get<User>('users', id);
      if (!user) throw new Error('Account not found');
      if (user.mailbox) await kv.remove('inboxes', user.mailbox.inboxId);
      const next: User = { ...user }; if (mailbox) next.mailbox = mailbox; else delete next.mailbox;
      await kv.put('users', id, next);
      if (mailbox) await kv.put('inboxes', mailbox.inboxId, id);
      return next;
    },
    userForInbox: async inboxId => { const id = await kv.get<string>('inboxes', inboxId); return id ? kv.get<User>('users', id) : null; },
    listUsers: () => kv.list<User>('users'),
    async deleteUser(id) {
      const user = await kv.get<User>('users', id);
      if (!user) return;
      for (const session of await kv.list<Session>('sessions')) if (session.userId === id) await kv.remove('sessions', session.key);
      if (user.mailbox) await kv.remove('inboxes', user.mailbox.inboxId);
      await kv.remove('emails', user.email);
      await kv.remove('codes', user.email);
      await kv.remove('users', id);
    },
    close: () => kv.close(),
  };
}
