# CLAUDE.md

Context for AI coding agents (Claude Code and others) working in this repo.

## Read first
1. `docs/GUIDELINES.md` — what MonsoonWatch is, the sponsor features we must use, data sources, video plans.
2. `docs/IMPLEMENTATION.md` — workstreams, shared contracts, checkpoints.

If these files and the code disagree, ask the human before changing either.

## Project in one paragraph
MonsoonWatch is a 3D early-warning system for monsoon regions (landslides upstream, floods downstream), demoed on the Kelantan valley, Malaysia. Live JPS river/rain data and a Dec 2014 replay flow into MongoDB Atlas; Stream Processing detects threshold crossings; a Gemini 4 Argon orchestrator with Flash subagents drafts evacuation alerts that deterministic code verifies; a human approves; Saint coordinates the response. A Three.js control room shows everything, including a "Tech HUD" naming which sponsor feature did each step. Built at Encode London 2026 for the Google DeepMind, MongoDB and Saint bounties.

## Workstream ownership
Ask the human which workstream they own before large changes, and stay inside it:
- **A — 3D & Frontend:** `apps/web/**`
- **B — Agent & Gemini:** `apps/api/src/agent/**`, `apps/api/src/routes/agent*`, `apps/api/src/routes/alerts*`, `apps/api/src/routes/voice*`
- **C — Data, MongoDB & Saint:** `apps/api/src/db/**`, `apps/api/src/routes/**` (others), `scripts/**`, `docs/**`, `README.md`
- **Shared (needs all three to agree):** `packages/shared/**` — do not edit types, event names or fixtures without being told the team agreed. If you change a contract, update the fixtures in the same change.

## Commands
```
pnpm install
pnpm dev          # web + api, real services (needs .env)
pnpm dev:mock     # MOCK=1: fixtures + scripted SSE, no keys needed
pnpm seed         # load stations, villages, centres, 2014 replay
pnpm typecheck    # must pass before every commit
```
Prefer `pnpm dev:mock` when working on UI or agent flow without live services.

## Hard rules
- **No secrets in code or commits.** Read config from `process.env` / `import.meta.env`. Update `.env.example` (empty values) when adding a variable.
- **All code is written during the hackathon.** Don't paste code from other projects. Libraries are fine.
- **No external action without human approval.** Messages, alerts and purchases go through the approval flow and are logged.
- **Every sponsor-feature call emits an `AgentStep`** (actor, summary, status, latency) so it appears in the Tech HUD.
- **Honesty in the UI:** label reconstructed data, the landslide screening model and approximations; show uncertainty.

## Gemini (`@google/genai` ≥ 2.3.0)
- Use the **Interactions API** (`client.interactions.create`) via the wrapper in `apps/api/src/agent/gemini.ts`. Don't call the SDK directly elsewhere.
- Use `thinking_level` (`"low" | "medium" | "high"`). **Never** set `thinking_budget`, `temperature`, `top_p`, `top_k` or explicit `cached_content`. Use `background: true` for outputs over 65,536 tokens.
- Model IDs (exact): `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`, `gemini-3.8-live`, `gemini-3.8-flash-tts`, `deep-research-preview-04-2026`, `antigravity-preview-09-2026`, `gemini-nano-banana-2.1`.
- **Don't guess API shapes.** Use the `gemini-api-dev` / `gemini-live-api-dev` skills or the official docs. If unsure, say so.
- Validate structured outputs with zod; on failure, retry once, then surface the error.

## MongoDB Atlas
- Index definitions and stream processors are **files in the repo** (`apps/api/src/db/indexes/*.json`, `apps/api/src/db/stream-processors/*.js`), applied by `apps/api/src/db/setup.ts` (idempotent).
- **Don't invent syntax** for Atlas Search, Vector Search, `$rankFusion`, automated embedding, Stream Processing or Voyage. Check current MongoDB docs; flag anything unverified with a `// VERIFY:` comment.
- `raw_readings` is a time series collection. GeoJSON order is `[lon, lat]`. Geo fields need `2dsphere` indexes.
- All live UI updates come from **change streams → SSE** (`GET /api/stream`). Don't add a second push path.

## Data
- JPS endpoints return **HTML tables**, not JSON — parse with `cheerio`. `-9999.0` means missing. Check `Last Updated` for stale stations.
- GloFAS discharge (m³/s) ≠ JPS water level (m). Any conversion is an approximation and must be labelled.
- Cache external data in MongoDB; the demo must work if external sites are down.
- URLs and verified details are in `docs/GUIDELINES.md` §4.

## Code style
- TypeScript strict. Shared types from `@monsoonwatch/shared`. Units in names where ambiguous (`levelM`, `rainMm`, `etaHours`).
- MongoDB collection names only via `COLLECTIONS` from `@monsoonwatch/shared`. API errors only via `HttpError` (shape `ApiError`). Contract decisions: `docs/IMPLEMENTATION.md` §1.6.
- Small, focused files; pure functions for verification and landslide logic (easy to test).
- Three.js: dispose geometries/materials on layer removal; keep 60 fps on a laptop; all lng/lat ↔ world conversion through the shared helpers.

## When finishing a task
- Run `pnpm typecheck`.
- Say what you changed, what you didn't verify (especially Gemini/MongoDB API details), and anything another workstream must know.
- Keep commits small, with clear messages.
