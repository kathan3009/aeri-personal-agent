import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
import { appStateSchema, emptyState, type AppState } from '@personal-agent/core';
import { z } from 'zod';
import { defaultRetention, entityKeys, entityRows, relatedRows, retainState, stateFromRows, type EntityKey, type EntityRow, type RetentionLimits } from './persistence.js';

export type LiveView = { sessionId: string; url: string; expiresAt: string };
export type MerchantConnection = { merchant: string; connectionId: string; profileId?: string; createdAt: string };
export interface Store {
  read(): Promise<AppState>;
  update<T>(change: (state: AppState) => T | Promise<T>): Promise<T>;
  setLiveView(cartId: string, value: Omit<LiveView, 'expiresAt'>, ttlMs?: number): Promise<void>;
  getLiveView(cartId: string): Promise<LiveView | null>;
  deleteLiveView(cartId: string): Promise<void>;
  setMerchantConnection(connection: MerchantConnection): Promise<void>;
  getMerchantConnection(merchant: string): Promise<MerchantConnection | null>;
  deleteMerchantConnection(merchant: string): Promise<void>;
  claimReceipt(eventId: string): Promise<boolean>;
  close(): Promise<void>;
}

type Sql = postgres.Sql | postgres.TransactionSql;
type StoreOptions = { retention?: RetentionLimits; now?: () => Date };
const scope = 'default';
const tableNames: Record<EntityKey, string> = { inventory: 'aeri_inventory', recipes: 'aeri_recipes', carts: 'aeri_carts', scans: 'aeri_scans', messages: 'aeri_messages', tasks: 'aeri_tasks', events: 'aeri_events', photoSearches: 'aeri_photo_searches', proposals: 'aeri_proposals' };
const projectionNames = ['offers', 'approvals', 'cart_approvals', 'orders', 'inventory_events'] as const;
const liveSchema = z.object({ sessionId: z.string().min(1), url: z.string().url().refine(url => new URL(url).protocol === 'https:'), expiresAt: z.iso.datetime() });
const connectionSchema = z.object({ merchant: z.string().min(1), connectionId: z.string().min(1), profileId: z.string().optional(), createdAt: z.iso.datetime() });
const privateSchema = z.object({ liveViews: z.record(z.string(), liveSchema).default({}), merchantConnections: z.record(z.string(), connectionSchema).default({}), receiptClaims: z.record(z.string(), z.iso.datetime()).default({}) });
const receiptRetentionMs = 90 * 24 * 60 * 60_000;
const maxReceiptClaims = 10_000;

/** No configured database uses atomic local files. Database failures fail closed rather than silently forking data. */
export function createStore(databaseUrl = process.env.DATABASE_URL, dataDir = process.env.DATA_DIR ?? '.data', options: StoreOptions = {}): Store {
  const sql = databaseUrl ? postgres(databaseUrl, { max: 1, ssl: 'require' }) : null;
  const file = resolve(import.meta.dirname, '../../../', dataDir, 'state.json');
  const privateFile = resolve(dirname(file), 'private-sessions.json');
  const now = options.now ?? (() => new Date());
  const limits = options.retention ?? defaultRetention;
  let queue: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> | undefined;
  const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = queue.then(action); queue = next.catch(() => undefined); return next;
  };
  const atomicWrite = async (path: string, body: unknown) => { const temp = `${path}.tmp`; await writeFile(temp, JSON.stringify(body), { mode: 0o600 }); await rename(temp, path); };
  const readLocal = async (path: string): Promise<unknown | null> => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  };
  const syncRows = async (db: Sql, table: string, rows: EntityRow[], prior: EntityRow[] = [], immutable = false) => {
    const ids = rows.map(row => row.id);
    if (ids.length) await db`delete from ${db(table)} where scope = ${scope} and id not in ${db(ids)}`;
    else await db`delete from ${db(table)} where scope = ${scope}`;
    const previous = new Map(prior.map(row => [row.id, row]));
    for (const row of rows) {
      const old = previous.get(row.id);
      if (old?.position === row.position && JSON.stringify(old.body) === JSON.stringify(row.body)) continue;
      if (immutable) await db`insert into ${db(table)} (scope, id, position, body) values (${scope}, ${row.id}, ${row.position}, ${JSON.stringify(row.body)}::jsonb) on conflict (scope, id) do nothing`;
      else await db`insert into ${db(table)} (scope, id, position, body) values (${scope}, ${row.id}, ${row.position}, ${JSON.stringify(row.body)}::jsonb) on conflict (scope, id) do update set position = excluded.position, body = excluded.body, updated_at = now()`;
    }
  };
  const saveDb = async (db: Sql, state: AppState, prior?: AppState) => {
    for (const key of entityKeys) await syncRows(db, tableNames[key], entityRows(state, key), prior ? entityRows(prior, key) : []);
    const related = relatedRows(state), previous = prior ? relatedRows(prior) : undefined;
    for (const key of projectionNames) await syncRows(db, `aeri_${key}`, related[key], previous?.[key], key === 'cart_approvals');
    const keys = Object.keys(state.preferences);
    if (keys.length) await db`delete from aeri_preferences where scope = ${scope} and key not in ${db(keys)}`;
    else await db`delete from aeri_preferences where scope = ${scope}`;
    for (const [key, value] of Object.entries(state.preferences)) if (!prior || prior.preferences[key] !== value) await db`insert into aeri_preferences (scope, key, value) values (${scope}, ${key}, ${value}) on conflict (scope, key) do update set value = excluded.value`;
  };
  const setup = () => ready ??= (async () => {
    if (!sql) { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); return; }
    await sql.begin(async db => {
      // Serializes migration and read-modify-write across API processes.
      await db`select pg_advisory_xact_lock(1968421)`;
      await db`create table if not exists aeri_schema (scope text primary key, version integer not null, migrated_at timestamptz not null default now())`;
      for (const table of [...Object.values(tableNames), ...projectionNames.map(key => `aeri_${key}`)]) await db`create table if not exists ${db(table)} (scope text not null, id text not null, position integer not null, body jsonb not null, updated_at timestamptz not null default now(), primary key (scope, id))`;
      await db`create table if not exists aeri_preferences (scope text not null, key text not null, value text not null, primary key (scope, key))`;
      await db`create table if not exists aeri_live_views (scope text not null, cart_id text not null, session_id text not null, url text not null, expires_at timestamptz not null, primary key (scope, cart_id))`;
      await db`create index if not exists aeri_live_views_expiry on aeri_live_views (expires_at)`;
      await db`create table if not exists aeri_merchant_connections (scope text not null, merchant text not null, body jsonb not null, primary key (scope, merchant))`;
      await db`create table if not exists aeri_receipt_claims (scope text not null, event_id text not null, claimed_at timestamptz not null, primary key (scope, event_id))`;
      const migrated = await db`select version from aeri_schema where scope = ${scope}`;
      if (!migrated.length) {
        const legacyExists = await db`select to_regclass('public.agent_state') as name`;
        const legacy = legacyExists[0]?.name ? await db`select body from agent_state where id = ${scope}` : [];
        // Preserve original state for rollback; later writes only update entity tables.
        await saveDb(db, retainState(legacy.length ? appStateSchema.parse(legacy[0].body) : emptyState(), limits));
        await db`insert into aeri_schema (scope, version) values (${scope}, 1)`;
      }
      await db`delete from aeri_live_views where expires_at <= ${now().toISOString()}`;
    });
  })().catch(error => { ready = undefined; throw error; });
  const loadDb = async (db: Sql): Promise<AppState> => {
    const entities: Partial<Record<EntityKey, EntityRow[]>> = {};
    for (const key of entityKeys) entities[key] = await db<EntityRow[]>`select id, position, body from ${db(tableNames[key])} where scope = ${scope} order by position`;
    const preferences = await db`select key, value from aeri_preferences where scope = ${scope}`;
    return stateFromRows(entities, Object.fromEntries(preferences.map(row => [row.key, row.value])));
  };
  const loadPrivate = async () => privateSchema.parse(await readLocal(privateFile) ?? {});
  return {
    read: () => enqueue(async () => { await setup(); return sql ? sql.begin(async db => { await db`select pg_advisory_xact_lock(1968421)`; return loadDb(db); }) : appStateSchema.parse(await readLocal(file) ?? emptyState()); }),
    update: <T>(change: (state: AppState) => T | Promise<T>) => enqueue(async (): Promise<T> => {
      await setup();
      if (sql) return sql.begin(async db => {
        await db`select pg_advisory_xact_lock(1968421)`;
        const prior = await loadDb(db), state = structuredClone(prior);
        const result = await change(state); await saveDb(db, retainState(state, limits), prior); return result;
      }) as Promise<T>;
      const state = appStateSchema.parse(await readLocal(file) ?? emptyState());
      const result = await change(state); await atomicWrite(file, retainState(state, limits)); return result;
    }),
    setLiveView: (cartId, value, ttlMs = 15 * 60_000) => enqueue(async () => {
      if (!cartId || !Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60_000) throw new Error('A valid cart and session TTL of at most 24 hours are required');
      const entry = liveSchema.parse({ ...value, expiresAt: new Date(now().getTime() + ttlMs).toISOString() });
      await setup();
      if (sql) await sql`insert into aeri_live_views (scope, cart_id, session_id, url, expires_at) values (${scope}, ${cartId}, ${entry.sessionId}, ${entry.url}, ${entry.expiresAt}) on conflict (scope, cart_id) do update set session_id = excluded.session_id, url = excluded.url, expires_at = excluded.expires_at`;
      else { const data = await loadPrivate(); for (const [id, view] of Object.entries(data.liveViews)) if (Date.parse(view.expiresAt) <= now().getTime()) delete data.liveViews[id]; data.liveViews[cartId] = entry; await atomicWrite(privateFile, data); }
    }),
    getLiveView: cartId => enqueue(async () => {
      await setup();
      if (sql) {
        await sql`delete from aeri_live_views where scope = ${scope} and expires_at <= ${now().toISOString()}`;
        const rows = await sql`select session_id, url, expires_at from aeri_live_views where scope = ${scope} and cart_id = ${cartId}`;
        return rows.length ? liveSchema.parse({ sessionId: rows[0].session_id, url: rows[0].url, expiresAt: new Date(rows[0].expires_at).toISOString() }) : null;
      }
      const data = await loadPrivate(), entry = data.liveViews[cartId];
      if (!entry) return null;
      if (Date.parse(entry.expiresAt) > now().getTime()) return entry;
      delete data.liveViews[cartId]; await atomicWrite(privateFile, data); return null;
    }),
    deleteLiveView: cartId => enqueue(async () => { await setup(); if (sql) await sql`delete from aeri_live_views where scope = ${scope} and cart_id = ${cartId}`; else { const data = await loadPrivate(); delete data.liveViews[cartId]; await atomicWrite(privateFile, data); } }),
    setMerchantConnection: connection => enqueue(async () => {
      const value = connectionSchema.parse(connection); await setup();
      if (sql) await sql`insert into aeri_merchant_connections (scope, merchant, body) values (${scope}, ${value.merchant}, ${JSON.stringify(value)}::jsonb) on conflict (scope, merchant) do update set body = excluded.body`;
      else { const data = await loadPrivate(); data.merchantConnections[value.merchant] = value; await atomicWrite(privateFile, data); }
    }),
    getMerchantConnection: merchant => enqueue(async () => { await setup(); if (sql) { const rows = await sql`select body from aeri_merchant_connections where scope = ${scope} and merchant = ${merchant}`; return rows.length ? connectionSchema.parse(rows[0].body) : null; } return (await loadPrivate()).merchantConnections[merchant] ?? null; }),
    deleteMerchantConnection: merchant => enqueue(async () => { await setup(); if (sql) await sql`delete from aeri_merchant_connections where scope = ${scope} and merchant = ${merchant}`; else { const data = await loadPrivate(); delete data.merchantConnections[merchant]; await atomicWrite(privateFile, data); } }),
    claimReceipt: eventId => enqueue(async () => {
      if (!eventId || eventId.length > 256) throw new Error('A valid receipt event identifier is required');
      await setup(); const cutoff = new Date(now().getTime() - receiptRetentionMs).toISOString();
      if (sql) return sql.begin(async db => {
        await db`select pg_advisory_xact_lock(1968421)`;
        await db`delete from aeri_receipt_claims where scope = ${scope} and claimed_at <= ${cutoff}`;
        if ((await db`select event_id from aeri_receipt_claims where scope = ${scope} and event_id = ${eventId}`).length) return false;
        const counts = await db`select count(*)::int as count from aeri_receipt_claims where scope = ${scope}`;
        if (counts[0].count >= maxReceiptClaims) throw new Error('Receipt deduplication capacity reached; processing paused');
        await db`insert into aeri_receipt_claims (scope, event_id, claimed_at) values (${scope}, ${eventId}, ${now().toISOString()})`;
        return true;
      });
      const data = await loadPrivate();
      for (const [id, date] of Object.entries(data.receiptClaims)) if (date <= cutoff) delete data.receiptClaims[id];
      if (Object.hasOwn(data.receiptClaims, eventId)) return false;
      if (Object.keys(data.receiptClaims).length >= maxReceiptClaims) throw new Error('Receipt deduplication capacity reached; processing paused');
      Object.defineProperty(data.receiptClaims, eventId, { value: now().toISOString(), enumerable: true, writable: true, configurable: true });
      await atomicWrite(privateFile, data); return true;
    }),
    close: async () => { await queue; if (sql) await sql.end(); },
  };
}
