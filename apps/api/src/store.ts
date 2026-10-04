import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
import { appStateSchema, emptyState, type AppState } from '@personal-agent/core';

export interface Store { read(): Promise<AppState>; update<T>(change: (state: AppState) => T | Promise<T>): Promise<T>; close(): Promise<void> }

export function createStore(databaseUrl = process.env.DATABASE_URL, dataDir = process.env.DATA_DIR ?? '.data'): Store {
  const sql = databaseUrl ? postgres(databaseUrl, { max: 1, ssl: 'require' }) : null;
  const file = resolve(import.meta.dirname, '../../../', dataDir, 'state.json');
  let queue: Promise<unknown> = Promise.resolve();
  let ready: Promise<void> | undefined;
  const setup = () => ready ??= (async () => {
    if (sql) await sql`create table if not exists agent_state (id text primary key, body jsonb not null, updated_at timestamptz not null default now())`;
    else await mkdir(dirname(file), { recursive: true });
  })();
  const load = async (): Promise<AppState> => {
    await setup();
    if (sql) {
      const rows = await sql`select body from agent_state where id = 'default'`;
      return rows.length ? appStateSchema.parse(rows[0].body) : emptyState();
    }
    try { return appStateSchema.parse(JSON.parse(await readFile(file, 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
  };
  const save = async (state: AppState): Promise<void> => {
    const body = JSON.stringify(appStateSchema.parse(state));
    if (sql) await sql`insert into agent_state (id, body) values ('default', ${body}::jsonb) on conflict (id) do update set body = excluded.body, updated_at = now()`;
    else { const temp = `${file}.tmp`; await writeFile(temp, body); await rename(temp, file); }
  };
  return {
    read: () => queue.then(load),
    update: <T>(change: (state: AppState) => T | Promise<T>): Promise<T> => {
      const action = queue.then(async () => { const state = await load(); const result = await change(state); await save(state); return result; });
      queue = action.catch(() => undefined);
      return action;
    },
    close: async () => { await queue; if (sql) await sql.end(); },
  };
}
