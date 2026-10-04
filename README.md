# Aeri

Aeri is a private personal shopping agent, currently focused on iPhone. Its main demo:
1. You film a fridge, pantry, shelf or closet for 20–40 seconds.
2. Aeri turns the clip into a timestamped map of places and visible items, with an evidence frame for each item.
3. You confirm or correct each item before anything is remembered.
4. Only the confirmed facts change the next shopping list.

It also turns a public YouTube recipe (or a recipe video file) into a missing-items list. It can find a product from a photo, labeling results as exact, likely or similar matches. It compares stores by all-in cost and prepares the chosen store's cart for you to review in the app. Aeri never pays, and never says an order exists without the store's order number.

The repository is a mobile app plus a private API. There is no consumer web app. The conversation UI uses the MIT-licensed native [assistant-ui](https://www.assistant-ui.com/docs/react-native) library.

The design is calm and light sky-blue. Each state has one primary action, and approving a cart is a press-and-hold. The interface uses SF Pro and SF Symbols on iPhone, with native Liquid Glass on iOS 26 and an opaque surface elsewhere. Motion follows the system Reduce Motion setting.

## What works today

| Capability | Status — October 4, 2026 |
| --- | --- |
| Video map, review and memory | Implemented with places, timestamps, ffmpeg evidence frames, uncertainty, corrections, reconciliation and confirmed inventory. Live Gateway structured extraction passed on a synthetic 3-second video; a real fridge/shelf recording still needs iPhone verification. |
| Video sources and recipes | Recorded, gallery/Files, direct video-file links and public YouTube inputs share the pipeline. Small inline MP4 and short YouTube inputs passed live Gateway tests. Unsupported social links ask for a file upload. Actual recipe accuracy and gallery import still need device review. |
| Photo shopping | Camera/import, saved preferences, product constraints and exact/likely/similar labels work. Live Gateway PNG interpretation returned the synthetic test pattern. A real branded photo and retailer variant match remain to verify. |
| Voice and open conversation | Live Gateway transcription and the authenticated voice route transcribed “I have six eggs in the fridge” and saved six eggs. Live Mastra calls saved an Oatly preference and created a milk-and-shirts shopping draft through tools. Phone microphone quality still needs testing. |
| Store comparison | Sample comparisons are labeled. Earlier live Exa/Kernel checks produced Target prices and honest Walmart bot-check results; fees/tax/distance remain unknown where unobserved. Split baskets can be compared, but checkout requires selecting a single-store basket. |
| Retailer accounts and real cart review | Kernel Managed Auth creation/status/disconnect and server-side profile reuse are built with mock tests, limited to three saved connections. The mobile login/live-view opens in the in-app browser. Target ZIP selection and quantity controls are built but not live rehearsed. Unsupported controls remain uncertain. |
| Final checkout boundary | Aeri reads the current merchant checkout without clicking payment. Complete, matching snapshots can receive a short-lived single-use approval; changes invalidate it. Controlled submission exists only against a mock merchant in tests. Every real payment is completed by the user at the retailer. |
| Order, delivery and receipts | The user records the retailer order number and confirms what arrived. Memory receives actual purchased packs, not merely the recipe amount. Signed, deduplicated receipt matching is built and always needs review; public HTTPS/webhook activation remains pending. |
| Persistence and sessions | Relational entity tables, legacy JSON-row migration, bounded history, receipt claims and private 15-minute live-view mappings are implemented. Local persistence is tested; live Postgres migration is gated. VideoMemory remains optional and unintegrated. |

The Gateway branch credential has `ai_gateway:invoke` only. Native `gemini-3-6-flash` video/photo/audio transport and `gpt-5-4-mini` Mastra tools were live-tested; this does not establish real household recognition accuracy. See [BUILD_PLAN.md](BUILD_PLAN.md), [provider setup](docs/PROVIDER_SETUP.md) and [Expo verification](docs/DEMO.md).

## Run locally for Expo Go

Requires Node 22+, npm and ffmpeg for video compression/evidence frames. Keep the existing ignored `.env` and mobile `.env.local` files.

```bash
npm ci
npm run setup:local
HOST=0.0.0.0 DATABASE_URL= DATA_DIR=.data-preview/expo npm run dev:api
```

In another terminal:

```bash
npm run dev:mobile
```

On an iPhone, join the same Wi-Fi and scan the Metro QR code with Camera to open Expo Go. In Aeri Settings, use the computer’s LAN API URL and the private access code from ignored `.env`. `localhost` on the phone refers to the phone. The current running iPhone setup is documented in [LOCAL_RUN](docs/LOCAL_RUN.md). Camera, microphone, Liquid Glass and haptics need device verification.

The `DATABASE_URL=` override is intentional: local Expo work must not start card-backed Neon compute. Fly remains undeployed. Gateway is prepaid with no automatic top-ups; no manual credit purchase was made. The app persists a daily request quota (default 50, maximum 100), bounds tool steps and model output. These are request controls, not a monetary billing cap. Other provider balances are the earlier audit, not a fresh current balance.

With Exa/Kernel configured, **Compare stores** runs live and may be slow or incomplete. **⋯ → Rehearse with sample prices** is the labeled instant alternative. Real media uses the verified Gateway; unavailable providers fall back only where the UI explicitly says **Sample**.

## Configuration

All provider secrets stay in root `.env`; mobile `EXPO_PUBLIC_API_URL` contains only the API origin.

| Provider | Variables | Current use |
| --- | --- | --- |
| Neon AI Gateway | `NEON_AI_GATEWAY_API_KEY` or `_TOKEN`, `_BASE_URL`, `_MODEL`, `_VISION_MODEL`, `_VIDEO_VERIFIED`, `_AUDIO_VERIFIED`, `_DAILY_REQUEST_LIMIT` | Mastra reasoning, inline Gemini video/photo, YouTube and audio transcription; configured locally |
| Direct Gemini | `GEMINI_API_KEY`, `GEMINI_VIDEO_MODEL`, `GEMINI_AUDIO_MODEL` | Optional separate-billing fallback; missing and unnecessary for current Gateway path |
| Exa + Kernel | `EXA_API_KEY`, `KERNEL_API_KEY`, `KERNEL_RETAILER_URL` | Discovery, verification, cart preparation, managed login and live review |
| Neon Postgres | `DATABASE_URL` | Relational hosted persistence once compute spending is safely controlled; overridden empty during local verification |
| AgentMail | `AGENTMAIL_WEBHOOK_SECRET` | Signed receipt evidence after public HTTPS deployment; pending |

Developer retailer scripts consume Exa/Kernel credit, never submit payment, and delete their sessions:

- `npm run check:retailer -w @personal-agent/api -- "<product>" target.com`
- `npm run check:cart -w @personal-agent/api -- <product URL>` adds to a temporary guest cart.
- `npm run check:compare -w @personal-agent/api`

## Project layout and checks

- `apps/mobile`: Expo Router, native assistant-ui conversation, video/map/photo review, Memory, Tasks, voice and retailer connections.
- `apps/api`: perception/media, Mastra workflows, Exa/Kernel merchant adapters, final-summary reader, Managed Auth routes, receipts and persistence.
- `packages/core`: deterministic video/inventory/product/basket/purchase-approval/delivery contracts and tests.

Run `npm run typecheck` and `npm test`. Tests cover media fixtures with real ffmpeg, inventory allocation, purchased-pack delivery, retailer/auth mocks, final totals and single-use approval boundaries. In `apps/mobile`, `npx expo export --platform ios` and `--platform android` validate native bundles.

## Privacy

Every `/v1` call needs the access code stored on the phone in SecureStore. Provider keys stay server-side. Raw video is temporary and deleted after processing; accepted sightings retain small evidence frames. Sensitive Kernel live-view URLs stay in private server storage with a 15-minute TTL and never enter bootstrap state. Sessions close on cancellation, disconnect or order confirmation. Login credentials and payment details remain with Kernel/the retailer; telemetry and credential saving are disabled by default. AgentMail verifies signatures, but email contents are still untrusted. This is a private single-household MVP; a hosted API requires HTTPS and the spending gate.
