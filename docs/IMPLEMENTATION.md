# MonsoonWatch — Implementation Guide

> How three people build MonsoonWatch **in parallel** and integrate it **iteratively**.
> Read `GUIDELINES.md` first (what we build and why). This file says **how** and **who**.

---

## 0. How parallel work stays unblocked

Three rules make this work:

1. **Contracts first.** Before anyone builds features, we agree the shared types, API routes, live events and database collections (§1). They live in `packages/shared` and change **only with all three people agreeing**.
2. **Everyone builds against mocks.** Each workstream ships a mock of what it provides (fixtures + `MOCK=1` mode), so the others never wait. Real code replaces mocks one piece at a time.
3. **Integrate at fixed checkpoints** (§5). Small, frequent merges beat one big merge on Sunday morning.

| Workstream | Owner | Provides to others | Consumes from others |
|---|---|---|---|
| **A — 3D & Frontend** | Person A | The UI: control room, approval buttons, Tech HUD, resident page | API routes + live events from B and C |
| **B — Agent & Gemini** | Person B | Agent runs, alerts, verification results, report analysis, voice | Readings, risk events, villages, centres, search from C |
| **C — Data, MongoDB & Saint** | Person C | All data, DB, search, stream processing, live events, Saint handoff, README/videos | Alert approvals from A, agent outputs from B |

---

## 1. Shared contracts (do this together, first hour, ~45 min)

### 1.1 Repo setup (Person C, 15 min, before contracts)
```
pnpm init  # pnpm workspaces
apps/web        # Vite + TypeScript + Three.js
apps/api        # Node + TypeScript + Fastify
packages/shared # types + zod schemas + event names + fixtures
scripts/        # one-off data scripts
docs/
```
- Root scripts: `pnpm dev` (runs web + api), `pnpm dev:mock` (`MOCK=1`), `pnpm seed`, `pnpm typecheck`.
- `.env.example` (commit) / `.env` (never commit):
```
MONGODB_URI=
MONGODB_DB=monsoonwatch
GEMINI_API_KEY=
VOYAGE_API_KEY=        # only if not using Atlas-integrated Voyage
API_PORT=8787
WEB_PORT=5173
MOCK=0
REGION_ID=kelantan
```
- Branches: `main` is always runnable. Each person works on `a/*`, `b/*`, `c/*` branches and merges via small PRs. Never push broken `main`.

### 1.2 Shared types (`packages/shared/src/types.ts`)
Use zod for each so the API validates at runtime. Units: metres, mm, m³/s, ISO timestamps (UTC), GeoJSON `[lon, lat]`.

```ts
export type LngLat = [number, number];

export interface Region {
  _id: string;                       // "kelantan"
  name: string;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  languages: string[];               // ["ms", "en"]
  timezone: string;                  // "Asia/Kuala_Lumpur"
  terrain: { heightmapUrl: string; widthPx: number; heightPx: number; metresPerPx: number; minElev: number; maxElev: number };
  glofasCells: { id: string; lngLat: LngLat; label: string }[];
  replay?: { label: string; start: string; end: string };  // "Dec 2014"
}

export type StationKind = "river" | "rain";
export interface Station {
  _id: string;                       // JPS station id (or generated if blank)
  regionId: string;
  kind: StationKind;
  name: string;
  district: string;
  basin?: string;
  location: { type: "Point"; coordinates: LngLat };
  thresholds?: { normal: number; alert: number; warning: number; danger: number }; // river only, metres
}

export interface Reading {
  ts: string;
  meta: { stationId: string; kind: StationKind | "glofas"; source: "jps" | "glofas" | "openmeteo"; mode: "live" | "replay" };
  value: number;                     // m (river), mm (rain), m³/s (glofas)
  rain6d?: number[];                 // rain stations: last 6 daily totals
}

export type RiskLevel = "normal" | "alert" | "warning" | "danger";
export interface RiskEvent {
  _id: string;
  regionId: string;
  ts: string;
  type: "river_threshold" | "rain_accumulation" | "landslide_screen" | "report_disagreement";
  stationId?: string;
  level: RiskLevel;
  value: number;
  threshold: number;
  message: string;                   // human-readable, shown in HUD
  source: "stream_processing" | "agent" | "report";
}

export interface Village {
  _id: string; regionId: string; name: string; altNames: string[];
  location: { type: "Point"; coordinates: LngLat };
  population: number; district: string;
}

export interface EvacCentre {
  _id: string; regionId: string; name: string;
  location: { type: "Point"; coordinates: LngLat };
  capacity: number; headcount: number; elevationM: number;
}

export interface Report {
  _id: string; regionId: string; ts: string;
  location: { type: "Point"; coordinates: LngLat };
  mediaUrl?: string; mediaType?: "image" | "video";
  text?: string;
  analysis?: { estDepthM: number; uncertaintyM: number; referenceObject: string; notes: string; model: string };
  // embeddings are added by Atlas automated embedding / Voyage — never sent to the client
}

export type CheckName = "threshold" | "route" | "capacity" | "freshness" | "language";
export interface VerificationResult { check: CheckName; passed: boolean; detail: string }

export interface Alert {
  _id: string; regionId: string; runId: string; villageId: string;
  level: RiskLevel;
  hazard: "flood" | "landslide";
  etaHours?: number;
  evacCentreId: string;
  route: { type: "LineString"; coordinates: LngLat[] };
  messages: { lang: string; text: string }[];
  verification: VerificationResult[];
  status: "draft" | "verified" | "approved" | "rejected" | "sent";
  approvedBy?: string; approvedAt?: string;
}

export interface AgentStep {          // one line in the Tech HUD
  _id: string; runId: string; ts: string;
  actor: string;                     // "Gemini 4 Argon" | "Gemini 3.8 Flash" | "MongoDB Stream Processing" | "Voyage rerank" | "Verification" | "Saint" ...
  kind: "plan" | "subagent" | "tool" | "verify" | "replan" | "db" | "saint" | "info";
  summary: string;                   // one line, shown in HUD
  status: "running" | "ok" | "fail";
  latencyMs?: number;
  tokens?: number;
}

export interface SaintTask {
  _id: string; alertId: string; ts: string;
  type: "send_alert" | "chase_reply" | "log_checkin" | "supply_order" | "sitrep";
  status: "queued" | "in_progress" | "awaiting_approval" | "done" | "failed";
  detail: string;
}

export interface Hazards {            // what the 3D scene draws for a given time
  regionId: string; ts: string; mode: "live" | "replay";
  water: { likelyLevelM: number; worstLevelM: number; byCell?: { id: string; levelM: number }[] };
  landslide: { cells: { lngLat: LngLat; risk: number }[]; runouts: { type: "LineString"; coordinates: LngLat[]; risk: number }[] };
  blockedRoads: { type: "MultiLineString"; coordinates: LngLat[][] };
}
```

### 1.3 REST API (`apps/api`, base `/api`)
| Method & path | Owner | Returns |
|---|---|---|
| `GET /regions` / `GET /regions/:id` | C | `Region[]` / `Region` |
| `GET /regions/:id/stations` | C | `Station[]` with latest reading attached |
| `GET /regions/:id/villages` · `/evac-centres` | C | `Village[]` · `EvacCentre[]` |
| `GET /regions/:id/geo` | C | OSM roads/rivers/buildings as GeoJSON |
| `GET /stations/:id/readings?from&to` | C | `Reading[]` |
| `GET /regions/:id/hazards?ts&mode` | C (B supplies landslide fn) | `Hazards` |
| `GET /search?q&type=place` | C | Atlas Search results |
| `GET /search?q&type=hybrid` | C | Hybrid + reranked results |
| `GET /reports/:id/similar` | C | Vector Search results |
| `POST /reports` (multipart) | C stores → B analyses | `Report` |
| `POST /replay/start` `{regionId, speed}` / `POST /replay/stop` | C | 202 |
| `POST /agent/run` `{regionId, riskEventId?}` | B | `{runId}` (also auto-triggered by risk events) |
| `GET /agent/runs/:id` | B | steps + alerts |
| `POST /alerts/:id/approve` · `/reject` | B (A calls it) | `Alert` |
| `POST /voice/session` | B | Live API session config/token for the browser |
| `POST /saint/updates` | C | 204 (for Saint or the shared-sheet sync) |
| `GET /stream` | C | **Server-Sent Events** (below) |

### 1.4 Live events (`GET /api/stream`, SSE)
Event names live in `packages/shared/src/events.ts`:
```
reading.new        { reading }
risk.event         { riskEvent }
hazards.update     { hazards }
agent.step         { step }           // Tech HUD
alert.updated      { alert }
report.new         { report }
evac.updated       { evacCentre }
saint.task         { task }
replay.tick        { ts }             // replay clock
```
Producers: C emits from MongoDB **change streams**; B emits `agent.step` / `alert.updated` (by writing to Mongo, so C's change stream relays it — **one path for all events**).

### 1.5 Fixtures (`packages/shared/fixtures/`)
Each owner commits realistic fixtures for what they provide, in the first 2 hours:
- C: `region.kelantan.json`, `stations.json`, `readings.sample.json`, `villages.json`, `evac-centres.json`, `geo.json` (small), `hazards.sample.json`.
- B: `agent-run.sample.json` (steps incl. one **fail → replan → pass**), `alerts.sample.json`, `report-analysis.sample.json`.
- A: none needed (consumer), but owns `apps/web/src/mock/` that replays fixtures as fake SSE.

`MOCK=1` makes the API serve fixtures and emit a scripted SSE sequence (C builds this in ~30 min; it is the most valuable 30 minutes of the weekend).

---

## 2. Workstream A — 3D & Frontend (Person A)

**Goal:** a polished, fast 3D control room where every visual carries data, plus approval UI, Tech HUD and a phone page. Effort cap: 3D ≈ 1/3 of team time.

### A1. Scaffold (Fri, ~1 h)
- Vite + TS + Three.js. Folders: `scene/`, `layers/`, `ui/`, `api/`, `mock/`.
- `api/client.ts` (typed fetch using shared types) and `api/stream.ts` (SSE client, typed by event name).
- **Done when:** app renders an empty scene and logs mock SSE events.

### A2. Terrain (Fri night)
- Load the region heightmap (from C's `scripts/build-terrain.ts` output; until then, decode one Terrarium tile in the browser: `elev = R*256 + G + B/256 - 32768`).
- `PlaneGeometry` displaced by height, vertical exaggeration ~1.5–2×, clean dark material, soft hillshade.
- Helper: `lngLatToWorld(lngLat)` and `worldToLngLat()` from `Region.bbox` — **every layer uses these**.
- Camera: orbit controls + `flyTo(lngLat, zoom)` with eased transitions.
- **Done when:** the Kelantan valley is recognisable and runs at 60 fps on a laptop.

### A3. Data layers (Sat AM)
- Rivers and roads (OSM lines draped on terrain), villages, evac centres (labels, capacity bar).
- Station pins coloured by `RiskLevel`; click → side panel with 6-day chart (C's readings).
- **Done when:** layers render from fixtures and update from `reading.new` / `risk.event`.

### A4. Flood layer (Sat AM)
- Water plane(s) from `Hazards.water`: depth-tinted shader (colour by depth = waterLevel − terrain), two layers (solid "likely", faint "worst case").
- Click a house/village → depth + ETA popup.
- 72-hour time slider calls `/hazards?ts=` (debounced).
- **Done when:** replay of Dec 2014 visibly fills the valley over time.

### A5. Landslide layer (Sat PM)
- Slope-risk heatmap draped on terrain from `Hazards.landslide.cells`.
- Animated runout lines (`runouts`) flowing downhill; highlight intersecting roads/houses.
- Label: "Screening tool — shows where to check first."

### A6. Agent theatre (Sat PM) — the demo centrepiece
- On `agent.step`: camera flies to the village being worked on; route `LineString` draws on terrain; village card shows subagent status.
- On `alert.updated`: in-scene alert card with messages (ms + en), **verification checklist** (green/red per `CheckName`), **Approve / Reject** buttons → `POST /alerts/:id/approve`.
- Make the **fail → replan → pass** visible (red tick turns green).

### A7. Tech HUD (Sat PM)
- Toggleable "Under the hood" panel listing `AgentStep`s: actor badge (sponsor colours), summary, latency, tokens. Fade-in animation, monospace, auto-scroll.
- This is how judges *see* the tech — keep it beautiful and readable in a 1080p recording.

### A8. Search, reports, voice, region switch (Sat evening)
- Search bar → `/search?type=place` (fuzzy), results fly the camera. Second tab for hybrid queries showing a "hybrid · reranked by Voyage" badge.
- Report pins; click → media, Gemini depth estimate ± uncertainty, "similar reports" list (Vector Search). Pulse if `risk.event` type `report_disagreement`.
- Voice button (uses B's `/voice/session`).
- Region dropdown → reload everything for another `Region`.

### A9. Resident page (Sat evening, `/resident`)
- Mobile-first, no heavy 3D (static map image or small 2D): your location, risk level, time until water, route, voice button, upload button (camera).

### A10. Polish & recording mode (Sun AM)
- `?demo=1`: hides dev UI, larger fonts, scripted camera presets for each video beat (keys 1–9).

---

## 3. Workstream B — Agent & Gemini (Person B)

**Goal:** a real, verified, multi-model agent that turns risk events into approved-ready alerts, plus multimodal report analysis and voice. Follow GUIDELINES §6.1 API rules exactly.

### B0. Setup (Fri, 30 min)
- `npm i @google/genai@latest` (≥ 2.3.0). Install the official skills for your coding agent: `npx skills add google-gemini/gemini-skills --skill gemini-api-dev` and `--skill gemini-live-api-dev`.
- `apps/api/src/agent/gemini.ts`: one thin wrapper around `client.interactions.create` that **logs every call as an `AgentStep`** (actor = model name, tokens, latency). Use `thinking_level`; never set temperature/top_p/top_k.
- **Done when:** a hello-world Argon call runs and appears as an `AgentStep` in Mongo (or in-memory in mock mode).

### B1. Tools for the agent (Fri night, against C's fixtures)
Plain TS functions the orchestrator can call (function calling):
`getRiskEvents`, `getLatestReadings`, `getVillagesNear(lngLat, km)`, `getEvacCentres`, `getBlockedRoads(ts)`, `getLandslideRunouts(ts)`, `searchKnowledge(q)` (C's hybrid search), `planRoute(from, to, avoid)`.
- Until C's DB is ready, tools read `packages/shared/fixtures`.
- `planRoute`: simple graph search over OSM road segments (from `/regions/:id/geo`) with blocked segments removed. Keep it deterministic.

### B2. Orchestrator (Sat AM)
- `agent/orchestrator.ts`: `gemini-4-argon`, `thinking_level: "high"`. Context: region config, latest readings + thresholds, risk events, villages, centres, relevant `knowledge` chunks (2014 post-mortems etc.).
- Output (structured JSON, validated with zod): list of at-risk villages with hazard, level, ETA, reasoning.
- Delegate each village to **`gemini-3.8-flash` subagents in parallel** (`Promise.all`): nearest suitable centre, route via `planRoute`, alert text in `Region.languages`.
- Use `gemini-3.5-flash-lite` for cheap routing/classification (e.g. is this upload relevant?).
- Trigger: `risk.event` from C (auto) or `POST /agent/run`.

### B3. Verification loop (Sat AM) — **highest priority after B2**
`agent/verify.ts`, deterministic code, no LLM:
| Check | Passes when |
|---|---|
| `threshold` | claimed level matches latest reading vs station thresholds (or landslide screen) |
| `route` | route does not intersect blocked roads or runout lines (`$geoIntersects` or turf.js) |
| `capacity` | centre `capacity - headcount ≥ village.population` (else split) |
| `freshness` | supporting readings newer than 60 min (live mode) |
| `language` | every language in `Region.languages` present, ≤ 500 chars |
Loop: `plan → verify → if fail: replan with failure reasons (max 3) → status "verified"`. Every check is an `AgentStep` (`kind: "verify"`). **Make sure the demo scenario produces at least one real failure** (e.g. the nearest route crosses a flooded road).

### B4. Approval endpoints (Sat AM)
- `POST /alerts/:id/approve|reject` (record approver + time). Approve → status `approved` → write `SaintTask(send_alert)` (C's Saint handoff picks it up). **Nothing is sent before approval.**

### B5. Landslide screening model (Sat PM — pair with A for visuals)
- `agent/landslide.ts` (deterministic): slope per terrain cell × accumulated rain from nearest rain stations (`rain6d`) vs thresholds → risk 0–1. Runout = steepest-descent path from high-risk cells.
- Thresholds: run **Deep Research** (`deep-research-preview-04-2026`) for published rainfall-landslide thresholds in Malaysia/the region; store the brief + citations in `knowledge`, thresholds in `Region` config. Cite in README.
- Expose `computeLandslide(regionId, ts)` for C's `/hazards`.

### B6. Report analysis (Sat PM)
- On `report.new`: Gemini video/image understanding → `{ estDepthM, uncertaintyM, referenceObject, notes }` (structured output). Blur faces/plates before storing (simple approach: ask the model for bounding boxes and blur client/server side; or skip storing frames).
- If the estimate disagrees with the model's water level near that point → write `RiskEvent(report_disagreement)` → re-run orchestrator for downstream villages → ETA changes (demo beat: ~20 h → ~14 h).

### B7. Voice (Sat evening)
- `gemini-3.8-live` session for the browser: grounded on the user's location risk (inject current hazards + nearest centre as context). Malay first, English fallback.
- Optional: `gemini-3.8-flash-tts` to read out the approved alert.

### B8. Flood history brief (stretch)
- Deep Research per district → `knowledge` → shown in district panel with citations.

---

## 4. Workstream C — Data, MongoDB & Saint (Person C)

**Goal:** reliable data, every MongoDB feature in real use, one live-event path, Saint handoff, and the README/videos. Confirm tier availability of each feature with the MongoDB booth.

### C0. Repo + mock mode (Fri, first 1.5 h) — unblocks A and B
- Repo scaffold (§1.1), shared types (§1.2, with team), fixtures (§1.5).
- `MOCK=1` API: serves fixtures for every route in §1.3 and plays a scripted SSE sequence (reading → risk event → agent steps incl. fail/replan → alert → approval → saint tasks).

### C1. Atlas setup (Fri night)
- Apply $100 credit; M0 now, upgrade to M10 before Stream Processing.
- `apps/api/src/db/`: `client.ts`, `collections.ts`, `indexes/*.json` (search + vector index definitions **committed as files**), `setup.ts` (idempotent: creates time series collection, 2dsphere indexes, search indexes).

### C2. Ingest (Fri night)
- `scripts/ingest-jps.ts`: fetch both JPS tables (URLs in GUIDELINES §4), parse with `cheerio`, upsert `stations` (with thresholds) and insert `raw_readings`. `-9999` → skip. Generate stable IDs for blank station IDs (hash of name). Station coordinates: JPS tables have none — **geocode once** (OSM Nominatim by station/village name, then hand-fix the 10 that matter for the demo) and store in `stations`.
- Run every 15 min (`setInterval` in API, or cron).
- `scripts/load-replay-2014.ts`: GloFAS discharge for chosen main-channel cells + Open-Meteo archive rainfall for rain stations' locations, 10 Dec 2014 – 10 Jan 2015 → `raw_readings` with `mode: "replay"`.
- `scripts/build-terrain.ts`: stitch Terrarium tiles for `Region.bbox` → heightmap PNG/binary in `apps/web/public/terrain/`.
- `scripts/load-osm.ts`: Overpass query for roads/rivers/buildings/villages in bbox → `geo` + `villages`. Evac centres: NADMA list + teammate knowledge → `evac_centres` (manual JSON is fine).
- **Done when:** Compass shows live JPS readings arriving and the 2014 replay series loaded.

### C3. Replay engine (Sat AM)
- `POST /replay/start {speed}`: walks replay readings in time order, re-emitting them as `reading.new` (and through the same stream processor) at e.g. 1 day = 30 s. Emits `replay.tick`.

### C4. Stream Processing (Sat AM)
- Processor definition **committed** at `apps/api/src/db/stream-processors/risk.js`: source = change stream on `raw_readings`; join station thresholds; window (e.g. tumbling 15 min for river level; hopping 24 h for rain accumulation); emit threshold crossings → `$merge` into `risk_events` with `source: "stream_processing"`.
- Also write an `AgentStep` (actor "MongoDB Stream Processing") for the HUD.
- Fallback if blocked on tier: same logic in a Node worker, but keep trying to ship the real processor — it's a named feature.

### C5. Live events (Sat AM)
- `GET /api/stream`: one SSE endpoint fed by **change streams** on `raw_readings`, `risk_events`, `agent_steps`, `alerts`, `reports`, `evac_centres`, `saint_tasks`. Map each to the event names in §1.4.

### C6. Hazards endpoint (Sat AM–PM)
- `/regions/:id/hazards?ts`: water level per GloFAS cell / station (documented discharge → level mapping calibrated to JPS thresholds; label "approximation"), likely vs worst (± uncertainty band), blocked roads = road segments below water level (geospatial), landslide from B's `computeLandslide`.

### C7. Search features (Sat PM) — each needs a UI moment with A
| Feature | Implementation |
|---|---|
| Atlas Search | `villages`/`stations` index with `autocomplete` + `fuzzy` on `name`, `altNames` → `/search?type=place` |
| Automated Embedding | Configure on `reports.text` and `knowledge.chunk` (confirm current setup with MongoDB docs/booth). No manual embedding code path for these. |
| Vector Search | `reports` vector index; `/reports/:id/similar` (+ geo filter within 5 km) |
| Hybrid Search | `$rankFusion` of `$vectorSearch` + `$search` over `reports` + `knowledge` → `/search?type=hybrid` |
| Voyage AI | Multimodal embeddings for report images/video frames; **rerank** hybrid results before returning (and before B passes them to Gemini) |
| Geospatial | `$geoNear` nearest centre; `$geoWithin` villages in flood/runout areas |
- Seed `knowledge`: chunk 2014 flood post-mortems / district plans (public PDFs) + B's Deep Research briefs.
- Ask the MongoDB booth about **Agent Engine** and **AI Model APIs** in the Atlas sidebar; adopt if quick.

### C8. Saint handoff (Sat AM setup → Sat PM)
- Attend Saint setup Saturday morning. Confirm: which channel Saint monitors (email? shared sheet? WhatsApp?), which accounts it gets, whether it can call an HTTP endpoint.
- On `SaintTask(send_alert)`: post the approved alert + contacts to Saint's channel (the plain-English job description lives in `docs/saint-brief.md`).
- Sync Saint's results back (shared sheet poll or `POST /saint/updates`) → `evac_centres.headcount`, `saint_tasks` → SSE.
- Keep `docs/saint-log.md`: what we asked, tools/accounts used, where it asked for approval (required for submission).
- **No Saint allocated →** `SaintTask`s render as a human checklist; remove Saint from submission.

### C9. README, submission, videos (Sun AM, start notes Sat)
- README per GUIDELINES §10, with **file links** for each sponsor feature (index JSONs, stream processor, prompts, wrapper).
- Record beats with A's `?demo=1` presets; cut Videos A/B/C (GUIDELINES §9).

---

## 5. Integration checkpoints

Each checkpoint: 15 min, all three people, run `main` together, fix the top issue, adjust plan.

| # | When | Must work end-to-end on `main` |
|---|---|---|
| **I0** | Fri ~21:00 | Contracts merged. `pnpm dev:mock` runs: A sees terrain + fixture layers + mock SSE in HUD. B's wrapper logs a real Argon call. C's ingest writes real JPS readings. |
| **I1** | Fri ~23:30 | Real data in Atlas (live + 2014 replay). A renders real stations/villages from the API (not fixtures). B's tools read real DB. |
| **I2** | Sat 13:00 | **Golden path, text-level:** replay start → reading → Stream Processing risk event → agent run (Argon + Flash subagents) → verification fail → replan → pass → alert card in 3D → Approve → SaintTask created. |
| **I3** | Sat 19:00 | Flood + landslide layers driven by `/hazards`; search/vector/hybrid/rerank in UI; report upload → depth → ETA change; Saint loop (if allocated). |
| **I4** | Sat 23:59 | **Feature freeze.** Voice, region switch, Tech HUD polish. Full dry run of Video A script. Only bug fixes after this. |
| **I5** | Sun 10:30 | Videos cut, README complete, submission text drafted. Submit by **11:30** (deadline 12:00). |

**If a checkpoint fails:** cut scope, don't move the checkpoint. Cut order (first to go): Nano Banana illustration → B8 history brief → TTS → resident page polish → second region data (use a fixture region) → voice. **Never cut:** verification loop, approval step, Tech HUD, MongoDB feature moments, 2014 replay.

---

## 6. Definition of done (every PR)
- `pnpm typecheck` passes; `main` runs in both `MOCK=1` and real mode.
- No secrets; no `temperature`/`top_p`/`top_k`/`thinking_budget` in Gemini calls.
- New sponsor-feature usage emits an `AgentStep` so it shows in the HUD.
- Any external action is behind approval.
- Shared contract changes: all three agreed, fixtures updated in the same PR.
