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
| **B — Agent & Gemini** | Person B | Agent runs, alerts, verification results, vulnerable-people pickup plans, voice | Readings, risk events, villages, centres, search from C |
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
> **Superseded by the code.** This block is the original draft. `packages/shared/src/` is the source of truth, and §1.6 lists what changed (new `Alert.people`, `Hazards.blockedRoadIds`, `Region.landslide`, `AgentRun`, `GeoLayers`, `KnowledgeChunk`, plus response types in `api.ts`).

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
| ~~`GET /reports/:id/similar`~~ · ~~`POST /reports`~~ | — | Dropped with photo/video uploads (§1.7) |
| `POST /replay/start` `{regionId, secondsPerDay?, from?}` / `POST /replay/stop` / `GET /replay/status` | C | 202 / 202 / `{ running, replayId?, ts?, secondsPerDay?, … }` |
| `GET /regions/:id/evacuation-route?lng&lat&travel&mode&ts&centreId&people` | B | `EvacuationRoute` (`packages/shared/src/routing.ts`; fixtures `evacuation-route.*.json`). Deterministic, no Gemini; same routing as the agent |
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
- B: `agent-run.sample.json` (steps incl. one **fail → replan → pass**, the `vulnerable` check), `alerts.sample.json` (with `pickups`).
- A: none needed (consumer), but owns `apps/web/src/mock/` that replays fixtures as fake SSE.

`MOCK=1` makes the API serve fixtures and emit a scripted SSE sequence (C builds this in ~30 min; it is the most valuable 30 minutes of the weekend).

### 1.6 Contract decisions (agreed Fri 23 Oct, evening)
Gaps in §1.2–1.4 that were settled. The code in `packages/shared/src/` is the source of truth.

| # | Gap | Decision | Where |
|---|---|---|---|
| 1 | `agent_runs` vs `agent_steps` | **Both.** `agent_runs` = one `AgentRun` doc per run (trigger, status, times). `agent_steps` = one `AgentStep` doc per HUD line; its change stream feeds `agent.step`. Always use the `COLLECTIONS` constant, never type collection names. | `types.ts` `AgentRun`, `collections.ts` |
| 2 | Stations "with latest reading" | `GET /regions/:id/stations` returns `StationWithLatest[]` = `Station & { latest: Reading \| null }`. | `api.ts` |
| 3 | Search result shape | `/search` returns `SearchResponse { query, type, reranked, hits: SearchHit[] }`. Each hit has `kind`, `id`, `title`, `score`, optional `snippet`, `lngLat`, `sourceUrl`, and `rankBeforeRerank` (hybrid only) for the "reranked by Voyage" before/after view. `/reports/:id/similar` returns `SimilarReportsResponse { reportId, hits: { report, score, distanceM }[] }`. | `api.ts` |
| 4 | `/geo` shape | `GeoLayers { regionId, roads, rivers, buildings }`, each a GeoJSON FeatureCollection. **Roads are split at junctions** by `scripts/load-osm.ts`: one feature = one segment with `id` (`"<wayId>:<index>"`), `from`/`to` OSM node ids, `highway`, `lengthM`, so B builds the routing graph straight from it. Buildings are centroids only. `Hazards` gains `blockedRoadIds: string[]` (road segment ids) next to the drawable `blockedRoads`. | `types.ts` `GeoLayers`, `RoadProps`, `Hazards` |
| 5 | Splitting a village across centres | **One alert per (village, centre).** If a village must be split, the agent makes several `Alert`s with the same `runId` + `villageId`. New field `Alert.people` = how many people this alert sends to `evacCentreId`; the capacity check is `capacity − headcount ≥ people`, and the alerts for a village must add up to its population. | `types.ts` `Alert` |
| 6 | Landslide thresholds in config | `Region.landslide?: { slopeMinDeg, rainThresholdsMm: { days, mm }[], citations: { title, url }[] }`. B fills it from Deep Research; risk is raised when slope ≥ `slopeMinDeg` and rain over `days` ≥ `mm` for any entry. | `types.ts` `Region` |
| 7 | `GET /agent/runs/:id` | Returns `AgentRunDetail { run: AgentRun, steps: AgentStep[] (oldest first), alerts: Alert[] }`. `POST /agent/run` returns `AgentRunStarted { runId }`. | `api.ts` |
| 8 | Error format | Every non-2xx response body is `ApiError { error: { code, message } }`, `code` ∈ `bad_request \| not_found \| conflict \| unavailable \| internal`. The API sets this up globally; in a route, `throw new HttpError(404, "not_found", "…")` from `apps/api/src/errors.ts`. | `api.ts`, `apps/api/src/errors.ts` |

Also added: `KnowledgeChunk` (the `knowledge` collection, used by hybrid search and B's `searchKnowledge`), and a `geo` collection for the OSM layers.

### 1.7 Proposed changes (B, Fri 23 Oct ~21:15) — **pending A + C agreement**
Merging the PR that adds this section = the team agrees. Shared code (`packages/shared`) is changed only after that, in a separate PR with fixtures.

| # | Change | Why | Affects |
|---|---|---|---|
| 1 | **Drop resident photo/video uploads** and their Gemini analysis (old B6). Remove `Report.mediaUrl`, `mediaType`, `analysis.referenceObject` (C to decide if `Report`/`reports` go entirely), `POST /reports`, `/reports/:id/similar`, `report.new`, privacy blurring, Voyage image embeddings. | Not realistic in an emergency (no signal/battery, unreliable to judge, privacy). | A: upload button, report pins. C: routes, indexes. Shared: `Report`, `RiskEvent.type "report_disagreement"`, `SimilarReportsResponse`, events. |
| 2 | **MongoDB Vector / Hybrid / Automated Embedding move to `knowledge`** (text) so we keep every MongoDB feature. | Reports were their only data. | C (indexes, `/search`). |
| 3 | **New: vulnerable-people priority.** `Village.vulnerable?: { bedridden: number; disabled: number; elderly: number; noTransport: number; source: string; estimated: boolean }` — **counts only, no names**. `Alert.pickups?: { category: "bedridden" \| "disabled" \| "elderly" \| "noTransport"; people: number; vehicle: "boat" \| "4x4" \| "ambulance" \| "bus"; order: number }[]`. `CheckName` gains `"vulnerable"`. | Real-world value; strong fail → replan → pass demo beat. | Shared types + fixtures (C adds counts to `villages.json`), A (village cards), B (planning + check). |
| 4 | **Gemini ↔ Saint boundary:** Gemini = before approval (sense, predict, plan, verify, draft). Saint = after approval (people, messages, logistics). No Gemini feature reads or sends messages to people. | Avoid duplicated work between B and C. | Everyone. |
| 5 | **Video A 1:40–2:10** becomes the vulnerable-people beat (see GUIDELINES §9). | Old beat used resident video. | C (video), A (`?demo=1` preset). |

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
- Village cards: vulnerable-people counts (label "Estimated" when `estimated`) and the agent's pickup order from `Alert.pickups`.
- Voice button (uses B's `/voice/session`).
- Region dropdown → reload everything for another `Region`.

### A9. Resident page (Sat evening, `/resident`)
- Mobile-first, no heavy 3D (static map image or small 2D): your location, risk level, time until water, route, voice button.

### A10. Polish & recording mode (Sun AM)
- `?demo=1`: hides dev UI, larger fonts, scripted camera presets for each video beat (keys 1–9).

---

## 3. Workstream B — Agent & Gemini (Person B)

**Goal:** a real, verified, multi-model agent that turns risk events into approved-ready alerts, plus vulnerable-people pickup planning and voice. Follow GUIDELINES §6.1 API rules exactly.

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
- Use `gemini-3.5-flash-lite` for cheap routing/classification (e.g. does this risk event need a full agent run?).
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

### B6. Vulnerable-people priority (Sat PM) — *replaces photo/video report analysis (§1.7)*
- Subagents read `Village.vulnerable` (counts only) and plan `Alert.pickups`: order bedridden → disabled → elderly → no transport; vehicle by route (boat if it crosses a flooded segment, ambulance for bedridden where roads are open).
- New deterministic check `vulnerable` in `agent/verify.ts`: every counted person covered across the village's alerts, priority order respected, vehicle suits the route.
- Demo beat (Video A 1:40–2:10): first plan misses the bedridden group → check FAILS → replan → PASS.
- Gemini only plans. Executing pickups / contacting people after approval is Saint's job (GUIDELINES §6.5).

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
- `scripts/ingest-jps.ts`: fetch both JPS tables (URLs in GUIDELINES §4), parse with `cheerio`, upsert `stations` (with thresholds) and insert new readings into `raw_readings` **and** `reading_events` (the watchable live copy, see C5). `-9999` → skip. Generate stable IDs for blank station IDs (hash of name). Station coordinates: JPS tables have none — **geocode once** (OSM Nominatim by station/village name, then hand-fix the 10 that matter for the demo) and store in `stations`.
- Run every 15 min (`setInterval` in API, or cron).
- `scripts/load-replay-2014.ts`: GloFAS discharge for chosen main-channel cells + Open-Meteo archive rainfall for rain stations' locations, 10 Dec 2014 – 10 Jan 2015 → `raw_readings` with `mode: "replay"`.
- `scripts/build-terrain.ts` (`pnpm build:terrain`) — **built**: AWS Terrarium tiles at z11 for `Region.bbox`, resampled to a regular lon/lat grid → `apps/web/public/terrain/kelantan.png` (776×1262 px heightmap, ~150 m/px, Terrarium RGB encoding `elevation_m = R·256 + G + B/256 − 32768`, 2.0 MB) and `apps/api/data/terrain/kelantan.elev.{json,i16.gz}` (75 m Int16 grid, 4.1 MB) for the hazards model; fills `Region.terrain`. Details: [`docs/HAZARDS.md`](HAZARDS.md).
- `scripts/prep-hazards.ts` (`pnpm prep:hazards`) — **built**: per road segment `hazard` { groundM, riverDistM, riverName, gaugeId, gaugeDistM, cellId, bridge } on the geo docs, `hazardGauge` on river stations, and the JPS datum check. Re-run after `load:osm`.
- `scripts/load-osm.ts`: Overpass query for roads/rivers/buildings/villages in bbox → `geo` + `villages`. Evac centres: NADMA list + teammate knowledge → `evac_centres` (manual JSON is fine).
- **Done when:** Compass shows live JPS readings arriving and the 2014 replay series loaded.

### C3. Replay engine (Sat AM)
Built: `apps/api/src/replay/engine.ts` + `apps/api/src/routes/replay.ts`.
- `POST /api/replay/start { regionId, secondsPerDay? (default 30, 1–600), from? (ISO, default Region.replay.start) }` → **202** `{ running, replayId, regionId, from, to, days, secondsPerDay }`. Already running → **409**; unknown region → **404**; bad body → 400. `POST /api/replay/stop` → 202 (halts before the next tick). `GET /api/replay/status` → `{ running, replayId?, regionId?, ts?, day?, days?, secondsPerDay?, from?, to? }`; after a run ends it still reports the last `replayId`/`ts` with `running: false`.
- **Each tick = one 2014 day:** that day's replay readings in `raw_readings` (GloFAS discharge + rain, all kinds) are **copied** into `reading_events` with `meta.mode: "replay"` and their original 2014 `ts`. They then follow the live path: change stream → SSE `reading.new`, and Stream Processing → `risk_events` (`mode: "replay"`) → `risk.event` + HUD `agent.step`. `raw_readings` is never written.
- **`replay.tick { ts }`** is published directly via `events/bus.ts`. It is the one allowed direct publish: it's a clock, not data.
- **Fresh demo every time:** start deletes replay `risk_events` (`mode: "replay"`), their `sp-*` agent steps and replay docs in `reading_events`, so the processors fire again. Live data is never touched.
- Ticks are scheduled against the start time (no drift); the API stops the replay on SIGINT/SIGTERM. Replay state is in-process: run one API instance when demoing.
- Note: `reading_events` has a 7-day TTL on `ts`, so replay copies (2014 `ts`) are removed by MongoDB within about a minute. The change stream and processors have already seen the insert by then.
- **Length:** the full replay (10 Dec 2014 – 10 Jan 2015) is 32 days → **16 min at 30 s/day**. For the demo, start from 18 Dec (`{ "regionId": "kelantan", "from": "2014-12-18" }`): 24 days = 12 min, first GloFAS alert after about 30 s, danger after 3.5 min.
- Tested at 10 s/day from 18 Dec: GloFAS alert 19 Dec → warning 22 Dec → **danger 24 Dec (Kuala Krai cell 5,187 m³/s)** → back to alert by 27 Dec; rain alerts from 21 Dec (max 233 mm/3 days). 160 replay risk events over the run (52 GloFAS: 4 cells × 13 days; 108 rain: station × day), each with its HUD step.

### C4. Stream Processing (Sat AM) — **live**
Two real Atlas Stream Processing processors, defined in **`apps/api/src/db/stream-processors/risk.js`** and applied by **`pnpm db:stream`** (`apps/api/src/db/stream.ts`: creates missing processors, leaves unchanged ones alone, drops and recreates changed ones, starts them, prints state + stats; `--stop` stops them, since each bills per hour while running). Atlas allows one window stage per pipeline, so river and rain are separate processors.
- **Source:** change stream on **`reading_events`** (inserts), via the connection registry entry `monsoonwatch` → Cluster0. Not `raw_readings`: time series collections can't be a Stream Processing source or be watched by change streams ([limitations](https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/)).
- **`riskRiver`:** `$tumblingWindow` of **10 s** (idle timeout 10 s), max value per station → `$lookup` station thresholds from `stations` → level = highest of alert/warning/danger crossed → `RiskEvent` `type: "river_threshold"`, message e.g. `ALERT crossing: Sg. Galas di Limau Kasturi (F1) (56.41 m ≥ 56 m)`.
  - **GloFAS (replay only):** readings with `meta.kind: "glofas"` (daily discharge, `stationId` = `Region.glofasCells` id, label via `$lookup` into `regions`) use **APPROXIMATE discharge thresholds 1,500 / 3,000 / 4,500 m³/s** (alert / warning / danger) on the main channel. We chose these from the 2014 series (cells peak ~5,100 m³/s on 24 Dec); they are not official return-period thresholds. Message: `DANGER: GloFAS discharge (reconstructed) at Main channel near Kuala Krai — 5187 m³/s ≥ 4500 m³/s (approximate threshold)`.
- **`riskRain`:** 3-day accumulation per reading = rain since local midnight (`value`) + the last two daily totals in `rain6d` (yesterday, day before). `$hoppingWindow` of **20 s, hop 5 s**, highest 3-day total per station → `type: "rain_accumulation"` at **150 / 250 / 350 mm** (alert / warning / danger). These are **placeholders** until B's Deep Research thresholds land in `Region.landslide.rainThresholdsMm`.
- **Timing:** windows run on the change event's time (≈ when the reading was inserted), not the reading's own `ts`. Otherwise stale JPS stations and the 2014 replay would count as late data and be dropped. Window sizes are processing time, so they must be shorter than one replay day (≥ 10 s/day). Otherwise several 2014 days merge and the alert → warning → danger build-up is lost. Live JPS bursts still land in one window.
- **Sink / dedup:** `$merge` into `risk_events` on `_id` with `whenMatched: "keepExisting"`. `_id` = `<stationId>:river_threshold:<level>:<15-min reading slot>` or `<stationId>:rain_accumulation:<level>:<local day>`, so restarts, re-inserted readings and replays never duplicate. Extra fields: `mode` (live/replay), `windowStart`, `windowEnd`. Failed documents go to `sp_dlq`.
- **Tech HUD:** the API's `risk_events` change stream also writes an `AgentStep` (actor "MongoDB Stream Processing", kind "db", `_id`/`runId` = `sp-<riskEventId>`, latency = window close → event written), so SSE carries `risk.event` + `agent.step`.
- **Needs:** the DB user from `MONGODB_URI` with the `atlasAdmin` role; `STREAM_PROCESSING_URI` (no credentials; the script reuses `MONGODB_URI`'s user). Tier SP2 per processor.
- Node fallback: not built. The real processors run.

### C5. Live events (Sat AM)
- `GET /api/stream`: one SSE endpoint fed by **change streams** (`apps/api/src/events/change-streams.ts`, started only when `MOCK` ≠ 1):

  | Collection | Operations | SSE event |
  |---|---|---|
  | `reading_events` | insert | `reading.new { reading }` |
  | `risk_events` | insert | `risk.event { riskEvent }` |
  | `agent_steps` | insert, update, replace | `agent.step { step }` (steps are upserted running → ok/fail) |
  | `alerts` | insert, update, replace | `alert.updated { alert }` |
  | `evac_centres` | insert, update, replace | `evac.updated { evacCentre }` |
  | `saint_tasks` | insert, update, replace | `saint.task { task }` |

  Readings come from `reading_events`, not `raw_readings`: time series collections don't support change streams, so every writer of live readings (ingest, later replay) inserts into both. Dates are sent as ISO strings. Each stream keeps its resume token and reopens with `resumeAfter` (backoff 1 s → 30 s); a failing stream never crashes the API. No `report.new` (dropped, §1.7). `hazards.update` and `replay.tick` come later (C6, C3).

### C6. Hazards endpoint (Sat AM–PM)
**Built** — `GET /api/regions/:id/hazards?ts=<ISO>&mode=live|replay` (defaults now / live; a date-only `ts` = end of that day MYT; 404 unknown region, 400 bad params) and `getHazards(regionId, ts, mode)` from `apps/api/src/hazards/index.ts` for in-process use. Returns `Hazards` plus extra fields `approximate: true`, `notes[]`, `gauges[]`, `worst.blockedRoadIds`. Full model and every assumption: **[`docs/HAZARDS.md`](HAZARDS.md)**. In short:
- JPS levels verified as metres above MSL (valley-floor check); 18 usable gauges (mis-geocoded / district-located ones excluded).
- Live: latest JPS level per gauge. Replay: **APPROXIMATE** GloFAS discharge → level curve per gauge (500 → normal, 1,500 → alert, 4,500 m³/s → danger, linear, extrapolated). Under-floods Kuala Krai town at the 2014 peak (26.2 m vs ~34 m recorded).
- Flooded segment = within 3 km of a river, within 20 km of its gauge, gauge ≥ alert, lowest ground < water level. worst = likely + 0.5 m (live) / 2.0 m (replay). Segments cached in memory: ~15 ms per request after a ~2 s warm-up.
- Replay 24 Dec 2014: 11,946 blocked segments (12 Dec: 0); live now: 0. Fail → replan case: Manek Urai → SMK Manek Urai (cut on 24 Dec).
- Landslide: hook `setLandslideProvider(fn)` for B's `computeLandslide`; empty until registered.

### C7. Search features (Sat PM) — each needs a UI moment with A
**Built** — code in [`apps/api/src/search/`](../apps/api/src/search/), routes in [`routes/search.ts`](../apps/api/src/routes/search.ts). `searchPlaces(q, { limit, runId })` and `searchKnowledge(q, { limit, runId })` are exported for in-process use (B's agent). Every call writes Tech HUD steps to `agent_steps` (runId `search-<8 hex>`, or the caller's `runId`) → `agent.step` on `/api/stream`. 400 for `q` < 2 chars, unknown `type` or bad `limit`.

| Feature | Implementation |
|---|---|
| Atlas Search | `GET /api/search?q=&type=place[&limit=8]` → [`search/places.ts`](../apps/api/src/search/places.ts). `$search` on the `places` index of `villages` ([def](../apps/api/src/db/indexes/places.villages.json)) and `stations` ([def](../apps/api/src/db/indexes/places.stations.json)) in parallel: `compound` with `filter` regionId + `should` autocomplete (boost 2) and fuzzy `text` (maxEdits 1, prefixLength 1) on `name` (+ `altNames` at half weight for villages), merged by `searchScore`. HUD: "MongoDB Atlas Search". Warm p95 ≈ 70 ms. |
| Automated Embedding | `knowledge_vec` ([def](../apps/api/src/db/indexes/knowledge_vec.json)) is an `autoEmbed` index (Voyage `voyage-4`) on `knowledge.chunk`: Atlas embeds on insert and embeds the query text. No embedding code in the repo. |
| Vector Search | autoEmbed `$vectorSearch` is the vector half of hybrid search, and on its own in `GET /api/knowledge/:id/similar[?limit=5]` → `{ id, title, hits }` (passages closest in meaning, `vectorSearchScore`). HUD: "MongoDB Vector Search". |
| Hybrid Search | `GET /api/search?q=&type=hybrid[&limit=5]` → [`search/knowledge.ts`](../apps/api/src/search/knowledge.ts). `$rankFusion` (weights vector 0.6 / text 0.4, `scoreDetails`) of `$vectorSearch` + `$search` (`knowledge_text`, [def](../apps/api/src/db/indexes/knowledge_text.json)) over `knowledge`, top 20. HUD: "MongoDB Hybrid Search" — "Fused N vector + text results". |
| Voyage AI | Embeddings via automated embedding (above). **Rerank:** MongoDB native `$rerank` (model `rerank-2.5`, multilingual) on the 20 fused ids as a second query, `maxTimeMS` 3 s; hits keep `rankBeforeRerank` (fused position) for the before/after view. HUD: "Voyage rerank" — "Reranked 20 → 5". If `$rerank` fails or times out the fused order is returned with `reranked: false`, a warning is logged and the HUD step is `fail`; the request never fails. Needs the Native Reranking project setting (enabled). E.g. "jalan ditutup Kuala Krai": fused #7, #4, #8, #5, #2 → reranked 1–5. Warm p95 ≈ 510 ms for the whole hybrid request (fusion ≈ 200–270 ms + rerank ≈ 190–570 ms). |
| Geospatial | `$geoNear` nearest centre; `$geoWithin` villages in flood/runout areas |
- Seed `knowledge`: chunk 2014 flood post-mortems / district plans (public PDFs) + B's Deep Research briefs.
- Ask the MongoDB booth about **Agent Engine** and **AI Model APIs** in the Atlas sidebar; adopt if quick.

### C8. Saint handoff (Sat AM setup → Sat PM)
- Attend Saint setup Saturday morning. Confirm: which channel Saint monitors (email? shared sheet? WhatsApp?), which accounts it gets, whether it can call an HTTP endpoint.
- On `SaintTask(send_alert)`: post the approved alert + contacts to Saint's channel (the plain-English job description lives in `docs/saint-brief.md`).
- Sync Saint's results back (shared sheet poll or `POST /saint/updates`) → `evac_centres.headcount`, `saint_tasks` → SSE.
- Keep `docs/saint-log.md`: what we asked, tools/accounts used, where it asked for approval (required for submission).
- **No Saint allocated →** `SaintTask`s render as a human checklist; remove Saint from submission.

> **As built (Sat 24 Oct):** Thea's guest access is WhatsApp-only, so the handoff is human-in-the-loop over WhatsApp: a Saint brief + `wa.me` link per approved alert, and pasted `MW CHECKIN` lines → `POST /api/saint/updates`. See `docs/saint-brief.md`, `docs/saint-log.md`, `apps/api/src/routes/saint.ts`.

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
| **I3** | Sat 19:00 | Flood + landslide layers driven by `/hazards`; search/vector/hybrid/rerank in UI; vulnerable-people priority (fail → replan → pass); Saint loop (if allocated). |
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
