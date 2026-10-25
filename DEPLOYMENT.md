# Render deployment

Deploy one Node web service to serve apps/web/dist and the Fastify API from the same origin. No separate Vercel project, reverse proxy or Docker installation is needed.

Live service: **https://monsoonwatch.onrender.com** — one link for the submission. The same service serves:

- `/` — the resident app
- `/control/` — the officials' console (the build writes `apps/web/dist/control/index.html`; there is no link to it from the resident app)
- `/api/...` — the API (and `/api/stream`, SSE)

`pnpm dev` runs Vite (5173) and the API (8787) as two processes for development only; deployment is a single service.

## Settings

- Repository: https://github.com/Hermela007/MonsoonWatch
- Branch: `main` (the team's merged work; `a/terrain-flood` is merged into it)
- Root directory: leave empty (repository root)
- Language/runtime: Node
- Region: Frankfurt
- Compute: smallest paid web instance (0.5 CPU / 512 MB; currently $7/month, billed by runtime). Keep the workspace on Hobby. Confirm the price shown before enabling it.
- Build command: `corepack pnpm install --frozen-lockfile --prod=false && corepack pnpm typecheck && corepack pnpm build`
- Start command: `node --import ./apps/api/node_modules/tsx/dist/loader.mjs apps/api/src/index.ts`
- Health check: `/api/health`
- One instance, manual deploys: after the final push to `main`, open the service in Render → Manual Deploy → "Deploy latest commit", then run the checks below.

The equivalent service settings are recorded in render.yaml for Blueprint deployments. Creating a normal Web Service requires entering these values manually.

## Environment

Set these on Render, never in committed files:

```text
NODE_VERSION=22.21.0
NODE_ENV=production
MOCK=0
REGION_ID=kelantan
PUBLIC_DEMO=1
AGENT_AUTO_RUN=0
MONGODB_DB=monsoonwatch
MONGODB_URI=<team Atlas connection string>
```

Render supplies PORT automatically; it takes precedence over API_PORT. TypeScript source runs through the installed tsx loader, so the build explicitly retains dev dependencies.

PUBLIC_DEMO=1 blocks every API mutation (including replay, agent runs, approvals) before route execution and disables automatic risk-triggered runs. The frontend shows a public-demo notice and disables operator buttons. The `?mock=1` walkthrough remains an explicitly labelled local script; it does not spend Gemini credits or send messages. A Gemini API key is not needed for this restricted public deployment. Keep it on B's private/local operator setup until paid runs are deliberately enabled.

Atlas needs to allow the Render service's outbound IP ranges. Use the service's Connect/Outbound information in Render and add those ranges to Atlas Network Access; do not open access to all internet addresses just to bypass a connection error.

## Verify the deployed link

- `/` renders the valley with no Residents / Control room switch; `/api/health` returns ok=true, mock=false and readOnly=true.
- `/control/` opens the officials' console (dark top bar, "MonsoonWatch CONTROL · Kelantan district · Officials only"). A 404 here means an old build is deployed.
- `/api/regions/kelantan/villages` returns the team data after Atlas networking is configured.
- `/api/stream` remains an SSE response; controls stay restricted in normal mode.
- `/control/?mock=1` → Run the agent now plays the labelled scripted verification and approval flow (the link to give judges for trying approvals on the public site).
- POST /api/agent/run and POST /api/alerts/test/approve return 403 in public-demo mode.

Terrain comes from AWS tiles in the browser, so the first map load still depends on that network connection. Paid compute avoids Render's free-tier inactivity sleep; it does not eliminate network or model latency.

## Stop ongoing charges after judging

After the judging window, downgrade the service to Free (accepting inactivity sleep), suspend it, or delete it through Render. Verify the billing dashboard afterward. Existing usage remains payable; MongoDB and Gemini have separate billing. Changing the workspace plan alone does not downgrade a paid service's compute.
