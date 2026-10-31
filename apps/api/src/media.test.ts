import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compressImageForModel, hasFfmpeg, withTempFile } from './media.js';

const run = promisify(execFile);
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'aeri-photo-compress-')); vi.stubEnv('DATA_DIR', directory); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

/** Synthetic RGB pattern, generated in memory. No personal photos or binary fixtures are saved. */
function largeBmp(width = 2000, height = 2000): Uint8Array {
  const stride = Math.ceil(width * 3 / 4) * 4, pixels = stride * height;
  const data = Buffer.alloc(54 + pixels);
  data.write('BM'); data.writeUInt32LE(data.length, 2); data.writeUInt32LE(54, 10); data.writeUInt32LE(40, 14);
  data.writeInt32LE(width, 18); data.writeInt32LE(height, 22); data.writeUInt16LE(1, 26); data.writeUInt16LE(24, 28); data.writeUInt32LE(pixels, 34);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = 54 + y * stride + x * 3;
    data[offset] = x % 256; data[offset + 1] = y % 256; data[offset + 2] = (x + y) % 256;
  }
  return data;
}

describe('phone photo model compression', () => {
  it('compresses a valid >3 MB 2000×2000 RGB image into a small JPEG with at most 1600px dimensions', async () => {
    expect(await hasFfmpeg()).toBe(true);
    const input = largeBmp(); expect(input.byteLength).toBeGreaterThan(3_000_000);
    const output = await compressImageForModel(input);
    expect(output).not.toBeNull(); expect(output!.byteLength).toBeLessThanOrEqual(3_000_000);
    expect(Array.from(output!.slice(0, 2))).toEqual([0xff, 0xd8]);
    const dimensions = await withTempFile(output!, 'jpg', async path => {
      const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', path]);
      return JSON.parse(stdout).streams[0] as { width: number; height: number; codec_name: string };
    });
    expect(dimensions.codec_name).toBe('mjpeg'); expect(dimensions.width).toBeLessThanOrEqual(1600); expect(dimensions.height).toBeLessThanOrEqual(1600);
    expect(dimensions.width).toBe(1600); expect(dimensions.height).toBe(1600);
    expect(await readdir(join(directory, 'tmp'))).toEqual([]);
  });
  it('returns null for invalid image bytes and removes its temporary upload on failure', async () => {
    expect(await compressImageForModel(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(await readdir(join(directory, 'tmp'))).toEqual([]);
  });
});
