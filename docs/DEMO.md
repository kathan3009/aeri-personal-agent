# Two-minute rehearsal

The story: input → Aeri does the work → you review → you approve the exact list → Aeri hands you to the store → you pay there and record the order number → delivery updates memory. Each step shows the same state in Agent, Memory and Tasks, and the next action is always the single primary button on screen.

## Key-free run (rehearsed)

This is the version that works today with no sponsor keys. Sample data is labeled **Sample** wherever it appears. Never present it as real extraction.

1. **Open Aeri.** The aura blooms and the greeting settles in. Point out the three entry points: recipe video, kitchen video, and "tell me what you have".
2. **Tell it what you have.** Tap *Tell me what you have* and send "I have 2 tomatoes". Memory shows Tomatoes 2.
3. **Share a recipe.** Tap **+** → *Recipe video link*, paste a public YouTube link, and tap *Make a shopping list*. Aeri says plainly that it made a **sample recipe** because video understanding isn't connected. An amber *Approve your shopping list* dock appears above the composer, and Tasks gets an amber dot.
4. **Review.** Tap the dock. The list shows the exact items, with *Checked against your kitchen: Tomatoes: you have 2, buying 2 more*. Change servings, then remove an item.
5. **Approve.** Show that a quick tap does nothing, then press and hold *Hold to approve*. The track moves to 2 of 5.
6. **Open the store.** Without Kernel, Aeri opens the retailer's site, and the card says *Aeri hasn't placed an order* and lists the items to add yourself. Tap *Open the store* to show the handoff.
7. **Record the order.** After paying at the store, enter its order number and tap *Save order number* (rehearse with an obvious test value). Then tap *It arrived*. Memory now contains the purchased items.
8. **Scan the kitchen.** Tap **+** → *Choose a kitchen video*. Memory opens on *Check what I saw* with **Sample** items. Nothing is pre-checked; check two items and tap *Remember 2 items*. Only those two change memory.
9. **Preferences.** In Memory, add *Clothing sizes: Shirt M, shoes 9*. This is where non-grocery shopping context lives.

## With sponsor keys (not yet rehearsed)

Run the same flow, with these differences once each key has passed its own live test:

- **Gemini:** step 3 reads the real recipe in the video, and step 8 reads the real kitchen video. Check the extracted quantities before relying on the list.
- **Neon AI Gateway:** open questions get real answers. A gateway failure shows *Neon AI Gateway: <reason>* inline with *Try again*, with secrets removed.
- **Kernel:** step 6 opens a private live browser that adds only the approved items, and stops before checkout and payment. Verify items, quantities and availability in the live view before saying anything was added.
- **Voice (Gemini):** hold the mic, say "We used two eggs", and Aeri replies aloud.
- **Vapi:** call the paired number and ask Aeri what's in the kitchen; the same memory answers.
- **AgentMail:** show receipt evidence only after a signed webhook has actually arrived.

If a key is missing on demo day, Settings (the person icon) lists exactly which capability is on sample data. Say so out loud.

## What was verified, and where

| Check | Browser preview (393×852 and 375×667) | Android emulator, Expo Go | iPhone |
| --- | --- | --- | --- |
| Launch reveal, greeting, tab cross-fade, message and dock motion | Yes, frame by frame | Screens render; motion not recorded | Not yet |
| Text command → memory | Yes | Not repeated | Not yet |
| Recipe link → sample list → dock → Tasks | Yes | Dock → Tasks only | Not yet |
| Servings, remove item, kitchen subtraction line | Yes | Rendered, not edited | Not yet |
| Tap does not approve; hold approves | Yes | Yes (server state checked) | Not yet |
| Store handoff, order number, delivered → memory | Yes | Not repeated | Not yet |
| Kitchen video → sample review → only checked items saved | Yes (file picker) | Not repeated | Camera not yet |
| Provider error shown inline with secret removed | Yes (fake gateway) | Not repeated | Not yet |
| Unreachable server, wrong access code | Yes | Not repeated | Not yet |
| Liquid Glass, SF Symbols, blur material, haptics | Not possible | Not applicable | **Needs device** |

API tests (`npm test`) cover the approve → store → order number → delivered sequence, discard, removal, scan confirmation, gateway tool loop and gateway failure, Vapi pairing, and AgentMail signatures. `npx expo export --platform ios` and `--platform android` both bundle.

## Gates before calling it a live demo

- **iPhone:** Liquid Glass tab capsule (iOS 26), SF Symbols and their bounce, haptics on hold-to-approve, camera capture and upload, voice recording and playback, reopening the app, and LAN connection to the API.
- **Gemini:** one real YouTube recipe and one real kitchen video, inspected and corrected.
- **Kernel:** an authenticated retailer session, two products added, quantity and availability checked, live checkout handoff.
- **Vapi:** a successful inbound call from the allowed number, with the tool call visible in the app.
- **Hosted API:** Neon persistence survives a server restart, and secrets live in Fly, not the mobile bundle.
