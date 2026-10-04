import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dataDir = () => resolve(import.meta.dirname, '../../../', process.env.DATA_DIR ?? '.data');
export const evidenceDir = () => join(dataDir(), 'evidence');

let ffmpeg: Promise<boolean> | undefined;
/** ffmpeg is optional: without it the review shows timestamps but no frames. */
export const hasFfmpeg = () => ffmpeg ??= run('ffmpeg', ['-version'], { timeout: 5000 }).then(() => true, () => false);

/** Writes an upload to a private temp file for ffprobe/ffmpeg. The caller must delete it. */
export async function withTempFile<T>(data: Uint8Array, extension: string, use: (path: string) => Promise<T>): Promise<T> {
  const dir = join(dataDir(), 'tmp');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.${extension.replace(/[^a-z0-9]/gi, '') || 'bin'}`);
  await writeFile(path, data, { mode: 0o600 });
  try { return await use(path); } finally { await rm(path, { force: true }); }
}

export async function probeDuration(path: string): Promise<number | undefined> {
  if (!(await hasFfmpeg())) return undefined;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], { timeout: 10_000 });
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch { return undefined; }
}

/**
 * Saves one small JPEG per requested moment so the person can see exactly what Aeri saw. Only these frames are kept;
 * the clip itself is deleted after processing. Returns frame file names keyed by request key.
 */
export async function extractFrames(path: string, scanId: string, moments: Array<{ key: string; atSec: number }>): Promise<Record<string, string>> {
  if (!moments.length || !(await hasFfmpeg())) return {};
  const dir = join(evidenceDir(), safe(scanId));
  await mkdir(dir, { recursive: true });
  const frames: Record<string, string> = {};
  for (const { key, atSec } of moments.slice(0, 60)) {
    const name = `${safe(key)}.jpg`;
    try {
      await run('ffmpeg', ['-v', 'error', '-y', '-ss', atSec.toFixed(2), '-i', path, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '6', join(dir, name)], { timeout: 15_000 });
      frames[key] = name;
    } catch { /* a frame past the end or an unreadable codec leaves the timestamp only */ }
  }
  return frames;
}

/**
 * Re-encodes a clip small enough to send inline: 480p, 2 frames a second (what the model samples anyway), and mono
 * speech so narration still counts as evidence. A 40-second phone video drops from tens of MB to about 1-3 MB.
 */
export async function compressForModel(path: string): Promise<Uint8Array | null> {
  if (!(await hasFfmpeg())) return null;
  const out = `${path}.model.mp4`;
  try {
    await run('ffmpeg', ['-v', 'error', '-y', '-i', path, '-vf', 'scale=-2:480,fps=2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '32k', '-ac', '1', '-movflags', '+faststart', out], { timeout: 120_000 });
    return new Uint8Array(await readFile(out));
  } catch { return null; } finally { await rm(out, { force: true }); }
}

const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '');
export async function readFrame(scanId: string, name: string): Promise<Uint8Array | null> {
  if (!/^[a-zA-Z0-9_-]+\.jpg$/.test(name)) return null;
  try { return await readFile(join(evidenceDir(), safe(scanId), name)); } catch { return null; }
}
/** Keeps only frames for sightings the person accepted. */
export async function pruneFrames(scanId: string, keep: Set<string>) {
  const dir = join(evidenceDir(), safe(scanId));
  const files = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(files.filter(f => !keep.has(f)).map(f => rm(join(dir, f), { force: true })));
}

const socialHosts = /(^|\.)(instagram\.com|tiktok\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|threads\.net|snapchat\.com|pinterest\.[a-z.]+|pin\.it|reddit\.com|vimeo\.com)$/i;
const youtubeHosts = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i;
export type LinkKind = 'youtube' | 'social' | 'video_file' | 'page';
/** Only YouTube links (Gemini's documented URL input) and direct video files are importable. */
export function classifyLink(value: string): { kind: LinkKind; url: string; host: string } | null {
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.replace(/^www\./, '');
  if (youtubeHosts.test(url.hostname)) return { kind: 'youtube', url: url.toString(), host };
  if (socialHosts.test(url.hostname)) return { kind: 'social', url: url.toString(), host };
  if (/\.(mp4|mov|m4v|webm)$/i.test(url.pathname)) return { kind: 'video_file', url: url.toString(), host };
  return { kind: 'page', url: url.toString(), host };
}

const privateAddress = (ip: string) => /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip) || ip === '::1' || /^f[cd]/i.test(ip) || /^fe80/i.test(ip) || ip.startsWith('::ffff:127.');
/** Downloads a public HTTPS video file with a size cap. Private or local network addresses are refused. */
export async function downloadVideo(url: string, maxBytes = 90_000_000): Promise<{ data: Uint8Array; mimeType: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('Only HTTPS video links can be imported');
  const addresses = isIP(parsed.hostname) ? [{ address: parsed.hostname }] : await lookup(parsed.hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some(a => privateAddress(a.address))) throw new Error('That video link can’t be reached from Aeri');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`The video link returned ${response.status}`);
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const extension = parsed.pathname.split('.').pop()?.toLowerCase();
  const mimeType = type.startsWith('video/') ? type : extension === 'mov' ? 'video/quicktime' : extension === 'webm' ? 'video/webm' : 'video/mp4';
  if (type && !type.startsWith('video/') && type !== 'application/octet-stream') throw new Error('That link is not a video file');
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) throw new Error('That video is larger than 90 MB');
  const chunks: Uint8Array[] = []; let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error('That video is larger than 90 MB');
    chunks.push(chunk);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return { data, mimeType };
}
