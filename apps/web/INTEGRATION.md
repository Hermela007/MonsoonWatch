# Frontend/backend integration

The A branch includes origin/main at ce316b6 (checked 24 October 2026). The integration changes stay in apps/web; Shared contracts are unchanged. Deployment adds static frontend serving, Render port support, and a public-demo write guard in the API.

## Run and check

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm dev
corepack pnpm typecheck
corepack pnpm --filter @monsoonwatch/api test
corepack pnpm --filter @monsoonwatch/web test:integration
corepack pnpm --filter @monsoonwatch/web build
```

If your global pnpm tries to replace node_modules, use Corepack to select the pinned pnpm 10.34.8.

Open http://localhost:5173. The control room should say Live after the health check and SSE connection. An unreachable API displays “API disconnected” and disables actions; it never silently runs a demo. `?mock=1` explicitly selects the scripted frontend demo. `pnpm dev:mock` also selects that script through the health endpoint's `mock` flag; the backend does not provide mock fixtures for all C routes.

## Connected workflow

- API villages, evacuation centres and live stations load when SSE connects, and reload after reconnect. Live river events update marker colours and gauge counts; replay readings do not overwrite live gauges.
- Play the replay calls C's POST /api/replay/start from 18 December 2014 at 30 seconds/day. Stop calls /api/replay/stop. replay.tick and /api/replay/status drive the control-room clock. This uses the real database/stream-processing pipeline. Starting a replay resets prior replay risk events as implemented by C; coordinate with teammates sharing that database.
- Run the agent now calls B's /api/agent/run. When a replay timestamp is present it supplies mode=replay and at=that timestamp; otherwise mode=live. B's backend automatically starts runs on risk events. No frontend stage threshold starts real runs.
- agent.step populates the HUD; alert.updated adds/updates an alert without replacing the alert under review. The picker selects each village/centre allocation; its route updates the map. Both language messages, verification results and pickup order are visible.
- Approve sends approvedBy; reject sends rejectedBy. Decisions disable during requests, and errors stay visible. Successful approval creates a queued Saint task through B's backend; queued does not mean delivered.
- A started manual run is reconciled with GET /api/agent/runs/:id every five seconds, recovering missed steps/alerts and exposing asynchronous failures. SSE remains the only push transport. Full-page reload recovery of older alerts and auto-triggered runs needs a backend listing endpoint; the current backend only retrieves a known run ID.
- Real Saint tasks display their backend status. Task approval buttons exist only in scripted mode until C supplies a decision endpoint.

## Verified locally

Workspace typecheck, production frontend build, backend unit tests, and frontend HTTP/stream regression tests. The HTTP tests call the real Fastify routes through injection with an in-memory agent store: approval identity, duplicate approval conflict, rejection, validation errors, run retrieval, and replay routing. No external messages are delivered by tests.

The running real API returned health mock=false and 765 villages from MongoDB. The repository .env now has MONGODB_URI and GEMINI_API_KEY configured. STREAM_PROCESSING_URI is still missing. A fresh process ran B’s hello-argon.ts smoke test on 24 October 2026: Gemini returned HTTP 429, “Rate limit exceeded for model gemini-4-argon (limit: 0 requests per day on Free Tier).” After the key was replaced, a second fresh-process test returned HTTP 429: “Your billing account has exceeded its monthly spending cap.” The latest blocker is the Google billing account’s monthly cap; the real agent workflow remains unverified. The existing API process may need a restart after changing .env; its environment has not been reloaded by these checks.

## Remaining release gates

1. B: resolve the Google billing account’s monthly spending cap using the intended hackathon project/credits, restart the API with the updated configuration, and complete one real run. C: verify Atlas processors are running (the missing local STREAM_PROCESSING_URI is needed to manage them, not proof they are stopped). Then exercise replay → risk → agent → verify → real alert in the UI together.
2. C/B: /regions/:id/hazards, /search, /voice/session, and Saint delivery/decision routes are not registered in the current server. The map retains the labelled local reconstructed 2014 model; it does not represent live API hazard predictions. Local place search still works; Atlas search is not implemented by this branch.
3. Human duty officer: approve a verified test alert after confirming the intended delivery destination. Verify the resulting queued task and actual delivery separately. These integration checks have not sent a real alert.
4. Hosting: serve apps/web/dist, proxy /api/* to the Fastify service, preserve SSE streaming (no proxy buffering; allow long-lived connections), and keep environment secrets on the server. Static hosting alone cannot run the API. PUBLIC_DEMO=1 now blocks all API writes and automatic agent runs for the public deployment. Authenticated operator access remains future work. Render has been selected for a single frontend/API web service; see DEPLOYMENT.md.
5. Terrain still downloads AWS Terrarium tiles on a cold load. Cache/bake terrain for a reliable offline event demo. The web build reports a >500 kB JavaScript chunk; performance should be checked on the presentation laptop.

## Saint C8 integration

The A branch now includes origin/main through b92fc72 and C8 from origin/c/saint (21b48ca); C8 was not yet on the fetched main when integrated. The control room loads existing tasks and listens for saint.task and evac.updated. A queued send_alert task offers Send to Saint: fetch the handoff, open its WhatsApp link in a reserved tab, then acknowledge the handoff. The operator still sends the message in WhatsApp; opening it is not delivery confirmation. If no link is configured, a copyable brief and explicit manual-handoff confirmation are shown. Set SAINT_WHATSAPP on the operator server to enable the link.

Paste Thea’s report (including MW CHECKIN lines), enter the duty officer, and Apply report to see applied/skipped/errors. Pasted text is retained on errors. Public-demo mode disables these mutations; no deployment restriction was relaxed. Supply orders are drafts awaiting approval, never placed.

Regression checks: web test:integration includes Saint request/error cases. Visit /tests/saint-preview.html on the Vite dev server for isolated browser checks with simulated API and popup responses; no real messages are sent. This test page is not part of the production dist build.
