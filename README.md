# Aeri

Aeri is a private, iOS-first personal shopping agent (Android is supported). Its main demo:
1. You film a fridge, pantry, shelf or closet for 20–40 seconds.
2. Aeri turns the clip into a timestamped map of places and visible items, with an evidence frame for each item.
3. You confirm or correct each item before anything is remembered.
4. Only the confirmed facts change the next shopping list.

It also turns a public YouTube recipe (or a recipe video file) into a missing-items list. It can find a product from a photo, labeling results as exact, likely or similar matches. It compares stores by all-in cost and prepares the chosen store's cart for you to review in the app. Aeri never pays, and never says an order exists without the store's order number.

The repository is a mobile app plus a private API. There is no consumer web app. The conversation UI uses the MIT-licensed native [assistant-ui](https://www.assistant-ui.com/docs/react-native) library.

The design is calm and light sky-blue. Each state has one primary action, and approving a cart is a press-and-hold. The interface uses SF Pro and SF Symbols on iPhone, with native Liquid Glass on iOS 26 and an opaque surface elsewhere. Motion follows the system Reduce Motion setting.

## What works today

| Capability | Status (October 4, 2026) |
| --- | --- |
| Video map → review → memory | **Works with labeled samples.** The flow covers record, library and Files upload, places, timestamps, evidence type, close-up requests, corrections and required counts. It also shows "not seen this time", confirms into memory grouped by place, and answers "where is…?" recall. Real video reading needs `GEMINI_API_KEY`. Without it, Aeri shows a map marked **Sample** that is not from your clip. |
| Gemini perception adapter | **Built and fixture-tested, not live.** It uses `generateContent` with inline video at 2 fps, YouTube `fileData`, and a Files API fallback. It extracts real ffmpeg frames at each timestamp and re-encodes large clips. It is tested against Gemini-shaped replies on a real generated clip. No key is configured. |
| Recipe video → missing items | **Works with a labeled sample recipe.** Subtraction uses only confirmed and fresh memory. Stale pantry counts are flagged rather than trusted. Generic ingredients match specific items (spaghetti counts as pasta), and pack sizes count by weight. Real extraction needs Gemini. |
| Social video links | **Refused honestly.** Instagram, TikTok, X, Facebook and similar links ask you to save the video and upload it. Direct `https://…mp4/.mov/.webm` links are downloaded, with private-network addresses refused. |
| Photo → product | **Works with labeled samples.** It applies your instruction plus saved preferences (brand, size, budget, allergies, stores). Matches are labeled exact, likely or similar. A match is only "exact" after the store page confirms brand, variety, size and price. A non-exact match needs explicit acknowledgement before it goes on a list. Real photo reading needs Gemini. |
| Store discovery and verification | **Live-tested.** Exa found the right product pages at Target, Walmart and Whole Foods. Kernel read the price, stock and store from Target's own page (for example $7.49, in stock). The store shown is chosen from the cloud browser's location, not yours, and the app says so. Walmart sometimes shows a bot check; that is reported as unverified. |
| Multi-store comparison | **Sample stores work and are instant. The live run takes about 2 minutes and usually comes back incomplete.** Totals are all-in (items, fees, tax and tip), and a two-store split is offered only when it saves money. Live product pages don't show fees or tax, so live totals say what is unknown and are never called cheapest. Quotes expire after 30 minutes. |
| Cart preparation and review | **Live-tested in a guest cart.** Kernel added one approved Target item and the page confirmed it. The live view opens in the in-app browser through a short-lived server link. Signed-in carts, store selection and quantities above one still need your retailer login. Checkout and payment stay with you. |
| Order, delivery, memory | **Works.** You enter the order number from the store, then check off what arrived. Only items that arrived are added to memory. |
| Open conversation and voice | **Needs keys.** Mastra over Neon AI Gateway, and Gemini transcription. Key-free mode handles commands such as "I have 6 eggs", "we used 2 eggs", "my shirt size is M", "where is the milk?" and recipe links. |

See [docs/DEMO.md](docs/DEMO.md) for the rehearsed walkthrough and [BUILD_PLAN.md](BUILD_PLAN.md) for the plan and its status.

## Run now, without sponsor keys

Requires Node 22, npm, and ffmpeg (optional; it adds evidence frames). On your computer:

```bash
npm ci
npm run setup:local
npm run dev:api
```

In a second terminal:

```bash
npm run dev:mobile
```

On your iPhone, install Expo Go, join the same Wi-Fi as your computer, and scan the QR code with the Camera app. Enter the API address shown by setup (your computer's LAN IP) and the access code stored in the ignored root `.env`. `localhost` works only in a simulator on the same machine. On iOS Simulator, use `http://localhost:8787`. On an Android emulator, use `http://10.0.2.2:8787`. Camera, microphone, Liquid Glass and haptics need a device.

If `.env` holds `EXA_API_KEY` and `KERNEL_API_KEY`, "Compare stores" runs the live check. Choose **⋯ → Rehearse with sample prices** for the instant, labeled sample stores.

## Activate providers

Put values in the root `.env`. Never put API keys in `EXPO_PUBLIC_*` variables or in the app. [Provider setup](docs/PROVIDER_SETUP.md) has the exact steps.

| Provider | Variables | What it enables |
| --- | --- | --- |
| Gemini direct API | `GEMINI_API_KEY`, `GEMINI_VIDEO_MODEL`, `GEMINI_AUDIO_MODEL` | Real video maps, recipe videos, photo reading, voice |
| Neon AI Gateway | `NEON_AI_GATEWAY_API_KEY`, `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_MODEL` | Open conversation through Mastra |
| Neon AI Gateway (video) | `NEON_AI_GATEWAY_VISION_MODEL`, `NEON_AI_GATEWAY_VIDEO_VERIFIED=1` | Video and photos on Gateway credit, **only after `npm run probe:gateway-video` passes** |
| Exa + Kernel | `EXA_API_KEY`, `KERNEL_API_KEY` | Live product discovery, store-page checks, cart preparation, live review |
| Neon Postgres | `DATABASE_URL` | Hosted state instead of local JSON |
| AgentMail | `AGENTMAIL_WEBHOOK_SECRET` | Signed receipt evidence (needs a public HTTPS API) |

Live rehearsal scripts spend a little Exa and Kernel credit, never buy anything, and always delete their browsers:

- `npm run check:retailer -w @personal-agent/api -- "<product>" target.com`
- `npm run check:cart -w @personal-agent/api -- <product URL>`, which adds to a throwaway guest cart
- `npm run check:compare -w @personal-agent/api`

## Project layout

- `apps/mobile`: Expo Router app (Agent, Memory, Tasks), the video map review, photo results, store comparison, voice.
- `apps/api`:
  - `perception.ts`: Gemini and the Gateway.
  - `media.ts`: frames, re-encoding, link import.
  - `market.ts`: Exa, Kernel.
  - `service.ts`: flows and background jobs.
  - Also the Mastra tools, auth, store and webhook.
- `packages/core`: Zod contracts plus deterministic logic. That covers video-map normalization and merging, reconciliation, confirmation, freshness, recall, product matching, and basket comparison.

`npm run typecheck` checks every package. `npm test` runs 45 tests covering the logic above and the authenticated API flows. `npx expo export --platform ios|android` in `apps/mobile` bundles the native app.

## Security and privacy

- Every `/v1` call needs the access code, which the phone keeps in SecureStore. Provider keys stay on the server.
- Raw video is written to a private temp file only while it is processed, then deleted. Small evidence frames are kept only for sightings you accept.
- Kernel live-view links grant control of the store browser. They are held in server memory, never saved in state, and are issued only while the session is alive.
- Browsers are deleted after an order number is saved or the list is discarded.
- AgentMail requests are checked with Svix signatures.
- Local setup uses HTTP on your own Wi-Fi only. A hosted build needs HTTPS.

This is a hackathon MVP for one private household.
