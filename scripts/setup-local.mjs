import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const serverFile = resolve(root, '.env');
const mobileFile = resolve(root, 'apps/mobile/.env.local');
const addresses = Object.values(networkInterfaces()).flat().filter(Boolean);
const lan = addresses.find(entry => entry.family === 'IPv4' && !entry.internal && /^(192\.168\.|10\.|172\.)/.test(entry.address))?.address;
if (!existsSync(serverFile)) {
  const code = randomBytes(24).toString('base64url');
  writeFileSync(serverFile, `PORT=8787\nHOST=0.0.0.0\nAPP_ACCESS_TOKEN=${code}\nDATA_DIR=.data\n`, { mode: 0o600 });
  console.log('Created private .env with a new access code. Open that file to enter the code in the app.');
} else console.log('Existing .env preserved.');
if (!existsSync(mobileFile)) {
  const url = `http://${lan ?? 'localhost'}:8787`;
  writeFileSync(mobileFile, `EXPO_PUBLIC_API_URL=${url}\n`);
  console.log(`Mobile default API address: ${url}`);
} else console.log('Existing mobile .env.local preserved.');
console.log('Run npm run dev:api and npm run dev:mobile in separate terminals.');
