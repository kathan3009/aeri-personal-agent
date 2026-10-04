import { config } from 'dotenv';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createStore } from './store.js';

config({ path: resolve(import.meta.dirname, '../../../.env') });
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
if (!process.env.APP_ACCESS_TOKEN) {
  console.error('Set APP_ACCESS_TOKEN in .env before starting the API.');
  process.exit(1);
}
const store = createStore();
const app = createApp(store);
await app.service.recoverInterrupted();
serve({ fetch: app.fetch, port, hostname: host }, info => {
  console.log(`Aeri API ready at http://${host}:${info.port}`);
});
