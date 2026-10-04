# Hackathon account handoff — October 4, 2026

This records what was visible in the signed-in sponsor dashboards during setup. It is an operational snapshot, not proof that the event credits were redeemed. Never commit provider keys or database URLs; keep local values in the ignored `.env` and production values in Fly secrets.

| Service | Current account state | What remains |
| --- | --- | --- |
| Neon | Project `Aeri Hackathon` (`long-wave-43435458`) exists on the Free plan in AWS Ohio. The production Postgres connection has been tested locally and is stored in the ignored `.env`. | Claim event database and AI Gateway credits when enabled. The Gateway currently prompts for a paid-plan upgrade, so do not upgrade merely to finish setup. Add the Gateway key and host only after the credit terms are clear. |
| Fly.io | Personal organization `kathan-desai` has zero apps, a `0/0` Machine limit, **$0.00 credit balance**, and billing status **Requires a credit card**. | The owner must resolve the payment-method/account unlock and redeem Fly event credit before an app or public webhook endpoint can be deployed. Then create one API app, set secrets, and deploy from the root `Dockerfile` using `fly.template.toml`. |
| Kernel | Hackathon organization, Default project `j20xhx15aj6dnqp9glpab4gm`. With the owner's approval, a 30-day `aeri-hackathon` key was created for that project and stored in the ignored `.env`. A temporary browser opened Instacart successfully and was deleted. Billing showed $5 free credit and a $0.05 draft monthly bill after these smoke tests, with no payment method. | Claim the event credit when enabled. Rehearse an approved cart with a real store account and delivery location; verify exact products and quantities before checkout. |
| Exa | The Build with API / E-commerce onboarding was completed; the dashboard reported $10 free credit. Its existing key is stored in the ignored `.env`; live product search and the app's cart-research endpoint returned real HTTPS product links. | Claim the event credit when enabled. Check that product suggestions match the chosen retailer, stock and price during the live demo. |
| AgentMail | Inbox `kathan-8985@agentmail.to` exists; no webhook is configured. | Once Fly has a public HTTPS URL, add a `message.received` webhook targeting `https://<app>.fly.dev/webhooks/agentmail`, then set the returned signing secret as `AGENTMAIL_WEBHOOK_SECRET`. Forward a test receipt and verify it appears as evidence in the app. |
| Executor | The signed-in workspace has the default Executor integration; no task-specific connection was configured. | Optional development/orchestration tool. The mobile app and API do not need an Executor key at runtime. Avoid connecting unrelated accounts to it. |

The hackathon stack page still showed the sponsor claim controls disabled during the October 4 hacking stage, with a note that hacker credits unlock in person. The advertised amounts are offers, not available account balances. Recheck and claim each offer at the event before assuming a provider is funded.

## Deployment sequence after Fly is unlocked

1. Create one Fly app in `kathan-desai` using a unique name; copy `fly.template.toml` to `fly.toml` and set that name. The template uses one shared-CPU Machine with 1 GB RAM. Its HTTP service stops the Machine when idle and starts it on the next request, keeping compute usage low. Expect a cold start after idle; rehearse the demo shortly before presenting. If memory measurements permit, 512 MB can reduce cost further.
2. Store `APP_ACCESS_TOKEN` and `DATABASE_URL` as Fly secrets. Add provider secrets only as they become available. Keep the mobile build's API base URL pointed at the new `https://<app>.fly.dev` endpoint.
3. Deploy the root `Dockerfile` and verify `GET /health`, then authenticated `GET /v1/bootstrap`. The response should report `providers.neon=true` and accurately reflect each configured provider.
4. Configure AgentMail's signed webhook only after the HTTPS endpoint works. Verify one forwarded receipt. Run one Exa search and one approved Kernel cart attempt; checkout stays with the user.
5. Check Fly usage and event-credit balance after rehearsal. The API has no persistent volume; Neon holds state. Fly's idle stop lowers compute spend but still incurs root-filesystem and any outbound-data charges.

Fly's [autostop/autostart guide](https://docs.fly.io/reference/fly-proxy-autostop-autostart) confirms that stopped Machines restart on incoming requests. Its [pricing page](https://docs.fly.io/about/pricing) confirms compute charges stop while the Machine is stopped, while root filesystem usage remains billable.
