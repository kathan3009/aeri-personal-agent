# Check Aeri on your iPhone

Everyone signs in with their email: Aeri emails a 6-digit code (from `aeri-sign-in@agentmail.to`), and each email gets its own private account, memory, store sign-ins and Aeri email address. Set `AERI_OWNER_EMAIL` in `.env` to your email first, so your existing memory and store sign-ins become your account. Retailer sign-ins are separate.

## Open Expo Go

1. Keep this Mac awake and put the iPhone on the same Wi-Fi. Install/open Expo Go from the App Store.
2. Scan the QR shown by Codex with the iPhone Camera. The development URL is `exp://192.168.6.109:8085`.
3. The app uses `EXPO_PUBLIC_API_URL` from `apps/mobile/.env.local` (a development build can also tap **Use a different server**).
4. Enter your email, tap **Send code**, and type the 6-digit code from the email. Without AgentMail configured, a development server shows the code instead. The session token stays in the iPhone's SecureStore; sign out in Settings.
5. Allow Local Network access. Allow camera/photos/microphone when you use those features.

The current LAN address may change when the Mac switches networks. Restart with the new address if necessary. No Expo account is required to connect to the local development build.

## Set up your preferences and store accounts

1. In **Memory → Preferences**, set your ZIP under Location, favorite stores, budget, allergies, preferred brands and clothing/shoe sizes. You can also say these through Voice.
2. In **Memory → Shopping → Store accounts**, choose Target, Walmart or Instacart, then **Continue to [store]** to consent to saving that retailer browser session.
3. Sign in on the hosted retailer page, including any MFA yourself, and return to Aeri. The account should show **Connected**. Aeri does not ask for your store password. Aeri keeps up to 10 stores signed in (`KERNEL_MAX_STORE_CONNECTIONS`); failed or expired sign-ins don't count. If Kernel's own plan refuses another, the app says so.
4. Start with Target for the ZIP store-picker adapter. Other store selection remains manual when Aeri cannot confirm it. Retailer bots, unsupported login methods and live selectors may still need your takeover; none have been claimed as a verified signed-in purchase flow.

## Your first end-to-end run

1. **Voice:** say “I have six eggs in the fridge.” Check Memory for six eggs in Fridge. Then say “we used two eggs” and check that four remain. Set your shirt size and preferred oat-milk brand by voice too.
2. **Video:** tap **+**, record a slow 20–40 second fridge/pantry walkthrough, showing labels clearly. Check timestamps and evidence frames, correct counts/brands, reject mistakes, and tap **Remember**. Nothing inferred should become confirmed stock without your review.
3. **Gallery:** import a saved MP4/MOV as a home video or recipe. Confirm it follows the same review flow.
4. **Recipe:** paste a public YouTube recipe URL or upload a recipe video. Check ingredients and the list of missing items against Memory. Social-page links that cannot be imported ask you to upload the actual video.
5. **Photo:** photograph a product and ask “find this, prefer my usual brand and size.” Review exact/likely/similar candidates; verify the store page before trusting an exact match.
6. **Shopping:** ask “create a list with one Oatly oat milk and two medium blue cotton shirts.” Open Tasks, review the draft, compare stores, and choose a single-store option. Real comparison can take a few minutes and fees/distance can remain unknown. Use **⋯ → Rehearse with sample prices** for the instant labeled demo. Split comparisons require separate store checkout and cannot be submitted as one cart.
7. **Cart review:** hold to approve the list, open the store, and review its live browser in Aeri. Confirm store/location, product variants and pack quantities. The agent never clicks checkout or pays.
8. **Final summary:** navigate to checkout yourself in the merchant browser and return to Aeri. Tap **Check final checkout**. When all lines, charges, fulfillment and location are observed and match, hold to approve the final total. Changed or incomplete summaries refuse approval; approval expires in five minutes. You still make any payment yourself at the store.
9. **Order/delivery:** only enter a real merchant order number after a purchase you choose to make. Do not make a purchase just to test this app. Later tap **It arrived** and check each fulfilled item; only those packs update Memory. Incoming receipts are review evidence and never silently mark delivery.
10. Close/reopen Aeri and check that preferences, confirmed inventory and draft lists persist.

## What was verified locally

Gateway HTTP and actual SDK calls passed for generated inline MP4, image, a short public YouTube URL and synthetic spoken M4A. The voice HTTP route saved six eggs; live Mastra tool calls saved a preference and created a grocery/clothing draft. Core/API tests cover checkout changes/expiry, mock-only single-use submission, persistence, receipts, quotas and inventory. Native bundles export successfully. A real iPhone kitchen clip and retailer login still require the owner's physical-phone check.

## Restart later

From the repository root (server credentials are already in the ignored `.env`):

```bash
HOST=0.0.0.0 PORT=8790 DATABASE_URL= DATA_DIR=.data-preview/expo-live node --import tsx apps/api/src/index.ts
```

In another terminal:

```bash
cd apps/mobile
npx expo start --clear --lan --port 8085
```

Set `EXPO_PUBLIC_API_URL` in ignored `apps/mobile/.env.local` to the Mac's current LAN address and port8790. If the app cannot connect, check Wi-Fi, the Mac firewall, iPhone Local Network permission, and the server address. Keep both terminals running. If code appears stale, reopen the bundle after restarting Metro with `--clear`.

This local server deliberately uses **local persistence** (`DATABASE_URL=`). The relational Neon migration is implemented but has not run against your live database. Fly deployment, real Neon compute migration, and a public AgentMail webhook wait for the appropriate billing/public-URL setup. Gateway inference uses prepaid credits; no manual top-up or card charge was initiated. The persisted request quota is a single-process request limit, not a provider billing cap.
