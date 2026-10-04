# Hackathon credit and account snapshot — October 4, 2026

This is a read-only snapshot of the signed-in billing dashboards. Neon was refreshed at ~11:35 AM PDT; the other providers were checked at ~11:20 AM PDT. A claim link or redemption code on the [hackathon stack](https://build-personal-agents.com/stack) is not proof that credit has posted. Do not run billable API tests, deploy, upgrade, or start a paid plan solely because an offer is listed. Provider keys and database URLs stay in the ignored local `.env`, never in Git.

| Service | Confirmed in the account | Current constraint |
| --- | --- | --- |
| [Neon](https://console.neon.tech/app/org-sparkling-resonance-11984110/billing) | **$500.00 main credit balance** and **$500.00 separate AI Gateway balance**; Gateway history shows $500 granted October 4. $0.00 charged so far; Launch plan with a card attached. The `Aeri Hackathon` Postgres project exists and the local API has read from it. | The $1 spending notification is an email alert checked every 15 minutes, not a hard spending cap. Posting credit does not by itself prove the attached card cannot be charged after credits are exhausted. Gateway verification was pending at this original audit; see the later implementation addendum below. |
| [Fly.io](https://fly.io/dashboard/kathan-desai/billing) | **$500.00 credit balance**, 0% used, $0.00 upcoming invoice, 0 apps and 0/20 Machines. Account is in good standing. | A payment method is set to charge automatically. No app has been deployed; do not start usage until card-charge exposure is understood and constrained. |
| [Exa](https://dashboard.exa.ai/billing) | **$69.97 remaining** on Free tier; no card. The dashboard shows a $9.97 tranche expiring November 1 and a $50.00 tranche expiring November 3. Its existing key is configured locally, and product search has been live-tested. | The dashboard does not label the $50 tranche's source. The displayed expiring tranches do not explain the entire total; do not infer an expiry for the remaining $10. |
| [Kernel](https://dashboard.onkernel.com/hackathonevent/billing?project=j20xhx15aj6dnqp9glpab4gm) | **$55.00 free credits remaining**, $0 used, no payment method, and no running browser sessions. A 30-day key scoped to the Default project is configured locally; a temporary Instacart browser was opened and deleted. | The dashboard does not split the $55 by base versus sponsor credit. A live authenticated cart rehearsal remains. |
| [Mastra](https://projects.mastra.ai/orgs/org_01M43WZNEBCQNES6BGNABT3MB9/settings/billing) | **$0 credits available**; Starter plan at $0/month, auto top-up off. The stack page shows a redemption code, but no sponsor credit has posted. | No Mastra project is set up. The app uses the open-source Mastra framework locally; a hosted Mastra account is optional for this build. |
| [AgentMail](https://console.agentmail.to/dashboard/settings/billing) | Developer trial active through **November 3**, then reverts to Free; no card. Allowance is 10 inboxes and 10,000 emails/month; 1 inbox is in use. | The receipt webhook needs a public HTTPS API URL. Do not select a paid continuation. |
| [Executor](https://executor.sh/kathan-desai-s-organization/billing) | Free plan; **0/100,000 executions** used this month, 1/3 members, no card. | Optional development tool; the mobile app and API have no Executor runtime dependency. |

The stack page now exposes claim links for Neon, Exa, Fly.io, Kernel, and AgentMail. It may still label the Neon AI Gateway request pending, but the Neon billing dashboard confirms the $500 grant. Mastra shows a code but its billing balance is still $0. CodeRabbit's $1,000 usage-credit claim details are still marked as coming soon. The $750 assistant-ui side quest is a prize, not an account credit.

## Card-safe deployment gate

The API container and idle-stop `fly.template.toml` are prepared, but **no Fly deployment has been made**. Both Neon and Fly have an attached payment method; their posted credits do not by themselves prove that future usage cannot reach the card. Before deployment, verify any hard usage or billing control with those providers and choose a usage plan that stays within the credits. Neon AI Gateway credit was posted; later prepaid Gateway verification is recorded separately below. This does not authorize main Neon compute or Fly card-backed use. AgentMail's signed receipt webhook can be configured after a public HTTPS API URL exists.

The API does not submit retailer payments. Kernel browser sessions are created only after a user approves a cart, and checkout remains with the user. The default retailer is Instacart; exact products, quantities, availability, and account login still need a live rehearsal.

## Usage added by live tests on October 4 (afternoon)

Development checks spent a small, unmeasured amount of Exa and Kernel credit; neither account has a card. That covered about 15 Exa searches and about 15 short Kernel browser sessions, all deleted, including one guest add-to-cart at Target with no checkout. No Gemini, Neon AI Gateway, Fly or AgentMail calls were made. Recheck the dashboards before relying on the balances above.


## Later Gateway and implementation verification — October 4, 2026

At approximately **1:39 PM PDT**, the Gateway showed **$500 prepaid credit** before the new tests. From approximately **1:45–1:55 PM PDT**, a branch-scoped, `ai_gateway:invoke`-only credential was created with the owner’s consent and kept solely in ignored `.env`. The current remaining Gateway balance has **not been refreshed after these requests**. Other provider balances in the table remain the earlier audit; do not treat them as current after subsequent usage.

Native `gemini-3-6-flash` returned HTTP 200 for synthetic inline 3-second video at 2 fps, PNG and a short YouTube input. SDK structured map/photo parsing passed; the synthetic clip contained no household objects. A generated spoken M4A transcribed exactly “I have six eggs in the fridge,” and the authenticated voice API saved six eggs. Live `gpt-5-4-mini` Mastra calls saved an Oatly preference and created a milk-and-shirts shopping draft. Gateway Files returned 404, so files are compressed and sent inline. Real household recognition and the phone microphone remain unverified.

The Gateway is prepaid; official documentation says automatic top-ups are unavailable. No manual credit purchase was made. Local request/output/tool-step controls reduce usage but are not a monetary billing cap. No card charge was authorized or initiated, no Fly deployment occurred, and API verification ran with `DATABASE_URL=` so it did not activate Neon compute or migrate live Postgres.

Managed Auth, Target store selection, supported quantity controls, final-summary reading, snapshot approvals and mock-only submission are implemented and mock-tested. No real retailer account was connected and no checkout/payment was submitted. Receipt matching and private TTL session persistence are built; public HTTPS/AgentMail signing-secret activation remain pending.
