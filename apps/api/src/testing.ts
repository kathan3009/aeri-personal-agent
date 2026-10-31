import { createHash } from 'node:crypto';
import type { Hono } from 'hono';
import type { Accounts, Mailbox, User } from './accounts.js';
import { createApp, type AppDeps } from './app.js';
import { createPeople, type AppEnv } from './people.js';
import type { AgentService } from './service.js';
import type { Store } from './store.js';

/** A user for tests, scoped like the owner account (so Kernel profile names match what older tests expect). */
export const testUser = (token = 'test-code', overrides: Partial<User> = {}): User => ({ id: 'default', email: 'person@example.com', createdAt: '2026-10-04T12:00:00.000Z',
  kernelScope: createHash('sha256').update(token).digest('hex').slice(0, 24), ...overrides });

/** Accounts that know one signed-in person by a fixed token. */
export function singlePersonAccounts(user: User, token: string): Accounts {
  let current = user;
  return {
    requestCode: async () => { throw new Error('not used'); }, verifyCode: async () => { throw new Error('not used'); },
    userForToken: async value => value === token ? current : null, signOut: async () => undefined, getUser: async id => id === current.id ? current : null,
    setMailbox: async (_id, mailbox: Mailbox | null) => { current = { ...current }; if (mailbox) current.mailbox = mailbox; else delete current.mailbox; return current; },
    userForInbox: async inboxId => current.mailbox?.inboxId === inboxId ? current : null, listUsers: async () => [current], deleteUser: async () => undefined, close: async () => undefined,
  };
}

/** The API as one signed-in person sees it, backed by the given store. `app.service` is that person's agent. */
export function singlePersonApp(store: Store, token = 'test-code', extra: Partial<AppDeps> = {}): Hono<AppEnv> & { service: AgentService; user: User; accounts: Accounts } {
  const user = testUser(token);
  const accounts = singlePersonAccounts(user, token);
  const people = createPeople(accounts, { storeFor: () => store });
  const app = createApp({ accounts, people, kernel: () => null, ...extra });
  return Object.assign(app, { service: people.forUser(user).service, user, accounts });
}
