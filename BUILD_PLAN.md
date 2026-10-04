# Aeri build plan — retailer-independent personal shopping agent

**Updated:** October 4, 2026. **Credit snapshot:** Neon refreshed ~11:35 AM PDT; other providers checked ~11:20 AM PDT. This is a plan, not a claim that the unbuilt steps work. Account balances can change; recheck them before activating a paid service. The repository stays private under `kathan3009`.

## Product contract

Aeri turns a request such as “Make the pasta in this video, use the tomatoes I have, buy the cheapest acceptable ingredients within 3 miles, and keep the delivered total under $30” into a verified purchase proposal. It remembers confirmed household facts, searches multiple retailers, explains the tradeoffs, fills a cart, and can submit an order only after a separate approval of the **final merchant, items, substitutions, delivery choice, and total**. If final-price or availability evidence is missing, Aeri labels it as unknown and asks the user to finish at the merchant.

The user can instead say “nearest,” “organic only,” “this brand,” “pickup today,” “no substitutions,” or “buy my usual size.” Grocery is the first complete vertical; the request, offer, and order models must also support clothing and household goods. The agent must never imply a cheaper *delivered basket* from a cheaper individual item while ignoring fees or extra stores.

## What exists today and what must change

The Expo app has chat, voice capture, recipe-link entry, kitchen-video upload, Memory, Tasks, cart review, and a retailer handoff. The Hono API has a Mastra agent, local/Neon state, Exa product-link search, a Kernel browser adapter, and signed AgentMail receipt ingestion. The agent currently targets **one configured retailer URL (Instacart by default)**. Exa results are links, not verified stock or prices. The Kernel cart action has not been rehearsed against a signed-in store. Aeri does **not** place orders or charge a payment method. Video understanding and voice transcription need a separate Gemini key; without it the app correctly labels sample results. Neon AI Gateway credit has posted, but its key/model connection and open-ended/browser-agent loops are not live-tested. These gaps are the implementation queue, not demo claims.

## End-to-end architecture

```text
Mobile voice / text / video / share link
  -> intent and constraints (Mastra + model)
  -> household memory and source evidence (Neon Postgres)
  -> missing quantities / product specifications
  -> Exa discovery of candidate merchants and products
  -> Kernel verification at selected merchants: location, stock, size, price, fees
  -> normalized offers + basket optimizer
  -> user approves a merchant-specific cart plan
  -> merchant adapter fills cart and reads the final checkout summary
  -> user approves the exact final total and purchase terms
  -> controlled order submission OR user takeover at merchant
  -> merchant confirmation / receipt -> delivery reconciliation -> memory update
```

**Discovery is not verification.** Exa finds candidate pages. A retailer API, when available, or a Kernel browser session at the selected local store verifies the current offer. Each offer stores `merchant`, `store/location`, `product URL or SKU`, `brand`, `size`, `quantity`, `unit price`, `in-stock state`, `delivery/pickup`, `fees`, `capturedAt`, and `source`. Unknown fields stay unknown. Search-result snippets never become “live prices.”

### Retailer-neutral shopping loop

1. **Parse the request.** Create `ShoppingRequest`: normalized needs, budget, optimization (`lowest delivered total`, `nearest`, `fastest`, or `preferred merchant`), brand/type/diet/size constraints, location, delivery or pickup, substitution policy, and deadline. Ask only for missing choices that change the result. Save lasting preferences separately from this one-time request.
2. **Resolve what is already owned.** Subtract only confirmed, reasonably fresh inventory from the needed quantities. Show the subtraction. If kitchen evidence is uncertain, ask the user to confirm it rather than silently skipping an item.
3. **Find candidates across merchants.** Exa discovers product/retailer pages; merchant-specific adapters can use official APIs where access exists. For “nearest,” request device location permission or use the saved ZIP/address, select the actual store/fulfillment location, and calculate distance. A straight-line distance is labeled as such; driving time requires a routing provider. Search at least two viable stores when the query is about price or proximity.
4. **Verify and compare.** Kernel visits the specific store/location and checks item match, package size, stock, current price, minimum order, and checkout fees where visible. Normalize `$/oz`, `$/each`, etc. Reject hard-constraint violations first (allergen, brand-only, size, radius, budget cap). Rank baskets by **item subtotal + tax estimate + service/delivery fees + tip + travel cost if relevant**, then account for delivery time and number of stores. A two-store split wins only if its all-in cost and inconvenience actually improve the result. Put a time-to-live on quotes and recheck before purchase.
5. **Show an explainable proposal.** Example: “Store A: $24.60 estimated delivered, 2.1 mi; Store B: $21.40 pickup, 3.4 mi. Store B is cheaper if you can pick up.” Show exact product, pack size, substitutions, fees, unavailable items, and evidence time. Let the user change the choice before any browser cart work.
6. **Prepare checkout.** A merchant adapter fills only approved products and verifies the resulting cart. It returns `added`, `unavailable`, `substituted`, or `uncertain` per line item. Store-specific selectors and login flows stay inside adapters; the planner sees normalized operations such as `searchProduct`, `selectStore`, `addToCart`, and `readCheckoutSummary`. Do not let an LLM freely click a payment button.
7. **Purchase authorization.** Capture the final merchant checkout screen: exact items, quantities, substitutions, address, slot, fees, tip, tax, and total. The mobile app issues a short-lived, single-use approval bound to that snapshot and a maximum amount. Any price increase, product change, address change, or expiry invalidates it. A deterministic submit action, outside the general browser agent tool, may click the final order button only after this approval and only if the retailer supports a reliable confirmation path. Use a payment method already saved at that merchant; Aeri never receives raw card numbers. If login, MFA, CAPTCHA, payment entry, or reliable final-total verification blocks this path, hand control to the user at the merchant checkout. Never retry order submission blindly; first check whether an order was created.
8. **Close the loop.** Mark `ordered` only on a merchant order ID/confirmation, not on a click. AgentMail can ingest a signed inbound receipt as evidence; the email content itself is untrusted and must be matched to merchant/order/item details. On delivery, compare **fulfilled items and substitutions** with the plan, ask the user to resolve differences, and then add what actually arrived to inventory. A failed or partial order does not update pantry memory.

Official retailer integrations can replace individual browser adapters without changing the planner. [Instacart's Developer Platform](https://docs.instacart.com/developer_platform_api/guide/concepts/shopping_list) is one optional shopping-list/deep-link adapter, not Aeri's core. Its developer key and production approval are separate prerequisites; its [getting-started guide](https://docs.instacart.com/developer_platform_api/get_started/overview/) says production access commonly takes 30–40 days. For the hackathon, use Kernel for the merchants we can actually rehearse. Do not promise universal coverage: some sites block automation or hide final totals until login.

## Video memory: where it lives and how it changes

“Video memory” is **our product feature**, not a separate sponsor on the [hackathon stack](https://build-personal-agents.com/stack). It has two distinct jobs:

| Input | Perception | Durable memory written after review | Shopping effect |
| --- | --- | --- | --- |
| Public recipe video link | Gemini extracts ingredients, amounts, servings, instructions, and uncertainty | Recipe with source URL and extraction timestamp | Scale servings; compare ingredients with pantry; create missing-item needs |
| Short fridge/pantry video from the app | Gemini identifies visible products, counts/pack sizes when legible, and timestamped evidence | User-confirmed inventory observation with quantity, location, freshness, source scan ID | Remove what is already owned; ask if a visible count is uncertain |
| In-app voice update | Transcription followed by a structured intent | Explicit inventory update, preference, size, brand, allergy, or correction with source `voice` | Changes future filters and quantities |
| Merchant order and delivery | Order confirmation and actual fulfilled items | Purchase event; inventory only after delivery reconciliation | Prevent repeat buying and improve the next plan |

The processing path is **phone capture -> API upload -> Gemini observation -> review cards in the app -> Neon memory**. For a short clip the current API sends video inline; for a larger clip it uploads via Gemini Files API and deletes that uploaded file after analysis. Google documents [YouTube URLs and uploaded video](https://ai.google.dev/gemini-api/docs/video-understanding) as video inputs. We should keep raw kitchen video only long enough to process it unless the user opts in to an evidence archive. A first implementation can keep a scan ID and timestamps without retaining the raw video. If an evidence archive is needed, use private object storage with a deletion window and signed access, subject to a separate cost check. Do not put raw video bytes in the Neon Postgres state blob.

The memory record should distinguish `observed`, `user_confirmed`, and `stale`, and retain provenance: `item`, `quantity`, `unit`, `brand/variant`, `location`, `observedAt`, `sourceType`, `sourceId`, `confidence`, and `lastConfirmedAt`. An observation is a **proposal**, never an automatic stock count. A later video should reconcile against the previous state and show additions, removals, and uncertain changes. For example: “I saw one milk carton; last confirmed was two. Did you finish one?” Repeated purchases may suggest a favorite brand, but a brand/size preference becomes durable only when explicitly stated or confirmed. Expiring/perishable counts should be marked stale; the agent asks before relying on them for a purchase.

The current implementation has the upload, extraction, review, and confirmed inventory update, but uses a simple name/quantity record. It still needs source links, timestamps per observation, freshness policy, richer item identity, change reconciliation, and actual-delivery matching. The current Neon store saves one JSON state blob; migrate to versioned relational tables for offers, evidence, approvals, orders, and inventory events before multi-retailer ordering.

## Tools and credits: verified account snapshot

Balances below come from the read-only [account audit](docs/ACCOUNT_STATUS.md), checked October 4 at ~11:20 AM PDT for most providers and ~11:35 AM PDT for Neon. A sponsor offer is not the same as posted credit. Provider keys stay in ignored local `.env` or deployment secrets.

| Tool | Aeri job | Current state / credit | Next use |
| --- | --- | --- | --- |
| **Expo + React Native** | iOS-first app: voice, camera, location permission, proposal/approval UI | Local app runs; no sponsor credit needed | Add location preference and comparison/final-approval screens |
| **assistant-ui React Native** | Conversation UI | Open-source package installed; **$750 side quest is a prize, not credit** | Keep chat coherent with shopping tasks and approvals |
| **Mastra open source** | Planner/tool loop and bounded browser agent | Framework used locally; Mastra hosted account has **$0 posted**, Starter, auto top-up off; $25 code on stack has not appeared as account balance | Add typed shopping/merchant tools; hosted Mastra optional |
| **Neon Postgres** | Durable household memory, offers, audit events, order state | **$500 main credit posted**, $0 charged; card attached; local database read confirmed | Move from one JSON blob to versioned tables; no additional deployment without card-charge control |
| **Neon AI Gateway** | Model access for Mastra planning/tool calls | **$500 posted October 4**, separate from $500 main Neon credit; card attached; key/model connection and app request unverified | Connect and test within a card-safe usage boundary; never assume the $1 email alert is a hard cap |
| **Gemini direct API** | Real YouTube/video understanding and voice transcription | **No key configured; not a listed hackathon credit**; direct usage could bill separately | Use only after a funded/free-safe account is confirmed; keep honest sample/manual fallback meanwhile |
| **Exa** | Multi-store product and merchant discovery | **$69.97 remaining**, Free tier, no card; key connected and basic search tested | Candidate generation; never treat results as verified prices/stock |
| **Kernel** | Isolated retailer browsers, cart actions, live user takeover | **$55 free credit remaining**, no card; scoped key connected; only a temporary store open tested | Build 2–3 merchant adapters and rehearse real item/price/cart matching; delete sessions after use |
| **AgentMail** | Receipt/order-confirmation inbox and webhook evidence | Developer trial through **Nov 3**, no card; 1 inbox; 10 inboxes/10k emails monthly allowance; webhook code exists but needs public HTTPS API | Match actual receipt/order IDs and delivered items after deployment |
| **Fly.io** | Public API hosting for phone + AgentMail webhook | **$500 credit posted**, $0 upcoming invoice, 0 apps; card auto-charging is enabled | Keep undeployed until a hard-enough spend boundary is verified; local development continues |
| **Executor** | Optional development-time MCP/tool gateway | Free, **0/100,000 executions** used; no card | Use only if it removes integration work; no runtime dependency required |
| **CodeRabbit** | Optional code review | $1,000 usage-credit claim details still pending | Review final diff if available; not on the shopping runtime path |

Neon Object Storage/Functions are advertised on the stack but are **not wired** in Aeri. Private short-lived video storage and background jobs are potential uses once their availability and billing boundary are verified. We will not consume Neon/Fly card-backed services on the assumption that a posted credit prevents charges.

## Build sequence and acceptance gates

| Order | Deliverable | Done when |
| --- | --- | --- |
| **P0 — typed shopping model** | `ShoppingRequest`, `ProductSpec`, `Offer`, `Basket`, `MerchantCart`, `CheckoutSnapshot`, `Approval`, `Order`, and inventory evidence/event schemas; migrations from current state | Hard filters, unit conversion, fees, unknown values, and order state transitions have deterministic tests |
| **P1 — comparison engine** | Exa candidate discovery; location/store selection; 2–3 merchant adapters via Kernel; basket scoring and quote freshness | A real, small request produces two independently verified merchant options with source URLs/timestamps; “cheapest” uses all-in cost and “nearest” uses a stated distance measure |
| **P2 — video memory v2** | Recipe/video evidence, kitchen change reconciliation, confirm/correct UI, stale inventory rules; voice updates reuse same memory service | A kitchen clip changes no inventory until reviewed; a correction affects the next comparison; original evidence remains traceable without retaining raw video by default |
| **P3 — cart and purchase boundary** | Fill chosen merchant cart; compare it with approved plan; final-total approval token; controlled submit adapter or user takeover | Cart discrepancies trigger reapproval; duplicate retries cannot cause duplicate purchases; no order is shown without confirmation. Test submission with a mock merchant first, then a real merchant only with a user-approved purchase |
| **P4 — receipts and delivery** | AgentMail matching, order status, fulfilled-item reconciliation | Receipt and delivery update the correct order; only confirmed delivered items enter memory |
| **P5 — demo and deployment** | On-device walkthrough, logs/evidence, public API only if card-safe | One honest path works end to end: fridge video/voice -> recipe or item request -> two store quotes -> choice -> cart -> final approval/handoff -> order evidence -> updated memory |

**First engineering slice:** P0 plus the start of P1. Remove the global `KERNEL_RETAILER_URL` assumption from the domain model, keep it only as one adapter configuration, and build a comparison screen backed by normalized offers. This is the smallest change that makes Aeri a multi-retailer agent rather than a single-store list opener.

**Spend rule:** No real purchase, paid API activation, or Fly deployment is part of this plan by default. Mock/fixture tests and local UI work are safe to complete now. Before any live order, the user must review the exact final charge and merchant terms; before any card-backed infrastructure, verify a spending control that actually prevents charges beyond the intended credits.
