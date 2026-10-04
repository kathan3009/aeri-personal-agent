# Aeri

Aeri is a private, iOS-first personal shopping agent (Android is supported). It remembers confirmed kitchen items and preferences, turns a public YouTube recipe into a shopping plan, lets you approve a cart, and opens a retailer checkout. A kitchen video produces observations for review. Text and in-app voice conversation update the same memory.

The repository is a mobile app plus a private API. There is no consumer web app. The conversation uses the MIT-licensed native [assistant-ui](https://www.assistant-ui.com/docs/react-native) library.

The interface is designed iPhone-first: SF Pro on Apple's text-style scale, SF Symbols for navigation, haptics, a light sky palette with one deep accent, and glass only on floating elements (native Liquid Glass on iOS 26, the system blur material on earlier iPhones, an opaque surface on Android). Every state has one primary action. Cart approval is a deliberate press-and-hold, and Aeri never pays or claims an order without the store's order number. Motion is limited to the launch reveal and responses to what you do, and it follows the system Reduce Motion setting.

## Run now, without sponsor keys

Requires Node 22 and npm. On your computer:

```bash
npm ci
npm run setup:local
npm run dev:api
```

In a second terminal:

```bash
npm run dev:mobile
```

On your iPhone, install Expo Go from the App Store, join the same Wi-Fi as your computer, and scan the QR code with the Camera app. Enter the API address shown by setup (your computer's LAN IP) and the access code stored in the ignored root `.env`. Liquid Glass, SF Symbols, haptics, camera and microphone show their real behavior on a device. The API address can be changed on the connection screen; `localhost` works only in a simulator on the same machine. On iOS Simulator use `http://localhost:8787`; on an Android emulator use `http://10.0.2.2:8787`.

To inspect the same React Native screens locally without a device, run `npx expo start --web --host localhost` from `apps/mobile` and open the printed localhost URL. Connect to `http://127.0.0.1:8787` with the access code in `.env`. This browser build is a development preview; the delivered product remains the iOS/Android app. Preview credentials are kept in browser session storage, while iOS/Android use SecureStore. Device camera, microphone and native Liquid Glass still require a phone or simulator.

Key-free mode supports chat commands such as `I have 3 eggs`, `We used 2 eggs`, and `My shirt size is medium`. Pasting a YouTube link creates a **clearly marked sample recipe** and a draft missing-ingredient list for review. Uploading a kitchen video produces **clearly marked sample observations** for the confirmation UI. It does not pretend to understand the video without Gemini. Inventory, messages, tasks and events persist locally in ignored `.data/state.json`.

## Activate providers

Copy values into the root `.env`; never put API keys in `EXPO_PUBLIC_*` variables or the app. See [provider setup](docs/PROVIDER_SETUP.md) for exact handoffs.

| Provider | Variables | What it enables |
| --- | --- | --- |
| Neon Postgres | `DATABASE_URL` | Durable hosted state instead of local JSON |
| Neon AI Gateway | `NEON_AI_GATEWAY_API_KEY`, `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_MODEL` | Mastra open-ended agent loop and retailer browser planner |
| Gemini direct API | `GEMINI_API_KEY`, `GEMINI_VIDEO_MODEL` | Public YouTube recipe understanding, kitchen video observations, voice transcription |
| Kernel | `KERNEL_API_KEY`, `KERNEL_RETAILER_URL` | Hosted browser and live retailer view; with Gateway, constrained cart-preparation agent |
| Exa | `EXA_API_KEY` | Product research endpoint |
| AgentMail | `AGENTMAIL_WEBHOOK_SECRET` | Signed inbound receipt evidence, queued for review |

The user approves the exact draft items before the browser starts. Aeri never submits payment. Opening a checkout is **not** a placed order; the user records the merchant's order reference after checkout and confirms delivery before purchased items enter inventory. Retailer login, prices, availability, and product matching require a live store rehearsal after Kernel/Gateway credentials arrive.

## Project layout

- `apps/mobile`: Expo Router, native assistant-ui conversation, camera/video upload, in-app voice conversation, Memory and Tasks screens.
- `apps/api`: Hono API, Mastra tools, provider adapters, access-code auth, local/Neon store, and AgentMail webhook.
- `packages/core`: Zod state contracts, deterministic ingredient subtraction and approval transitions.
- `docs/DEMO.md`: two-minute demo path and current verification gates.

`npm run typecheck` checks all packages. `npm test` covers quantity math, scan confirmation, API authentication, cart approval and persistence. `npx expo export --platform ios` in `apps/mobile` verifies the native JS bundle. A real phone build and sponsor-backed integration tests still need credentials and device access.

For an installable Android demo, `apps/mobile/eas.json` includes an internal `preview` APK profile. Run `eas build --platform android --profile preview` from `apps/mobile` after connecting an Expo account. iOS internal distribution additionally needs Apple signing/provisioning.

## Security and privacy

The API rejects all `/v1` calls without the access code; the phone stores that code in Expo SecureStore. The app never embeds provider keys. The local JSON store is for one private household; set Neon Postgres for hosted use. AgentMail verifies Svix signatures. This is a hackathon MVP, not a multi-household service.

The generated local setup uses HTTP only for same-Wi-Fi development. Use an HTTPS API URL for hosted builds and avoid sending the access code over untrusted networks.
