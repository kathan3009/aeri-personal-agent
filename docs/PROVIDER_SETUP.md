# Provider activation and verification

All secrets belong in the ignored root `.env` or a server secret manager. The phone needs only the public API origin; people sign in with an emailed code. Restart the API after configuration changes. No secret belongs in `EXPO_PUBLIC_*`, screenshots, prompts, logs or tracked files.

## Current configuration — October 4, 2026

Neon Gateway, Exa and Kernel are configured locally. Direct Gemini and AgentMail webhook credentials remain absent. For Expo Go, run with `DATABASE_URL=` so the configured Neon URL cannot activate card-backed compute. No Fly deployment or live Postgres migration has occurred.

## Neon AI Gateway — active

The branch-scoped credential created with the owner’s consent permits `ai_gateway:invoke` only. It lives solely in ignored `.env`. Configure a bare `NEON_AI_GATEWAY_BASE_URL` without `/v1`; Mastra uses `/v1/chat/completions` with `NEON_AI_GATEWAY_MODEL=gpt-5-4-mini`.

The native Gemini route is `POST $BASE/gemini/v1beta/models/<model>:generateContent`, authenticated by the Neon bearer credential. `NEON_AI_GATEWAY_VISION_MODEL=gemini-3-6-flash` is configured. This is model access through a Neon credential, not a separate Google Gemini API key.

Live verification on October 4:

- HTTP 200 for a generated 3-second inline MP4 at 2 fps, a synthetic PNG and a short public YouTube input.
- The actual Google SDK/native route returned a valid household-map schema with zero household objects for the synthetic pattern, and a photo specification describing the pattern.
- Generated spoken M4A transcribed exactly as “I have six eggs in the fridge.” The authenticated voice route then saved the six eggs.
- Mastra’s live tool loop saved a brand preference and created a requested milk-and-shirts shopping draft.
- The Gateway Files route returned 404. No Files API fallback is used through Gateway.

Local `NEON_AI_GATEWAY_VIDEO_VERIFIED=1` and `NEON_AI_GATEWAY_AUDIO_VERIFIED=1` enable the verified paths. Flags are deployment-specific and should stay zero in a new environment until probes pass. `npm run probe:gateway-video` uses synthetic media; it consumes prepaid Gateway credit but never shops or purchases.

Phone video is inline at 2 fps after ffmpeg compression when necessary. The app’s default raw inline ceiling is 3 MB; base64 expands the request. This is a conservative app setting, not a measured maximum provider allowance. Short clips may still fail or need to be shortened. Real shelf/gallery/recipe/photo recognition accuracy remains to verify on Expo Go.

Gateway credits are prepaid and official documentation says automatic top-ups are unavailable. No manual purchase/top-up was made. The app persists a daily UTC request ledger under `DATA_DIR/gateway-quota.json`: default 50 requests, configured maximum 100; agent runs reserve their maximum six calls before generation. Model output caps also apply. This ledger is a local request bound, **not a monetary billing cap**. Do not add credits automatically. Neon’s main-compute $1 email alert is not a hard cap.

## Direct Gemini — optional, unconfigured

`GEMINI_API_KEY` is missing and is not needed for the current Gateway path. If explicitly activated later, it takes precedence and bills the separate Google account. Verify model availability on that account and obtain an approved Google budget before use. The adapter’s video/audio model variables are `GEMINI_VIDEO_MODEL` and `GEMINI_AUDIO_MODEL`; direct Gemini can use the Files API and deletes uploaded files afterward. Gateway cannot use that Files path.

## Exa — configured

`EXA_API_KEY` enables retailer-constrained product candidate discovery. Search results and highlights are discovery evidence; snippets never become verified prices or stock. Prefer product-path pages and keep applied brand/type/size constraints. The earlier account audit found a Free account without a card. Recheck current credit before substantial live runs.

## Kernel — configured; new account flows need user rehearsal

`KERNEL_API_KEY` is scoped to the hackathon organization/Default project. `KERNEL_RETAILER_URL` is only the fallback store when an approved list has no chosen merchant.

Product checks use stealth, headful browsers because Target headless checks crashed previously. They read merchant JSON-LD and explicit visible price/stock/store evidence. Temporary verification browsers are deleted. Bot checks and missing products remain unverified.

New retailer modules:

- `merchant-store.ts`: Target ZIP picker attempts selection and requires visible confirmation. Other retailers return unsupported; the user selects location in live view. No proxy-IP location is represented as the user’s location. Target selectors are mock-tested, not live confirmed.
- `merchant-auth.ts` / `retailer-api.ts`: explicit **Connect** starts/reuses a scoped Managed Auth hosted login opened in the mobile in-app browser. Passwords/MFA are never sent to the LLM. Only opaque connection IDs persist privately. The app allows three saved connections; provider limits remain authoritative. Credential saving, scheduled health checks, automatic reauthentication and telemetry are disabled. Reconnect is manual when needed.
- Cart preparation reuses the authenticated profile/proxy server-side. Quantity controls must accept the approved number of packs. Unsupported multi-pack controls remain uncertain instead of silently adding one. A line counts as added only after a new explicit addition confirmation; final cart verification is still required.
- Disconnect closes matching sessions, clears private live views, invalidates final approval, and deletes the scoped connection/profile. Retryable failures retain the private record for cleanup.
- `merchant-summary.ts`: reads only the existing current cart/checkout page. It never clicks or navigates to checkout. Missing charges/quantity/location/fulfillment stay unknown. Complete summaries require every charge, matching arithmetic and explicit checkout context; actual retailer selectors still need rehearsal.

The general browser tool can fill only exact Search/Search products fields and click only exact Add/Add to cart/Add to bag buttons. It cannot submit real checkout/payment. Its self-reported additions remain uncertain until exact cart evidence is checked. Split baskets are comparison-only; choose a single-store option for checkout.

## Persistence — built, live Neon activation gated

Local state uses private atomic files and bounded history. `DATABASE_URL` enables versioned relational entities/projections, private sessions, merchant connection IDs, receipt claims and legacy `agent_state` migration. Those paths have deterministic tests; no live Postgres migration was run in this phase. Raw video never enters the database. Live-view URLs are private server metadata with a 15-minute TTL, outside bootstrap state.

The main Neon account has a card attached. Start Expo verification with:

```bash
HOST=0.0.0.0 DATABASE_URL= DATA_DIR=.data-preview/expo npm run dev:api
```

## AgentMail — activation pending

Receipt matching now checks merchant, order number and relevant items, deduplicates signed events, and creates a user-review task. Email claims never mark an order received or change pantry inventory automatically. The owner confirms actual delivered packs; missing or substituted lines are handled explicitly.

`AGENTMAIL_WEBHOOK_SECRET` and a public HTTPS `POST /webhooks/agentmail` endpoint remain pending. Do not configure a paid continuation or imply the webhook is live. Safe hosting must be settled first.

## Fly and VideoMemory

Dockerfile includes ffmpeg; Fly is undeployed. Posted credit and idle-stop settings do not guarantee the attached card cannot be charged. Keep deployment gated until a real control satisfies the owner’s no-card-charge requirement.

Kathan’s `/Users/kathan/Desktop/videomemory` remains optional and unintegrated. It provides ingest, transcripts and query-relevant frames/timestamps; a vision model still performs structured household/product perception. Current confirmed observations and ffmpeg frames support recall without its extra Python/model runtime. Revisit cross-video retrieval after real-phone video usefulness is proven.

Large phone photos over3MB are resized to a1600px JPEG when ffmpeg can decode them, before Gateway perception. A failed conversion stays an explicit error; nothing is silently replaced by a sample.
