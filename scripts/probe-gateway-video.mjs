// Checks whether the Neon AI Gateway's native Gemini route accepts Aeri's video input, without printing secrets.
// It sends a 3-second generated clip inline, then a short public YouTube URL, then checks whether the Files API is
// proxied. Each call is one small Gemini request billed to Gateway credit. Run: npm run probe:gateway-video
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';

config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });
const key = process.env.NEON_AI_GATEWAY_API_KEY || process.env.NEON_AI_GATEWAY_TOKEN;
const base = (process.env.NEON_AI_GATEWAY_BASE_URL || '').replace(/\/$/, '');
const model = process.env.NEON_AI_GATEWAY_VISION_MODEL;
const youtube = process.argv[2] || process.env.PROBE_YOUTUBE_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
if (!key || !base || !model) {
  console.error('Set NEON_AI_GATEWAY_API_KEY (or NEON_AI_GATEWAY_TOKEN), NEON_AI_GATEWAY_BASE_URL and NEON_AI_GATEWAY_VISION_MODEL (a Gemini model listed on your Gateway, e.g. from GET $BASE/v1/models) in .env first.');
  process.exit(2);
}
const hide = text => String(text).split(key).join('[hidden]').replace(/\s+/g, ' ').slice(0, 160);
const dir = mkdtempSync(join(tmpdir(), 'aeri-probe-'));
const clip = join(dir, 'probe.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10', '-pix_fmt', 'yuv420p', clip]);
const url = `${base}/gemini/v1beta/models/${encodeURIComponent(model)}:generateContent`;
const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
async function call(name, parts) {
  const started = Date.now();
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { maxOutputTokens: 512, temperature: 0.1 } }), signal: AbortSignal.timeout(120_000) });
    const body = await response.text();
    let text = body;
    try { text = JSON.parse(body).candidates?.[0]?.content?.parts?.map(p => p.text).join(' ') ?? body; } catch {}
    console.log(`${response.ok ? 'PASS' : 'FAIL'}  ${name}: HTTP ${response.status} in ${Date.now() - started} ms — ${hide(text)}`);
    return response.ok;
  } catch (error) { console.log(`FAIL  ${name}: ${hide(error.message)}`); return false; }
}
const inline = await call('inline MP4 video (fps 2)', [{ inlineData: { mimeType: 'video/mp4', data: readFileSync(clip).toString('base64') }, videoMetadata: { fps: 2 } }, { text: 'Describe this 3-second clip in one sentence and give one timestamp as M:SS.' }]);
const image = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-']);
await call('inline PNG image', [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') } }, { text: 'Describe this image in one sentence.' }]);
const wav = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'wav', '-']);
await call('inline WAV audio', [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }, { text: 'Transcribe speech only. If no words are spoken return NO_SPEECH.' }]);
const yt = await call('public YouTube URL', [{ fileData: { mimeType: 'video/mp4', fileUri: youtube } }, { text: 'Summarize this video in one sentence.' }]);
const files = await fetch(`${base}/gemini/v1beta/files`, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.status).catch(() => 'error');
console.log(`INFO  Files API through the Gateway: HTTP ${files} (Aeri does not need it; clips are re-encoded to send inline)`);
rmSync(dir, { recursive: true, force: true });
console.log(inline
  ? `\nInline video works. To let Aeri use Gateway credit for video and photos, add NEON_AI_GATEWAY_VIDEO_VERIFIED=1 to .env and restart the API.${yt ? ' YouTube links also work.' : ' YouTube links did not; recipe links still need GEMINI_API_KEY.'}`
  : '\nInline video did not work through the Gateway. Keep using GEMINI_API_KEY for video.');
process.exit(inline ? 0 : 1);
