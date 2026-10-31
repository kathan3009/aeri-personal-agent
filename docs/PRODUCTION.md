# Production readiness

What Aeri does for people other than its owner, how it keeps them apart, and what is still left before a wide launch.

## Ready

**Accounts and privacy**
- Anyone signs in with their email and a 6-digit code (no passwords). Codes are single use, expire in 10 minutes, lock after five wrong tries and are rate-limited per email and per network address. Codes and session tokens are stored only as hashes; sessions last 90 days while used and end on sign-out or account deletion.
- Every request reaches only the signed-in person's own data: memory, lists, carts, files, store sign-ins (Kernel profiles named per person) and email. Video frames are served only to the person who made the scan.
- Settings has **Download my data** (a JSON export) and **Delete account** (type your email to confirm). Deletion closes open store browsers, removes the person's store sign-ins and profiles at Kernel, deletes their Aeri inbox, frames and data, and signs them out everywhere.
- `/privacy` and `/terms` are served by the API and linked from sign-in and Settings. Creating an account requires accepting them.
- The owner (`AERI_OWNER_EMAIL`) keeps everything from before accounts: memory, store sign-ins and their existing Aeri address.

**Email (AgentMail)**
- Sign-in codes come from `aeri-sign-in@agentmail.to`.
- One tap in Settings gives a person their own address (for example `ana-aeri-3f9c@agentmail.to`) for order emails and store sign-in codes. Mail is routed by inbox; mail for an unknown inbox is ignored. Codes are read only from that person's inbox, only from the store's own domain and only for a sign-in they started.

**Shopping agent**
- Finds stores on the open web (Exa), not from a fixed list. When a store limits it (bot checks, hidden add buttons, missing items), it reports that, moves to the next store from the comparison, and searches the web for more stores when those run out. It may not give up on an item while an untried store remains.
- "Added" needs the store's own evidence: a cart count that rose after Aeri pressed an add button (against a starting count read after the account loaded), the store's own in-cart controls for that product, or the store saying it was added. Nothing is checked out or paid; checkout, payment, account and address pages are off-limits in code.
- Guest carts (stores the person hasn't connected) say they live in Aeri's private browser and must be finished within 20 minutes.

**Limits and cost control**
- Per person per day: AI requests (`AERI_USER_DAILY_AI_REQUESTS`, default 200) and store visits (`AERI_USER_DAILY_BROWSER_RUNS`, default 12), plus server-wide caps. One store cart at a time per person.
- Per-person request rate limits (300 a minute; 30 a minute for AI and browser routes).
- Signed-in browser pools are per person and off by default; guest pools are shared and hold no personal data.

**Traceability**
- Every store visit has a run id. Each agent step (what it opened, searched, pressed, recorded, and why something failed) is kept on the cart as a readable trace ("What Aeri did" in Tasks) and logged as `agent.step` / `agent.run` JSON lines with that id. A failed visit shows "reference <id>" to the person, and the same id tags the Sentry report.
- Items that weren't added carry a reason (age check, sign-in, address, bot check, store limited, out of stock, not found, minimum order, quantity limit). Age checks, sign-in walls, address prompts and order minimums are read from the page itself, not left to the model to notice.
- Anything only the person can do becomes a prompt on the cart and a task: confirm they're 21 or older (Aeri never confirms age for them until they do; then **I'm 21 or older, add it** finishes those items at the same store), sign in to the store, or set a delivery address. Added alcohol gets "Have your ID ready" for delivery. **Try the remaining items again** retries the rest; a guest cart continues in its own browser.

**Operations**
- Structured request logs (person shown only as a short hash) and optional Sentry error tracking (`SENTRY_DSN`), with request bodies, cookies and authorization headers stripped.
- Graceful shutdown waits briefly for background work. Production refuses to start without a strong `AERI_SECRET`.
- CI installs ffmpeg, typechecks, runs every test and exports the iOS bundle.
- Production app builds (`eas build --profile production`) require an HTTPS server and drop local-network and cleartext permissions.

## Left before a wide launch

1. **Deploy the server** (`docs/DEPLOY.md`). Not done yet, by choice.
2. **Postgres.** The per-person store and accounts work with `DATABASE_URL`, but only the file store has been exercised end to end. Run the test suite against a Neon branch before more than one machine or many people.
3. **App Store.** Needs an Apple Developer account, an EAS production build, TestFlight, and an App Review sign-in (`AERI_REVIEW_EMAIL`/`AERI_REVIEW_CODE`).
4. **Legal review.** The privacy policy and terms describe what the code does but haven't been reviewed by a lawyer. Several stores' terms restrict automated shopping on a person's account; prefer official routes (Instacart Developer Platform, Amazon cart links) where they exist.
5. **Store coverage.** Instacart and Walmart (guest) work end to end. Target currently limits automated sessions at its data API (HTTP 435), and the agent moves on. Check each store you promise, and watch `/v1/sites`.
6. **Email capacity.** Each person's address is one AgentMail inbox; check your AgentMail plan's inbox limit. Gmail forwarding is set up by each person (the app walks them through it).
7. **Several machines.** Rate limits and usage counts are per machine (the usage ledger is a file). Fine for one machine; move them to Postgres or Redis before scaling out.
8. **Phone crash reporting.** The server reports errors; the app doesn't yet (add `@sentry/react-native` with a development build).
