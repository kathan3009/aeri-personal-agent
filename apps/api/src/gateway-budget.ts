import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

let queue: Promise<unknown> = Promise.resolve();
/** Local persisted request quota, including possible tool steps. This is not a provider billing cap. */
export function reserveGatewayRequests(count = 1): Promise<void> {
  const next = queue.then(async () => {
    const configured = Number(process.env.NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT ?? 50);
    const limit = Number.isInteger(configured) ? Math.max(0, Math.min(100, configured)) : 0;
    const file = resolve(import.meta.dirname, '../../../', process.env.DATA_DIR ?? '.data', 'gateway-quota.json');
    const day = new Date().toISOString().slice(0, 10);
    let used = 0;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); if (saved.day === day) { if (!Number.isInteger(saved.used) || saved.used < 0) throw new Error('Invalid Gateway quota ledger'); used = saved.used; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!Number.isInteger(count) || count < 1 || used + count > limit) throw new Error('Gateway daily request limit reached. Try tomorrow or use text memory commands.');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ day, used: used + count }), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  });
  queue = next.catch(() => undefined);
  return next;
}
