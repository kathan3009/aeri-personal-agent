# Aeri handoff — completed local integration phase

Updated October 4, 2026. Repository: private `kathan3009/aeri-personal-agent`; branch `polish/calm-ui-and-cart-demo`; PR #1. The owner now wants **iPhone only**: do not spend time optimizing Android.

## First reads

Read `BUILD_PLAN.md`, `README.md`, `docs/PROVIDER_SETUP.md`, and `docs/LOCAL_RUN.md`. The last file contains the exact iPhone Expo Go walkthrough.

## Owner constraints

- Never print, paste into documentation, or commit secrets. Root `.env`, mobile `.env.local`, `.data-preview/` are ignored. Provider keys stay server-side. The phone uses only its API origin and owner access code, held in SecureStore.
- No real purchases by the agent. The general browser tool cannot navigate/click payment or checkout controls. The user reviews the native in-app live view and makes payment themselves. Orders require a merchant order number. Controlled submission exists only in core mock tests and has no HTTP purchase endpoint.
- Do not activate/deploy Neon compute or Fly until the owner’s no-card-charge requirement has a verified control. The email alert is not a cap. The local phone API runs with `DATABASE_URL=`.
- Neon Gateway credential generation and small synthetic-media tests were explicitly approved. Its scoped credential has only `ai_gateway:invoke`. Official Gateway docs say automatic top-up is unavailable; no manual top-up or card transaction was initiated. Prepaid credits were $500 before the tests; do not claim an unchanged remaining balance. The persisted single-process daily request quota is not a provider billing cap.
- Fixtures stay labeled Sample. Do not claim real iPhone clips, signed-in retailers, distance or unknown fees as verified.
- Leave unrelated untracked `.agents/`, `CLAUDE_HANDOFF.md`, and `skills-lock.json` alone. Push this branch, never main without owner permission.

## Implemented and verified

- Native Gateway Gemini route (`gemini-3-6-flash`): generated MP4 inline at2fps, PNG, short public YouTube URL, and spoken M4A passed HTTP/SDK tests. Structured household map and photo output passed schemas. Files API returned404; Gateway clips are compressed and sent inline with a conservative3MB media limit. Large phone photos over3MB are resized to1600px JPEG where decodable. This is an application limit, not a measured provider maximum.
- Live Mastra (`gpt-5-4-mini`) tool loop saved an oat-milk brand preference and created a draft grocery/clothing list. HTTP voice→transcript→confirmed inventory passed with synthetic “I have six eggs in the fridge.” Test household facts were archived outside the user’s clean Expo state.
- Core purchase snapshots bind exact products, quantities, charges, location, fulfillment and capture metadata to a SHA-256 hash. Approval has maximum total, <=5minute expiry, invalidation and atomic single use in mock-only submission. API reads the current merchant checkout page without navigation, validates against frozen lines, and refuses changed/incomplete summaries. Payment remains manual.
- Retailer connection API and mobile Memory→Store accounts: explicit consent→Kernel hosted login→profile reuse. Only opaque IDs persist privately; hosted links are transient. Disconnect closes sessions and invalidates checkout evidence. Three saved connections maximum; actual retailer auth still needs owner login/MFA.
- Target ZIP picker and pack quantity adapters are implemented and mock-tested. Unsupported/unconfirmed store location skips additions for user takeover. Generic browser actions are restricted to Search and exact Add buttons; self-reported additions remain uncertain.
- Live view mapping persists privately with15minute TTL. Duplicate preparations are rejected; cancelled work cannot restore a cart; new sessions close on failures. Store pages outside the login allowlist can still open without a managed profile.
- Relational persistence migrates legacy `agent_state/default` atomically into entity/projection tables, retaining the legacy rollback copy. Local state uses atomic files. Events/messages/completed tasks have retention caps; active tasks stay. Receipt replay claims survive retention/restart with90day TTL and a10k fail-closed cap. **No live Neon schema migration was run.**
- AgentMail signed receipt input matches known sender domain, exact labeled order reference and complete product phrases, including plurals. It creates review evidence only; inventory never updates automatically. Delivery confirms actual purchased pack quantities, excluding missing/substituted items.
- Inventory no longer allocates the same stock twice across recipe ingredients. Voice inventory commands preserve supported locations. Comparison failures offer Retry. Receipt activity prevents the false empty state and earns an attention dot.
- Dockerfile installs ffmpeg and certificates. No deployment made.

## Keys and remaining setup

Present only in ignored server `.env`: APP_ACCESS_TOKEN, DATABASE_URL, EXA_API_KEY, KERNEL_API_KEY, KERNEL_RETAILER_URL, NEON_AI_GATEWAY_TOKEN, NEON_AI_GATEWAY_BASE_URL, NEON_AI_GATEWAY_MODEL, NEON_AI_GATEWAY_VISION_MODEL; video/audio verification flags set after live probes. Direct GEMINI_API_KEY is not needed for the credited path and remains missing. AGENTMAIL_WEBHOOK_SECRET remains missing until a public HTTPS webhook is provisioned. VideoMemory remains optional and unintegrated; confirmed observations plus ffmpeg frames cover current recall.

## Local phone run

API port8790, Metro8085. Current Mac Wi-Fi IP192.168.6.109 (changes across networks). The ignored `.data-preview/iphone-connection.txt` has only the owner API access code and connection instructions; no sponsor secrets. QR: `.data-preview/expo-go.png`.

```bash
HOST=0.0.0.0 PORT=8790 DATABASE_URL= DATA_DIR=.data-preview/expo-live node --import tsx apps/api/src/index.ts
```

```bash
cd apps/mobile
npx expo start --clear --lan --port 8085
```

Private root credential file has mode0600. Keep `apps/mobile/.env.local` API address synced with Wi-Fi IP. Do not use `npm run dev:api` casually: it loads the configured real DATABASE_URL. Tests use temp local state/mocked providers.

## Verification and remaining real-world checks

`npm run typecheck && npm test`; `cd apps/mobile && npx expo export --platform ios --output-dir /tmp/aeri-final-ios`. UI/account/sample comparison/receipt review were rehearsed in native Expo Go before the owner narrowed scope to iPhone. Final physical-iPhone validation remains the owner’s next step:

1. Real20–40second kitchen recording, gallery MP4, evidence frames/count corrections, reopen persistence.
2. Real voice turn and spoken reply, permissions, Liquid Glass/page-sheet appearance.
3. Target hosted login/MFA and ZIP selection, one cart prepared and reviewed without payment.
4. Merchant final-summary selectors may return incomplete; manually verify unknown fields. Live delivered totals and distance remain unavailable when the merchant does not expose them.
5. Split baskets cannot currently be checked out as one cart: choose a single-store basket and handle separate store orders manually.
6. Public AgentMail HTTPS endpoint/webhook secret and live Neon migration/Fly deployment remain blocked by the billing/public-URL setup.
