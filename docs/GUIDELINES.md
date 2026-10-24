# MonsoonWatch — Technical Guidelines

> Context file for humans and AI coding agents working on this repo.
> Read this before writing code. It defines what we are building, which sponsor features we must use, and how every feature must be **visible in the demo video**.

---

## 0. The one rule

**If a judge can't see it in the video, the README or the code, it doesn't exist.**
Judges score from: the demo video(s), the project brief/submission text, and this GitHub repo. Every sponsor feature we use must be:
1. **Implemented** in real, working code (no mocks presented as real),
2. **Visible on screen** in the demo (see §7 "Tech HUD"),
3. **Documented** in the README with a link to the file that uses it.

---

## 1. What we are building

**MonsoonWatch** is an early-warning system for monsoon regions. It predicts **landslides in the hills and floods downstream**, shows them on a **3D model of the valley**, and runs an **AI agent** that turns live data into evacuation alerts that a **human approves** before anything is sent. After approval, **Saint** coordinates the response (messaging community leaders, evacuation-centre check-ins, supply orders with approval).

- **Not Malaysia-specific.** Every region is a config document. **Demo region: Kelantan river valley, Malaysia** (teammate's family lived through the Dec 2014 floods).
- **Users:** district disaster officials and community leaders (3D control room on laptop); residents (simple responsive phone page).
- **Core insight:** danger travels. Rain in the hills → unstable slopes → river peak downstream hours/days later. We track that chain.

### Demo modes
1. **Replay: December 2014** (reconstructed data). Rain peaks 22–23 Dec in the hills, river peaks 24 Dec on the main channel.
2. **Live:** real JPS river and rain readings, every 15 min.
3. **Region switch:** one click to a second monsoon region to prove it scales.

---

## 2. Hard rules (disqualification / score killers)

- **All code written during the hackathon** (from Fri 23 Oct 2026, 17:00). Libraries and starter templates are fine. Do **not** copy code from earlier projects.
- **No secrets in the repo.** All keys go in `.env` (git-ignored). Commit `.env.example` with empty values.
- **No external action without human approval.** Any message, alert, or purchase goes through an approval step in the UI and is logged.
- **Be honest in the UI.** Label reconstructed data as "Reconstructed (GloFAS / reanalysis)". Label the landslide model as a **screening tool**, not a geotechnical survey. Show uncertainty (likely vs worst case).
- **Privacy:** no resident photo/video uploads (dropped, see IMPLEMENTATION §1.7). Vulnerable-people data is **counts per village only** — never names or addresses — and labelled "Estimated" when it is.
- **Not a chat wrapper.** The DeepMind brief disqualifies basic chatbots / single-PDF Q&A. Every Gemini call must sit inside a workflow with tools and verification.

---

## 3. Architecture

```
               ┌───────────────────────────────────────────────────┐
 JPS (live) ──▶│ ingest/ scrapers (every 15 min)                   │
 Open-Meteo ──▶│  → raw_readings (time series) + reading_events    │
 GloFAS     ──▶└──────────────┬────────────────────────────────────┘
                              │ change stream
                              ▼
               ┌───────────────────────────────────────────────────┐
               │ Atlas Stream Processing                           │
               │  windows + threshold checks → risk_events         │
               └──────────────┬────────────────────────────────────┘
                              ▼
               ┌───────────────────────────────────────────────────┐
               │ Agent service (Gemini 4 Argon orchestrator)       │
               │  plan → subagents per village → VERIFY → draft    │
               │  → approval queue → (approved) → Saint handoff    │
               └──────────────┬────────────────────────────────────┘
                              ▼
               ┌───────────────────────────────────────────────────┐
               │ Web app (Three.js)                                │
               │  3D control room · resident phone view · Tech HUD │
               └───────────────────────────────────────────────────┘
```

**Stack (default — change only with team agreement):**
- **Language:** TypeScript everywhere (Python allowed for one-off data scripts).
- **Frontend:** Vite + Three.js (+ `three/examples` addons). Responsive page for residents.
- **Backend:** Node.js + Fastify (or Express). Server-Sent Events or WebSocket to push live updates.
- **DB:** MongoDB Atlas (upgrade to M10 with event credits — see §5.0).
- **AI:** `@google/genai` (≥ 2.3.0), Interactions API.

### Repo layout
```
/apps/web          Three.js control room + resident view
/apps/api          Fastify API, agent service, SSE
/packages/shared   Shared types (Station, Reading, RiskEvent, Alert…)
/scripts           ingest-jps.ts, load-glofas-2014.ts, load-rain-2014.ts, build-terrain.ts
/docs              architecture.md, demo-script.md, track-gemini.md, track-mongodb.md, track-saint.md
GUIDELINES.md      (this file)
README.md
.env.example
```

---

## 4. Data sources (all verified working on 23 Oct 2026)

Cache **everything** in MongoDB on first fetch. The demo must never depend on an external site being up.

| Need | Source | Notes |
|---|---|---|
| Live river levels + thresholds | JPS: `https://publicinfobanjir.water.gov.my/aras-air/data-paras-air/aras-air-data/?state=KEL&district=ALL&station=ALL&lang=en` | **HTML table**, ~36 Kelantan stations. Columns: No, Station ID, Station Name, District, Main Basin, Sub River Basin, Last Updated, Water Level (m), then thresholds **Normal, Alert, Warning, Danger**. Parse with `cheerio`. Some stations stale — check `Last Updated`. |
| Live rainfall (+6-day history) | JPS: `https://publicinfobanjir.water.gov.my/wp-content/themes/shapely/agency/searchresultrainfall.php?state=KEL&district=ALL&station=ALL&loginStatus=0&language=1` | **HTML table**, ~60 stations. Columns: Station ID, Station, District, Last Updated, 6 daily totals (mm), rainfall since midnight, last 1 hour. `-9999.0` = missing → treat as null. |
| 2014 river replay | Open-Meteo Flood API (GloFAS): `https://flood-api.open-meteo.com/v1/flood?latitude=5.775&longitude=102.125&daily=river_discharge&start_date=2014-12-10&end_date=2015-01-10` | Discharge in m³/s, ~5 km grid. **Main channel cells ≈ lon 102.125, lat 5.775–6.075** (peak ≈ 5,175 m³/s on 2014-12-24). Off-channel cells return tiny values — hard-code chosen cells. Accepts comma-separated lat/lon lists. |
| 2014 rainfall replay | Open-Meteo archive: `https://archive-api.open-meteo.com/v1/archive?latitude=4.88&longitude=101.97&start_date=2014-12-14&end_date=2014-12-28&daily=precipitation_sum&timezone=Asia/Kuala_Lumpur` | Reanalysis, coarse grid (smooths extremes). Peaks 22–23 Dec 2014. |
| Rain forecast | Open-Meteo forecast API | For the 72-hour time slider. |
| Terrain | AWS Terrarium tiles: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Decode: `elevation_m = R*256 + G + B/256 - 32768`. z12 ≈ 38 m/px at this latitude. Pre-bake to a heightmap in `/scripts/build-terrain.ts`. |
| Roads, rivers, buildings, villages | OpenStreetMap (Overpass API) | Pre-fetch for the demo valley; store as GeoJSON in MongoDB. |
| Evacuation centres | NADMA portal / teammate's local knowledge | Store with capacity. |
| Landslide thresholds | Gemini Deep Research (published Malaysian rainfall thresholds, with citations) | Store citations alongside thresholds. |
| NASA LHASA | **Not used** (needs Earthdata login; archive 2015–2021 only). Stretch goal only. |

**Unit honesty:** JPS gives water **level (m)**; GloFAS gives **discharge (m³/s)**. For the 3D water surface in replay mode, use a simple documented mapping calibrated against JPS thresholds, and label it an approximation.

---

## 5. MongoDB Atlas — use every listed feature, visibly

The MongoDB brief: *"The more of them you use, the more points you get."* We use **all six listed features**, plus extras. Each one has a defined job and a defined on-screen moment.

### 5.0 Setup
- Apply the **$100 event credit** (from the MongoDB booth) under Organization → Billing. Upgrade to **M10** when needed; some features (notably Stream Processing) are not available on free M0. **Confirm feature availability per tier with the MongoDB team at the booth.**
- Region: London (eu-west-2) if available.
- Network access: allow team IPs (or `0.0.0.0/0` for the weekend only).
- The Atlas sidebar also shows **"AI Model APIs"** and **"Agent Engine"** — ask the MongoDB team what these do; if usable, they are extra points.
- For exact syntax of newer features, use the docs' **"Ask MongoDB AI"**. Do not invent index or stage syntax.

### 5.1 Collections
| Collection | Type | Purpose |
|---|---|---|
| `regions` | normal | One config doc per region: bbox, stations, river cells, evacuation centres, language(s), thresholds. **Region switch = load a different doc.** |
| `stations` | normal + `2dsphere` | JPS river and rain stations with thresholds. |
| `raw_readings` | **time series** (`timeField: ts`, `metaField: {stationId, kind}`) | Every reading ever ingested (live + replay). Full history for charts. **Not watchable:** time series collections support neither change streams nor being a Stream Processing source ([limitations](https://www.mongodb.com/docs/manual/core/timeseries/timeseries-limitations/)). |
| `reading_events` | normal, TTL 7 days on `ts` | Same docs as `raw_readings`, **new readings only** (ingest writes both). The live feed: the change stream (→ SSE `reading.new`) and Atlas Stream Processing watch this collection. |
| `risk_events` | normal | Output of Stream Processing (threshold crossings, rain accumulation alerts). |
| `villages` | normal + `2dsphere` | Settlements with population estimate, polygon/point. |
| `evac_centres` | normal + `2dsphere` | Capacity, current headcount. |
| `reports` | normal | *Dropped with photo/video uploads (IMPLEMENTATION §1.7) — C to confirm whether the collection is removed.* |
| `knowledge` | normal | Long documents (flood post-mortems, plans, Deep Research briefs), chunked + embedded. |
| `alerts` | normal | Drafted alerts: status `draft → verified → approved → sent`, approver, timestamps. |
| `agent_runs` | normal | One doc per agent run: trigger, status, start/finish time. |
| `agent_steps` | normal | One doc per agent step (model used, summary, verification result, latency). Change stream → Tech HUD. |
| `geo` | normal | OSM roads (split into segments at junctions), rivers and building centroids for the region. |
| `saint_tasks` | normal | Handoff to/from Saint (see §6.4). |

### 5.2 Feature map (implement all; each needs its on-screen moment)

| # | Feature | Our use | On-screen moment |
|---|---|---|---|
| 1 | **Atlas Search (text)** | `GET /api/search?type=place` ([`search/places.ts`](../apps/api/src/search/places.ts), indexes [`places.villages.json`](../apps/api/src/db/indexes/places.villages.json), [`places.stations.json`](../apps/api/src/db/indexes/places.stations.json)): autocomplete + fuzzy on village/station `name` (+ village `altNames`), regionId filter, both collections merged by score. "kuala kri" → Kuala Krai; "manik urai" / "manek urai" → Manek Urai. | Search bar: type "kuala kri" → correct village; camera flies there. |
| 2 | **Atlas Vector Search** | autoEmbed `$vectorSearch` over `knowledge` ([`knowledge_vec.json`](../apps/api/src/db/indexes/knowledge_vec.json)) (2014 news reports, plans, Deep Research briefs): the vector half of hybrid search and, alone, `GET /api/knowledge/:id/similar` ("similar passages") ([`search/knowledge.ts`](../apps/api/src/search/knowledge.ts)). | Agent step / district panel shows the matching passages with similarity scores. |
| 3 | **Hybrid Search** (`$rankFusion` of `$search` + `$vectorSearch`) | `GET /api/search?type=hybrid` / `searchKnowledge()` ([`search/knowledge.ts`](../apps/api/src/search/knowledge.ts)): `$rankFusion` (vector 0.6 / text 0.4) of autoEmbed `$vectorSearch` + `$search` ([`knowledge_text.json`](../apps/api/src/db/indexes/knowledge_text.json)), top 20, e.g. "jalan ditutup Kuala Krai" (road closed). HUD: "Fused N vector + text results". | Query box shows both result lists fused, with a "hybrid" badge. |
| 4 | **Automated Embedding** | `knowledge_vec` is an `autoEmbed` index (`voyage-4`) on `knowledge.chunk`: Atlas embeds documents on insert (`pnpm load:knowledge`) and the query text at search time — no embedding code path in the repo. | Insert a Deep Research brief live → it appears in vector results seconds later. Mention in voice-over. |
| 5 | **Atlas Stream Processing** | Two processors in `apps/api/src/db/stream-processors/risk.js` (`pnpm db:stream`), source = change stream on `reading_events` (not `raw_readings`: time series collections can't be a Stream Processing source). `riskRiver`: 10-s tumbling window, max level per station, `$lookup` thresholds from `stations` → alert/warning/danger; in the 2014 replay also GloFAS discharge vs APPROXIMATE 1,500/3,000/4,500 m³/s. `riskRain`: 20-s hopping window (5 s hop) over 3-day rain (since midnight + last 2 daily totals) vs placeholder 150/250/350 mm. Both `$merge` into `risk_events` with deterministic `_id`s (no duplicates on restart/replay); the API adds the HUD `AgentStep`. | Tech HUD: "Stream processor fired: Sg. Galas @ Kg. Lembaga crossed ALERT" → agent starts. |
| 6 | **Voyage AI** | Embeddings: `voyage-4` via automated embedding. **Rerank:** MongoDB native `$rerank` (`rerank-2.5`, multilingual) on the 20 hybrid results → top 5, each with `rankBeforeRerank` ([`search/knowledge.ts`](../apps/api/src/search/knowledge.ts)); falls back to the fused order (`reranked: false`) if rerank fails. HUD: "Reranked 20 → 5". Needs the Native Reranking project setting (enabled on the project). | Results panel shows "reranked by Voyage" with before/after order. |
| + | **Time series** | `raw_readings`. | Station chart (last 6 days). |
| + | **Geospatial** (`2dsphere`, `$geoNear`, `$geoWithin`) | Nearest evac centre; villages inside landslide runout polygons / flood extent. | Route + nearest centre highlighted. |
| + | **Change streams** | Push DB changes to the web app (SSE) → 3D updates live. | Water rises / pins pulse without page refresh. |
| + | **Triggers** (optional) | On `alerts.status = approved` → create `saint_tasks` doc. | Approval → Saint task appears. |

Reference shapes (verify against current docs before use):
```js
// Hybrid search sketch
db.knowledge.aggregate([
  { $rankFusion: {
      input: { pipelines: {
        vector: [ { $vectorSearch: { index: "knowledge_vec", path: "embedding", queryVector: qv, numCandidates: 200, limit: 20 } } ],
        text:   [ { $search: { index: "knowledge_text", text: { query: q, path: ["title","chunk"], fuzzy: {} } } }, { $limit: 20 } ]
      } },
      combination: { weights: { vector: 0.6, text: 0.4 } }
  } },
  { $limit: 10 }
])
```

---

## 6. Google Gemini 4 Argon — deep, verified, multi-model

### 6.1 Rules from the DeepMind brief (follow exactly)
- SDK: `npm install @google/genai@latest` (≥ 2.3.0). Use the **Interactions API**: `client.interactions.create`.
- Use `thinking_level` (`"low" | "medium" | "high"`), **not** `thinking_budget`.
- **Do not** set `temperature`, `top_p`, `top_k`, or explicit `cached_content` (implicit caching is automatic).
- Set `background: true` for generations past 65,536 tokens.
- Give coding agents the official skills: `npx skills add google-gemini/gemini-skills --skill gemini-api-dev` and `--skill gemini-live-api-dev`. **Do not guess API shapes — use the skill or docs.**

### 6.2 Model usage map

| Model / agent | Job in MonsoonWatch | On-screen moment |
|---|---|---|
| `gemini-4-argon` (`thinking_level: "high"`) | **Lead orchestrator.** Loads the whole situation in one context: live readings, risk events, region config, villages, evac centres, long documents (2014 post-mortems, district plans). Decides which villages are at risk, delegates, reviews subagent output, writes final plan. | Agent panel streams reasoning steps; HUD badge "Argon · 1M context · N tokens loaded". |
| `gemini-3.8-flash` subagents (parallel) | One per affected village: compute risk window, nearest evac centre, route avoiding blocked roads, draft alert in local language + English. | Several village cards fill in simultaneously. |
| `gemini-3.5-flash-lite` | Cheap routing/classification (e.g. does this risk event need a full agent run?). | HUD shows routing step. |
| **Vulnerable-people priority** (Argon plans, Flash subagents per village) | Orders pickups for bedridden → disabled → elderly → no-transport people using per-village counts (`Village.vulnerable`), picks a suitable vehicle (boat / 4x4 / ambulance / bus), and writes them into `Alert.pickups`. Checked by the `vulnerable` verification check. Gemini only **plans**; carrying it out after approval is Saint's job. | Village card shows "12 bedridden → boat pickup first"; vulnerable check turns red → replan → green. |
| `deep-research-preview-04-2026` | (a) Find published rainfall-landslide thresholds for the region, with citations. (b) Flood history brief per district. Stored in `knowledge`. | Brief with citations opens from a district. |
| `gemini-3.8-live` | Voice Q&A in the local language: "Rumah saya selamat tak?" → answer grounded in current risk for that location. | Live voice clip in the video. |
| `gemini-3.5-live-translate-preview` / `gemini-3.8-flash-tts` (optional) | Spoken alert in local language for low-literacy residents. | Play alert audio. |
| `antigravity-preview-09-2026` (optional) | Run the verification scripts (route/geometry checks) in a sandbox. Only if time allows. | — |
| `gemini-nano-banana-2.1` (optional) | Illustrate a resident's street at forecast depth. **Must** be labelled "Illustration, not a prediction". | — |

### 6.3 The verification loop (50% of DeepMind score is the working demo with a real verification loop)
The agent's plan is **checked by deterministic code** before any human sees it. Every check returns pass/fail, is logged to `agent_steps`, and is shown in the UI.

1. **Threshold check:** each at-risk claim must match the latest stored reading vs the station's JPS thresholds (or the model's rain-accumulation threshold).
2. **Route check:** every evacuation route is tested against current flooded-road segments and landslide runout polygons (`$geoIntersects`). Fail → agent re-plans.
3. **Capacity check:** assigned evac centre capacity ≥ village population estimate; else split across centres.
4. **Freshness check:** reject readings older than N minutes (stale JPS stations).
5. **Language check:** alert exists in local language + English and fits SMS/WhatsApp length.
6. **Vulnerable check** *(proposed, §1.7)*: every vulnerable person counted in `Village.vulnerable` is covered by a pickup in that village's alerts, bedridden/disabled are ordered first, and the vehicle suits the route (boat if it crosses flooded road).

Loop: `plan → verify → (fail → replan with failure reasons, max 3 tries) → verified draft → human approval queue`.
UI shows a checklist with green/red ticks per alert. **Film at least one fail → replan → pass.**

### 6.4 Landslide screening model (our own, transparent)
`risk = f(slope from terrain, accumulated rain over N days from nearest rain stations, cited thresholds)`.
For each high-risk cell, trace the **steepest-descent runout path** downhill; villages/roads intersecting it are at risk. UI label: *"Screening tool. Shows where to check first. Does not replace an on-site engineer."*

---

## 6.5 Saint — the hands after approval (status: signed up, awaiting allocation)

Saint is an AI colleague that works in real email, calendars, documents, browsers and terminals, and asks before risky actions. It is **not** an SDK we call; we give it a job in plain English and tools/accounts to work with. **Confirm the integration method with the Saint team on Saturday morning; do not hard-code assumptions.**

**Boundary with Gemini (no overlap):** Gemini works **before** approval (sense, predict, plan, verify, draft). Saint works **after** approval (contacting people, handling their replies, check-ins, logistics, reports). Gemini never sends or reads messages to/from people.

**Saint's jobs (after an official approves an alert):**
1. Send the approved alert to community leaders (WhatsApp/email) and **chase non-replies**.
2. Log replies ("30 people moving to the school") into the check-in sheet; update headcount vs capacity; suggest the next centre when nearly full.
3. Draft supply orders (water, blankets, food) as headcount rises — **asks for approval before spending**. Use a test/tiny order in the demo.
4. Write a situation report every few hours and email it to the district office.

**Handoff design (adapt after Saturday setup):**
- On approval, our API writes a `saint_tasks` doc **and** posts the task to the channel Saint monitors (shared sheet / email inbox — TBD).
- Saint writes results back to the shared sheet (or calls our REST endpoint `POST /api/saint/updates` if it can use a terminal/browser — confirm). Our API syncs them into `evac_centres` / `saint_tasks` so the 3D view updates.
- Keep a written record of: what we asked Saint to do, and which tools/devices/accounts it used (required for submission).

**If we don't get a Saint:** the same handoff writes to `saint_tasks` and the UI shows "Coordination tasks" as a checklist for humans. Remove Saint from submission and video.

---

## 7. The Tech HUD (how judges *see* the tech)

Add a toggleable **"Under the hood"** panel to the control room. Every step shows: which **sponsor feature or model** handled it, a one-line description, and latency. Examples:
- `MongoDB Stream Processing` → "ALERT crossing: Sg. Galas @ Kg. Lembaga (84.79 m > 83.70 m)" · 120 ms
- `Gemini 4 Argon` → "Orchestrating 4 villages · 312k tokens in context"
- `Voyage rerank` → "Reranked 20 → 5 reports"
- `Verification` → "Route check FAILED (road segment flooded) → replanning"
- `Saint` → "WhatsApp sent to Kg. Manik Urai leader · awaiting reply"

This panel is our cheat code for the video: one glance proves feature usage. Keep it visually clean (monospace, sponsor colour accents, fades in/out).

---

## 8. 3D control room (Three.js)

3D must **show information a flat map can't**. If a visual doesn't carry data, cut it.
- **Scope:** one valley (hills around Gua Musang → Kuala Krai → Kota Bharu). Polished > big.
- Terrain mesh from pre-baked heightmap; OSM roads, rivers, buildings.
- **Flood:** depth-tinted water shader; two layers — solid "likely", faint "worst case"; 72-hour time slider; click a house → depth + arrival time.
- **Landslide:** slope-risk heatmap on hillsides; animated runout paths; affected roads/houses highlighted.
- **Agent-driven camera:** when the agent runs, the camera flies to affected villages, routes draw on terrain, alert cards appear in-scene with **Approve** button.
- Village markers show vulnerable-people counts and pickup order once the agent has planned.
- Style: dark, minimal, water and risk as the only strong colours. Must run smoothly on a laptop.
- Resident view (phone): no heavy 3D; their location, risk, time until arrival, route, voice button.
- **Effort cap: ~1/3 of team time.**

---

## 9. Video plans (judges score from these)

Record clean screen captures of each beat once, then cut three videos. Use captions naming the tech on screen ("Gemini 4 Argon", "MongoDB Hybrid Search"…). No slides.

### Video A — Main / Google DeepMind (3:00)
| Time | Beat |
|---|---|
| 0:00–0:20 | Teammate's story (Kelantan 2014). Name the user: district officials + community leaders. |
| 0:20–0:50 | Fly into 3D valley. Replay Dec 2014: rain in hills → slopes turn red → river rises downstream. |
| 0:50–1:40 | Live data. Stream Processing fires → Argon orchestrates → Flash subagents per village → **verification fails once, replans, passes** → alert cards. |
| 1:40–2:10 | **Vulnerable-people priority:** first plan for Kg. Manik Urai misses 12 bedridden residents → `vulnerable` check FAILS → Argon replans with a boat pickup first → PASS. *(Proposed, §1.7.)* |
| 2:10–2:35 | Official clicks **Approve** → message lands on a real phone (Saint if available). |
| 2:35–2:50 | Voice question in Malay via Gemini Live. |
| 2:50–3:00 | One-click region switch. "Built for every monsoon valley." |

### Video B — MongoDB (3:00)
Same app, HUD open, narrated around the database: time-series ingest → Stream Processing window + threshold → `risk_events` → change stream updates 3D → Atlas Search fuzzy place name → new knowledge doc auto-embedded → Vector search over knowledge → Hybrid query → Voyage rerank → geospatial nearest centre → region config doc switch. Show Atlas UI briefly (indexes, stream processor) to prove it's real.

### Video C — Saint (2–4 min)
Before/after: alert approved → Saint messages leader → leader replies on phone → Saint logs check-in, updates headcount → centre nearly full → Saint drafts supply order and **asks approval** → approve (test order) → Saint emails situation report. End with: what we asked Saint to do + tools/accounts it used.

---

## 10. README requirements

The README must contain:
1. One-paragraph summary + screenshot/GIF of the 3D control room.
2. Links to the three videos.
3. Architecture diagram (§3).
4. **"How we use Gemini"** — every model/agent from §6.2 and *how*, with file links (required by DeepMind).
5. **"How we use MongoDB"** — the §5.2 table with file links to each index/pipeline/processor definition.
6. **"How we use Saint"** — what we asked, tools/accounts used, where it stops and asks.
7. Data sources + honesty notes (reconstructed data, screening model, uncertainty).
8. Setup: `.env.example`, install, run, seed data (`/scripts`).
9. Statement that all code was written during Encode London 2026.

Keep index definitions, stream processor definitions and prompts **in the repo as files** (e.g. `/apps/api/db/indexes/*.json`, `/apps/api/db/stream-processors/*.js`, `/apps/api/agent/prompts/*.md`) so judges can find them.

---

## 11. Team split (3 people) and timeline

| Person | Owns |
|---|---|
| **A — 3D/frontend** | Terrain, water + landslide visuals, agent-driven camera, approval UI, Tech HUD, resident phone view. |
| **B — Agent/Gemini** | Orchestrator, subagents, verification loop, vulnerable-people priority, Live voice, Deep Research, prompts. |
| **C — Data/MongoDB/Saint/video** | Scrapers + replay loaders, all MongoDB features, region configs, Saint handoff, README, video recording/editing. |

| When | Milestone |
|---|---|
| Fri → 23:00 | Repo + `.env.example`; scrapers writing to `raw_readings`; 2014 data loaded; terrain heightmap baked; hello-world Argon call via Interactions API. |
| Sat 09:00–13:00 | Saint setup (if allocated). Stream processor + `risk_events`. Agent plan → verify loop end-to-end (text only). 3D valley with water layer. |
| Sat 13:00–19:00 | Search / Vector / Hybrid / auto-embed / Voyage rerank. Vulnerable-people priority + check. Approval flow. Camera follows agent. |
| Sat 19:00–24:00 | Live voice, region switch, Tech HUD, Saint loop. **Feature freeze at midnight.** |
| Sun 08:00–11:00 | Record beats, cut Videos A/B/C, README, submission text. |
| Sun 11:00–12:00 | Buffer. **Submissions close 12:00.** |

---

## 12. Open decisions (do not assume — confirm with the team)
- [ ] Saint allocated? (decides §6.5 and Video C)
- [x] Resident photo/video uploads — **dropped** (not realistic in an emergency). See IMPLEMENTATION §1.7.
- [ ] Vulnerable-people counts: estimated from census rates, or real figures for the demo villages?
- [ ] Second region for the switch demo (and its data sources).
- [ ] Which MongoDB features work on our tier; what "Agent Engine" / "AI Model APIs" in Atlas offer.
- [ ] Final stack confirmation (TypeScript everywhere vs Python scrapers).
- [ ] Exact Kelantan evacuation centres and villages for the demo valley.
