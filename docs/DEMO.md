# Two-minute rehearsal

The story: **film a shelf → Aeri maps what's visible → you confirm or correct → only confirmed facts change the next list → compare stores by all-in cost → approve one exact total → Aeri fills the store cart → you review the real cart and pay → order number → check what arrived → memory updates.** Every step shows the same state in Agent, Memory and Tasks, and the next action is always the one primary button on screen.

## Key-free run (rehearsed October 4 in the app on an Android emulator and in a browser preview)

Without `GEMINI_API_KEY`, the map, recipe and photo are **labeled samples**: a "Sample" tag and a plain sentence saying they were not read from your media. Say so out loud and never present them as real extraction. Store prices are **Sample prices** unless the live check is used.

1. **Open Aeri.** It greets you with three calm entry points: map a shelf/fridge/closet, find from a photo, and shop a recipe video. The microphone and **+** are always in the composer.
2. **Map a shelf.**
   - Tap *Show me a shelf, fridge or closet*, then *Record a video* (on a phone) or *Choose from your library/Files*. A library video asks once whether it shows your home or a recipe.
   - Memory shows *Check what I saw* (Fridge · Pantry shelf, 7 things, 3 need a closer look). Tap **Review**.
3. **Review.**
   - Point out the places with time ranges, each item's timestamp, and its evidence: *Read on the label*, *Seen*, *You said it*, or *A guess* (in amber).
   - Point out the close-up requests ("Open the crisper drawer fully so I can count the tomatoes") and the unclear spot ("Couldn't make out two jars behind the cereal").
   - Tap *Check the 4 clearly seen*. Tap Tomatoes: because its count was unclear, Aeri asks *How many tomatoes?* and the button stays disabled until you enter one (type 4).
   - Tap any item to fix its name, brand, place or use-by date. Then tap **Remember 5 things**.
4. **Memory** now groups confirmed items by place, with brand and shelf position. Ask in chat *"Where is the milk?"*: Aeri answers with the place and the video moment (0:03).
5. **Shop a recipe.** Paste a YouTube link (+ → *Paste a recipe link*, or in chat). The list in Tasks leaves out what you confirmed: the 4 tomatoes and the boxed spaghetti, which covers pasta by weight. *Checked against what you have* shows how memory was used.
6. **Compare stores.**
   - Tap **Compare stores**. Three sample stores appear with all-in totals: Valley Grocery pickup $13.77 (recommended), Corner Market delivery $23.95 including fees and tip, and Fresh Mart, which is missing an item and has unknown fees ("+").
   - Read the explanation, then tap the recommended store.
7. **Approve.** A quick tap does nothing. Press and hold **Hold to approve $13.77 at Sample Valley Grocery**.
8. **Store handoff.**
   - Tap **Open the store**. Without Kernel, the store's site opens in Aeri. With Kernel, a private browser adds the approved items and you review the real cart through **Review the store cart**.
   - Aeri says plainly that it hasn't placed an order.
9. **Order and delivery.** Enter an obvious test order number, then tap **It arrived**, uncheck Cream ("didn't come"), and tap **Add 3 items to memory**. Only those three appear in Memory.
10. **Photo.** Choose + → *Find from a photo*, take or choose a photo, tap *Same brand*, then **Find it**.
    - Tasks shows the product, the label text read, the applied constraints, an **Exact match** (store-checked brand, variety, size and price), and **Likely matches** with reasons, such as "Different size than 32 oz".
    - A likely match needs *Use this likely match* before it goes on a list, and that list still needs approval.

## With keys (not yet rehearsed)

- **Gemini:**
  - Steps 2–3 read your real clip, and each item shows the actual frame where it was seen.
  - Step 5 reads the real recipe (with timestamps), and step 10 reads your real photo.
  - Check that nothing hidden was invented and that unclear labels ask for a close-up.
- **Exa + Kernel:**
  - **Compare stores** runs live in about 2 minutes. Expect real prices from Target pages, unknown fees and tax, and bot checks at some stores; the app states each unknown.
  - For a reliable demo, use *⋯ → Rehearse with sample prices* and show one live photo check instead: *Check price and stock at the store*.
- **Neon AI Gateway:** open questions work, and by voice you can say "the milk and eggs are right, there are 4 tomatoes"; Aeri marks those items in the pending map, and you still tap Remember.
- **Voice:** tap the mic, speak, then tap *Finish speaking*. This needs Gemini; keyboard dictation works without it.

## Where each step was verified

| Check | Browser preview (iPhone 15 size) | Android 15 emulator, Expo Go | iPhone | Live provider |
| --- | --- | --- | --- | --- |
| Welcome, + menu, video purpose sheet | Yes | Rendered | Not yet | n/a |
| Library video → sample map → review → required count → remember | Yes | Yes (review full-screen, remember 4) | Not yet | Gemini: fixture-tested only |
| Evidence frames from the real clip at each timestamp | n/a (sample) | n/a (sample) | Not yet | ffmpeg path tested in `flows.test.ts` |
| "Where is the milk?" recall | Yes | Shown in chat | Not yet | n/a |
| Recipe link → list subtracts confirmed items | Yes | Rendered | Not yet | Gemini: fixture-tested |
| Sample store comparison → choose → hold to approve | Yes | Rendered | Not yet | n/a |
| Live store comparison (Exa + Kernel) | n/a | n/a | n/a | Ran via `check:compare`: real Target prices, some pages blocked or unpriced, fees unknown |
| Kernel product page check | n/a | n/a | n/a | Target $7.49 in stock; Walmart bot check reported as blocked |
| Kernel guest add-to-cart | n/a | n/a | n/a | Target: added and confirmed; session deleted |
| Order number → per-item delivery → memory | Yes | Earlier list shown | Not yet | n/a |
| Photo → labeled matches → acknowledgement for likely | Yes | Rendered | Not yet | Gemini: not live |
| Camera recording, microphone, Liquid Glass, haptics | Not possible | Not tested | **Needs device** | n/a |

`npm test` runs 45 deterministic tests. They cover map normalization and merging, reconciliation, corrections, freshness, recall, product matching, basket ranking and explanations, Gemini-shaped replies run through real ffmpeg frame extraction, provider failures with secrets removed, and the full order lifecycle. `npx expo export --platform ios` and `--platform android` both bundle.

## Gates before calling it live

- **iPhone:** record a real 20–40 s clip, plus camera and photo permissions, voice, reopening the app, and LAN connection.
- **Gemini:** one recorded clip, one gallery MP4 and one YouTube recipe, each inspected for invented items and timestamp accuracy.
- **Retailer:** a signed-in Kernel Managed Auth profile, your actual store selected, two items with correct quantities, and the live view reviewed on the phone. Payment stays with you.
- **Hosted API:** only after a verified card-spend control on Neon/Fly.
