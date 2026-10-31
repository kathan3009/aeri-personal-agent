import { config } from 'dotenv';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import Kernel from '@onkernel/sdk';
import { createAccounts } from './accounts.js';
import { createApp } from './app.js';
import { startMailboxPolling } from './mailbox.js';
import { captureError, initMonitoring } from './monitoring.js';
import { createPeople, forEveryone } from './people.js';
import { startAuthWatcher } from './store-auth.js';
import { sharedSql } from './store.js';

config({ path: resolve(import.meta.dirname, '../../../.env') });
initMonitoring();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const production = process.env.NODE_ENV === 'production';
// In production the code hash secret must survive restarts, and sign-in codes must go out by email.
if (production && (!process.env.AERI_SECRET || process.env.AERI_SECRET.length < 32)) {
  console.error('Set AERI_SECRET (at least 32 random characters) before starting Aeri in production.');
  process.exit(1);
}
if (production && !process.env.AGENTMAIL_API_KEY) console.warn('AGENTMAIL_API_KEY is not set: nobody can receive a sign-in code.');

const databaseUrl = process.env.DATABASE_URL || undefined;
const accounts = createAccounts({ sql: databaseUrl ? sharedSql(databaseUrl) : null });
const people = createPeople(accounts, { databaseUrl });
const app = createApp({ accounts, people });

// Work that was running when the server stopped can't finish; mark it for each person.
await forEveryone(people, person => person.service.recoverInterrupted());
// Polling suits a laptop; a hosted server receives the AgentMail webhook instead (AGENTMAIL_POLLING=0).
if (process.env.AGENTMAIL_POLLING !== '0') startMailboxPolling(async () => (await people.all()).flatMap(person => person.user.mailbox ? [{ inboxId: person.user.mailbox.inboxId, store: person.store }] : []));
startAuthWatcher(async () => people.all(), () => process.env.KERNEL_API_KEY ? new Kernel({ apiKey: process.env.KERNEL_API_KEY }) : null);
process.on('unhandledRejection', error => captureError(error, { route: 'unhandled' }));

const server = serve({ fetch: app.fetch, port, hostname: host }, info => {
  console.log(`Aeri API ready at http://${host}:${info.port}`);
});
// Fly stops machines with SIGINT/SIGTERM: finish in-flight background work briefly, then exit.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, async () => {
  server.close();
  await Promise.race([Promise.all((await people.all()).map(person => person.service.idle())), new Promise(done => setTimeout(done, 8_000))]);
  process.exit(0);
});
