# MonsoonWatch

3D early-warning system for monsoon regions (landslides upstream, floods downstream), demoed on the Kelantan valley, Malaysia. Built at Encode London 2026.

> Full README comes later. Project docs: [`docs/GUIDELINES.md`](docs/GUIDELINES.md) · [`docs/IMPLEMENTATION.md`](docs/IMPLEMENTATION.md) · [`CLAUDE.md`](CLAUDE.md)

## Setup

Needs Node 20.19+ (or 22.12+) and pnpm (`corepack enable`, or `npm i -g pnpm`).

```bash
pnpm install
cp .env.example .env   # fill in keys (not needed for mock mode)
pnpm dev:mock          # fixtures + scripted live events, no keys needed
pnpm dev               # real services
pnpm typecheck         # must pass before every commit
```

Web: http://localhost:5173 · API: http://localhost:8787/api/health

## Layout

| Path | What | Owner |
|---|---|---|
| `apps/web` | Vite + Three.js control room and resident page | A |
| `apps/api/src/agent`, `routes/agent*`, `routes/alerts*`, `routes/voice*` | Gemini agent, alerts, voice | B |
| `apps/api` (rest), `scripts/`, `docs/` | Data, MongoDB, live events, Saint | C |
| `packages/shared` | Shared types, live event names, fixtures — change only with all three agreed | All |
