# Deploying Aeri's server to Fly.io

Running the server on Fly.io gives the app a stable HTTPS address and lets AgentMail deliver order emails by webhook.

## Cost and limits

- One always-on shared-CPU machine with 1 GB of memory (about $6 a month). It stays on because shopping runs finish in the background and store sign-in checks run every two minutes. For a personal server you can set `min_machines_running = 0` and `auto_stop_machines = "stop"`.
- One 1 GB volume for Aeri's data (about $0.15 a month). With the file store, run exactly one machine; to run more, set `DATABASE_URL` (Postgres) first.
- Fly has no hard spending cap. Set a usage alert in the Fly dashboard (Billing → Alerts) before deploying.
- Kernel browser pools are off on Fly (`KERNEL_POOLS=0`) because a warm browser is billed while it waits.
- Per-person daily limits (`AERI_USER_DAILY_AI_REQUESTS`, `AERI_USER_DAILY_BROWSER_RUNS`) and server-wide ones keep model and browser costs bounded. Each person's Aeri email address is one AgentMail inbox on your plan.

## Steps

1. Install the CLI and sign in: `brew install flyctl`, then `fly auth login`.
2. Create the app: `fly apps create aeri-<your-name>`, then `cp fly.template.toml fly.toml` and set `app` to that name.
3. Create the data volume in the same region: `fly volumes create aeri_data --size 1 --region sjc`.
4. Copy secrets from your local `.env` (never commit them). `AERI_SECRET` must be at least 32 random characters and must not change (`openssl rand -hex 32`):
   `fly secrets set AERI_SECRET=… AERI_OWNER_EMAIL=… APP_ACCESS_TOKEN=… AERI_SUPPORT_EMAIL=… EXA_API_KEY=… KERNEL_API_KEY=… NEON_AI_GATEWAY_TOKEN=… NEON_AI_GATEWAY_BASE_URL=… NEON_AI_GATEWAY_MODEL=… NEON_AI_GATEWAY_VISION_MODEL=… NEON_AI_GATEWAY_VIDEO_VERIFIED=1 NEON_AI_GATEWAY_AUDIO_VERIFIED=1 NEON_AI_GATEWAY_DAILY_REQUEST_LIMIT=500 AGENTMAIL_API_KEY=…`
   Leave `DATABASE_URL` unset to keep using the volume rather than Neon Postgres.
5. Deploy: `fly deploy`. Check `https://aeri-<your-name>.fly.dev/health` returns `{"ok":true}`.
6. Order emails: in the AgentMail console create a webhook for `message.received` pointing to `https://aeri-<your-name>.fly.dev/webhooks/agentmail`, then `fly secrets set AGENTMAIL_WEBHOOK_SECRET=<its signing secret>`.
7. Build the app against it: `cd apps/mobile && EXPO_PUBLIC_API_URL=https://aeri-<your-name>.fly.dev eas build --profile production --platform ios`, then `eas submit` for TestFlight. Production builds refuse a non-HTTPS server and drop the local-network permissions.
8. Optional: `fly secrets set SENTRY_DSN=…` for error reports, `AERI_ADMIN_EMAILS=you@…` for `/v1/sites`, and `AERI_REVIEW_EMAIL`/`AERI_REVIEW_CODE` for App Store review.

Store sign-ins (Kernel Managed Auth), sign-in health checks and the Config Registry live at Kernel, so they keep working unchanged. To move existing local memory, copy `.data-preview/expo-live/state.json` into the volume with `fly ssh sftp shell` (put it at `/data/state.json`).
