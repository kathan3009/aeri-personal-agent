# Provider activation checklist

All secrets go in the root `.env` (ignored by Git) or a deployment secret manager. Run `npm run setup:local` once; it keeps existing files. The phone needs only the API address and the private access code. Restart `npm run dev:api` after changing `.env`. Settings (the person icon) lists which capabilities are live and which use labeled samples.

## 1. Gemini (primary video, photo and voice perception)

Set `GEMINI_API_KEY`. The defaults are `GEMINI_VIDEO_MODEL=gemini-3.8-flash` and `GEMINI_AUDIO_MODEL=gemini-3.5-transcribe`; both are listed as stable on Google's models page as of October 4. Direct Gemini bills to its own Google account and does not use Neon credit, so set a budget in Google AI Studio first.

How Aeri calls it (`apps/api/src/perception.ts`):
- **Phone clips:** `models.generateContent` with the video sent inline at 2 frames a second. Clips over 18 MB are first re-encoded with ffmpeg to 480p and 2 fps with mono speech (a 40 s 1080p clip becomes under 1 MB). Without ffmpeg, the Files API is used.
- **YouTube links:** passed as `fileData.fileUri`.
- **Photos:** sent inline.
- **Uploads:** any uploaded file is deleted afterwards.

**First live test:**
1. Record a 20–40 second clip of one shelf in good light, saying aloud anything hard to see.
2. Check that every item has a timestamp, that the evidence frames match, that nothing hidden was listed, and that unclear labels ask for a close-up.
3. Then try one gallery MP4 and one public YouTube recipe.

## 2. Neon AI Gateway

**Conversation.** Set `NEON_AI_GATEWAY_API_KEY` (or `NEON_AI_GATEWAY_TOKEN`, the name Neon injects) and the bare `NEON_AI_GATEWAY_BASE_URL` (no `/v1`). Keep `NEON_AI_GATEWAY_MODEL=gpt-5-mini` unless your Gateway's `GET /v1/models` lists something else. Mastra uses the OpenAI-compatible `/v1/chat/completions` route. Test one open question in the app.

**Video and photos on Gateway credit: not yet verified.**
- **What Neon documents:** a native Gemini route, `POST $BASE/gemini/v1beta/models/<model>:generateContent`. Only `generateContent` and `streamGenerateContent` are supported, so the Files API is not.
- **What is inferred, not tested:** inline video and YouTube URLs probably work. The backing Databricks Gateway documents a 4 MB request limit, which is why Aeri re-encodes clips first.

To test it:
1. Set `NEON_AI_GATEWAY_VISION_MODEL` to a Gemini ID listed by your Gateway (hyphenated, for example `gemini-3-6-flash`).
2. Run `npm run probe:gateway-video`. It sends one 3-second generated clip inline and one short public YouTube URL, checks the Files route, and prints only HTTP statuses and short answers.
3. Only if the inline test passes, set `NEON_AI_GATEWAY_VIDEO_VERIFIED=1`.

Direct Gemini still takes priority when `GEMINI_API_KEY` is set. Voice transcription uses Gemini's Interactions API and stays direct-only.

The $1 Neon spend alert is an email, not a cap. The account has a card attached, so watch Gateway usage while testing.

## 3. Exa (candidate products)

Set `EXA_API_KEY` (configured). Aeri calls `/search` with `type: auto`, `userLocation: US`, `includeDomains` limited to your favorite stores (or Walmart, Target, Amazon), and highlights. Search results are candidates only; no price or stock comes from a snippet. Read `costDollars` on the dashboard; the free tier has no card.

## 4. Kernel (store-page checks, cart preparation, live review)

Set `KERNEL_API_KEY` (configured). `KERNEL_RETAILER_URL` is the store opened when a list has no chosen store.

- **Verification:** reads the retailer's own page in a stealth, headful browser. Headless renderers crashed on Target during testing. It reads JSON-LD first, then that retailer's visible price, store and fulfillment elements. Every session is deleted.
- **Store location:** comes from the cloud browser's network location (it was NYC and then South Carolina during testing), not from you. The app labels it that way.
- **Not yet done:** choosing your store requires a per-retailer store picker or a signed-in profile.
- **Cart preparation:** each approved product page gets one add-to-cart click, which counts only when the page confirms it. The browser then lands on the store's cart, and the live view opens in Aeri. It never clicks checkout, pay or place order.
- **Rehearse safely:**
  - `npm run check:retailer -w @personal-agent/api -- "<item>" target.com`
  - `npm run check:cart -w @personal-agent/api -- <product URL>` (guest cart, browser deleted)
  - `npm run check:compare -w @personal-agent/api`
- **Retailer login (planned):** use Kernel Managed Auth (`auth.connections.create` → hosted login in the phone's in-app browser → `profile` on later browsers), storing only opaque IDs. The free plan lists three connections. Passkey-only logins are unsupported.

## 5. Neon Postgres

Set `DATABASE_URL` (configured). The API keeps one JSON state row in `agent_state`; raw video never goes there. Use a dedicated branch for testing. Moving to relational tables for offers, approvals, orders and inventory events is still planned.

## 6. AgentMail

Create a private inbox and a `message.received` webhook pointing to `https://<public API>/webhooks/agentmail`, then set `AGENTMAIL_WEBHOOK_SECRET`. Email content is treated as untrusted evidence for review. This needs a public HTTPS API first.

## 7. Fly.io (not deployed)

The root Dockerfile and `fly.template.toml` are ready. Don't deploy until a control that actually prevents card charges beyond the posted credit has been verified. For video frames, the image must also install ffmpeg.

## VideoMemory (not integrated, by decision)

`/Users/kathan/Desktop/videomemory` works locally, but its cross-video `search` covers speech transcripts only. Visual `look` needs a specific video and returns a frame grid that still needs a vision model. Each CLI call also loads torch models, which adds about 5–20 seconds.

For "where did I last see X?", Aeri answers from confirmed, timestamped observations instead, and shows the ffmpeg frame from the moment it was seen. Revisit VideoMemory for semantic search across a large video library, behind `VIDEOMEMORY_PROJECT_PATH`/`VIDEOMEMORY_DATA_DIR` with its own data directory (never `~/.videomemory`).
