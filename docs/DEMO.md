# Expo Go verification

The next acceptance test is a real phone walkthrough: **record visible objects → review timestamps/evidence → correct → remember → ask the next shopping question**. Synthetic provider tests have passed; household accuracy and camera/microphone behavior still need the owner’s device.

## Connect the phone

1. Start the API with `HOST=0.0.0.0 DATABASE_URL= DATA_DIR=.data-preview/expo npm run dev:api`. This preserves the no-card-charge boundary for Neon compute.
2. Run `npm run dev:mobile`. If the bundle seems stale, restart Metro with `npx expo start --clear` from `apps/mobile`.
3. Join the same Wi-Fi, open the Metro QR code in Expo Go, and set Aeri’s API address to the computer’s LAN URL. Enter the private access code from ignored `.env`; never paste it into chat.
4. Check Settings shows vision, voice and Gateway configured. A public Metro tunnel does not automatically expose the separate LAN API.

## Verify real media first

1. **Recorded video:** film one shelf/fridge/closet for 20–40 seconds in good light. Pause on labels and narrate unclear counts. Review each sighting’s timestamp/frame, location and uncertainty. Reject invented/hidden items; correct a name/count/location and remember only what you confirm.
2. **Memory:** ask “Where is the milk?” or another confirmed item. Check the place and source moment. Scan the same area again: changed/unseen items should be proposals, not silent deletion.
3. **Gallery:** import a real MP4/MOV from Photos or Files. Choose home-map or recipe purpose. Confirm it is interpreted from your actual clip, rather than a Sample. Large videos are compressed; if they still exceed Gateway inline limits, use a shorter clip.
4. **Recipe:** share one public recipe YouTube link or recipe video file. Check servings, ingredient quantities and timestamps manually. Confirmed/fresh owned items should be subtracted once; stale quantities should require a check. Social URLs that cannot be imported should ask for a video file.
5. **Photo:** photograph a branded item and say “same brand, smaller size” or another preference. Inspect extracted attributes, uncertainty and retailer source pages. An exact result needs a matching store check; likely/similar results require acknowledgement. A similar package is not proof of the same formulation or size.
6. **Voice:** tap the microphone, say “I have six eggs in the fridge,” and finish speaking. Check the transcript, six eggs and the saved place. Say “we used two eggs” and verify four remain. Then state a preference or shopping request and confirm the reply/tool result. Phone-call integration is intentionally absent.
7. **App lifecycle:** reopen/foreground the app, switch Agent/Memory/Tasks, check permissions, Reduce Motion, haptics, native review sheets and readable text. Do not infer iPhone behavior from the emulator.

## Verify shopping and retailer review

1. Create a list with a brand/type/size/budget instruction. Confirm preferences affect candidates. **Compare stores** uses live Exa/Kernel when configured, but stock, tax, fees and distance remain unknown if not observed. Unknown all-in totals must never be called cheapest.
2. For the instant demonstration choose **⋯ → Rehearse with sample prices**. Keep the Sample label visible and explain that those prices are illustrative. Choose a **single-store** basket before checkout; split baskets currently cannot be prepared automatically.
3. Hold to approve the chosen plan. On Memory’s retailer connections, choose **Connect** only for a real account you want Aeri to access. Complete the Kernel-hosted login in the app’s browser; the agent must not receive passwords/MFA codes. The app allows three saved connections. This is still awaiting the owner’s live rehearsal.
4. Set the actual ZIP/location. Target’s new picker must visibly confirm the chosen store. Other retailer location adapters remain unsupported and require user selection; proxy-IP location is not yours. No automatic additions occur when the requested ZIP is unconfirmed.
5. Open the store cart and **Review the store cart** in the same hosted session. Check exact products and approved pack counts, including a quantity above one. Unsupported quantity controls must remain uncertain, never silently add one.
6. Navigate to the merchant checkout summary yourself, then return and tap **Check final checkout**. Aeri reads the current page without clicking checkout/payment. If tax/fees/tip/discount/location or exact lines are missing, it must show the gap and prevent a final approval claim. A complete matching summary may be approved with a maximum total and expiry, but there is no real agent-submit route.
7. **Stop before payment during this verification.** Aeri never purchases. For a separate labeled sample lifecycle, enter an obvious test order reference, mark delivered/missing lines, and check only confirmed arrived packs enter memory. Actual orders require the retailer’s real confirmation number and actual received items.
8. Disconnect the account to test cleanup: session/live-view links should close, current final approval should invalidate, and saved account metadata should be removed. Reconnect requires a new explicit action.

## What has already been verified

| Check | Evidence |
| --- | --- |
| Gateway small video/photo/YouTube transport | Native `gemini-3-6-flash` HTTP 200 for a generated 3-second MP4 at 2 fps, synthetic PNG and short public YouTube input |
| Actual SDK structured media parsing | Household map with zero visible household objects and photo test-pattern description; synthetic input only |
| Gateway Files route | HTTP 404; unsupported, so the app compresses/uploads inline |
| Audio and authenticated voice flow | Synthetic M4A transcript exactly “I have six eggs in the fridge”; API voice route persisted six eggs |
| Live Mastra tool loop | Saved Oatly preference and created requested milk-and-shirts draft through model tools |
| Prior Exa/Kernel checks | Target price/stock and guest cart addition; Walmart challenge classified blocked; all temporary sessions deleted |
| New auth/store/quantity/final-summary code | Mocked tests only; no real retailer account connection or final checkout rehearsal yet |
| Core purchase boundary | Snapshot arithmetic/hash, expiry, maximum total, invalidation and atomic single-use mock submit tests; no real submit |
| Persistence/delivery/receipts | Local retention/migration parity/session-TTL tests, purchased-pack delivery tests and signed receipt review/deduplication; no live Postgres migration/public webhook |
| Device UI | Earlier Android Expo Go/browser rehearsal exists; new real iPhone camera, microphone, auth and final-summary checks remain |

Run `npm run typecheck`, `npm test`, and native Expo exports before treating a slice as ready. Test counts change as coverage grows; successful mocks and native bundles do not replace real-device or authenticated-retailer verification.

## Remaining activation gates

- Real shelf/gallery/photo/voice check on Expo Go.
- User-approved live retailer login, selected store, correct quantities and checkout summary selectors.
- AgentMail public HTTPS endpoint and webhook signing secret.
- Verified no-card-charge control before Neon compute or Fly deployment.
- Optional VideoMemory cross-video retrieval is not integrated and is not required for the current demo.
