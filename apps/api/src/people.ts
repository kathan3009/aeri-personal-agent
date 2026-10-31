import type { Accounts, User } from './accounts.js';
import { runAs } from './context.js';
import { AgentService } from './service.js';
import { createStore, sharedSql, type Store } from './store.js';

/** One person's Aeri: their account, their own data store and their own agent. */
export type Person = { user: User; store: Store; service: AgentService };
/** Hono request variables set by the sign-in middleware. */
export type AppEnv = { Variables: { person: Person } };

export type People = {
  forUser(user: User): Person;
  all(): Promise<Person[]>;
  /** Drops a person's cached store and agent (after account deletion). */
  forget(userId: string): Promise<void>;
};

/**
 * Keeps each person's store and agent in memory while the server runs. With Postgres, every person shares one small
 * connection pool and their rows are kept apart by scope; locally, each person has their own folder.
 */
export function createPeople(accounts: Accounts, options: { databaseUrl?: string; dataDir?: string; storeFor?: (user: User) => Store } = {}): People {
  const cache = new Map<string, { store: Store; service: AgentService; user: User }>();
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const make = (user: User) => options.storeFor?.(user) ?? createStore(databaseUrl, options.dataDir, { scope: user.id, ...(databaseUrl ? { sql: sharedSql(databaseUrl) } : {}) });
  const forUser = (user: User): Person => {
    let entry = cache.get(user.id);
    if (!entry) {
      const store = make(user);
      // The agent reads the person's latest account details (like their email inbox) when it needs them.
      const holder = { user };
      entry = { store, user, service: new AgentService(store, { userId: user.id, inboxId: () => holder.user.mailbox?.inboxId }) };
      Object.defineProperty(entry, 'user', { get: () => holder.user, set: (next: User) => { holder.user = next; }, enumerable: true });
      cache.set(user.id, entry);
    }
    entry.user = user;
    return entry;
  };
  return {
    forUser,
    all: async () => (await accounts.listUsers()).map(forUser),
    forget: async userId => { const entry = cache.get(userId); cache.delete(userId); if (entry) { await entry.service.idle(); await entry.store.close(); } },
  };
}

/** Runs work for every person, each with their own usage context. */
export async function forEveryone(people: People, work: (person: Person) => Promise<unknown>) {
  for (const person of await people.all()) await runAs(person.user.id, () => work(person)).catch(error => console.warn(`[people] ${person.user.id.slice(0, 8)}: ${(error as Error).message}`));
}
