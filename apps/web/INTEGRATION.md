# Frontend integration — 24 October 2026

Person A changes stay within apps/web. Shared contracts and backend routes are unchanged.

## Current behaviour

- Resident entry starts with **Where are you leaving from?** and a labelled starting-address field. Address/street results appear ahead of broad village matches. Enter submits a search and asks the person to choose a result; it does not silently route from the first town match. Photon results distinguish building addresses, street locations and place centres.
- Address, village, GPS and map selections open a starting-point confirmation screen. Drag the pin or tap the street map, choose driving/walking, and confirm before a new road-route request. Village centres are explicitly approximate. The street-map preview falls back to terrain picking when tiles are unavailable. Changing the address cancels pending selection work. No saved-home account or address persistence is required. Existing explicit shared links and recording presets retain their direct preview behaviour.

- Terrain loads from the bundled `/terrain/kelantan-scene.{json,png}`. This is the frontend's full-state bbox, not C's smaller hazard-model bbox. The scene asset is 600 × 744, about 1 MB. `node apps/web/scripts/bake-scene-terrain.mjs` rebuilds it from public AWS z10 tiles, without a database write. Startup does not contact AWS. Fonts, 2D street tiles, addresses and detailed street assets can still need a network.
- The live control room requests `/api/regions/kelantan/hazards?mode=live|replay&ts=…`, refreshes on the replay clock, reconnect and hazard SSE events, and clears unavailable results. Scenario requests abort superseded work and discard late responses. Five-second reconciliation deduplicates unchanged scenario queries; live refreshes once per minute.
- **Inspect 24 Dec 2014** reads a historical snapshot without starting the database replay or triggering an agent run. The slider inspects ±36 hours around the selected anchor and debounces requests. Follow scenario clock resumes the operator clock. A manual agent run uses the selected historical timestamp when inspecting replay.
- Flooded road lines, landslide cells and runouts come directly from the API. The shaded likely/worst water is a **frontend display approximation**, not an API flood polygon: sample gauge levels near the bundled mapped rivers, inside API coverage, within 20 km of the nearest gauge, only at alert or above. Stale/missing gauges do not create water. The river display subset and coarser frontend DEM can differ from C's road model. Road counts remain authoritative for the API scenario; unshaded areas never mean clear. Likely and faint worst-case water are separate meshes.
- Resident/landing/street views retain the explicitly labelled reconstructed 2014 terrain model; they are not live hazard predictions. Resident routing uses B's real evacuation-route API and displays its uncertainty and unsupported modes.
- Search in the control-room disclosure has Places and Knowledge modes. Knowledge shows hybrid/Voyage reranking only when `reranked` is true, before/after rank, passages and HTTP(S) source links. Place results can fly the camera. Errors remain visible; scripted mode makes no search calls.
- Approved/sent alert cards and matched official resident alerts have Malay/English recording controls for B's `/alerts/:id/audio/:lang`. Recordings load only on demand. Not-ready/404 errors show a retry action. Scripted alerts do not request real recordings. The resident estimate's Listen button is still browser speech and is separate from an official recording.
- Village-specific subagent/check/replan steps move the control-room camera. The current contract has no village ID on AgentStep, so movement uses only explicit known village name prefixes in B's summaries, with a three-second movement throttle. It does not guess a village for generic steps. Route selection still draws the real alert route.
- Alerts support human approval/rejection and priority pickups. Saint supports handoff briefs, explicit acknowledgement and pasted reports; opening WhatsApp is not delivery confirmation. Public-demo write restrictions remain in place.
- The street-map library loads only when opening a route. `?demo=1` enables recording fonts, keys 1–6 and an FPS/geometry counter. Keyboard shortcuts do not fire while editing inputs, textareas or selects.

## Validation and rehearsal

Run from the repository root with its pinned pnpm (or use the existing local binaries):

```sh
corepack pnpm typecheck
corepack pnpm --filter @monsoonwatch/web test:integration
corepack pnpm --filter @monsoonwatch/web build
```

Regression tests cover frontend HTTP/SSE contracts, route wording, Saint errors, explicit scripted mode, scenario selection/race cancellation, and stale/missing/out-of-coverage water exclusion. `/tests/frontend-preview.html` exercises search and recording states with a simulated search API; it is excluded from production output.

Verified in this checkout: all four workspace TypeScript projects, 20 frontend tests and the production build pass. Browser checks covered desktop and phone layouts, the scripted fail/replan/pass flow, historical snapshot/slider, deferred street-map loading, search text/URL handling, and recording error/retry states. The real hybrid endpoint returned three Voyage-reranked hits. The desktop recording view measured about 120 fps here; this is not a guarantee for another laptop. Initial JavaScript is about 251 KB gzip (down from 462 KB), with the street map loaded separately; Vite still reports large chunks. Real generated speech playback and a deployed rehearsal remain unverified.

Rehearse:

1. Open `/?demo=1#control`, inspect the 24 Dec snapshot and move the slider. Check the timestamp, flooded/unknown road counts and uncertainty labels. This only reads data.
2. Open Places/Knowledge search. Try a town and a flood-history question. Confirm the rerank badge reflects the response. Use Source for citations.
3. Open `/?mock=1&demo=1#control`. Run the scripted agent and show fail → replan → pass → approval → Saint. This spends no model credits and sends no real messages.
4. Choose a home and open its route. Verify the 2D map loads on demand and the 3D fallback still works without map tiles.
5. On the presentation laptop and a phone, check scrolling, frame rate, cold startup and route readability. Bundled terrain works without AWS; the whole app is not an offline cache.

## Remaining backend/team work

- B's two newer commits on origin/b/argon-shortlist were fetched but are not merged into this checkout. They include improved centre screening and district advisories. Merge/review through the team's normal process.
- District evacuate warnings/advisories are B-internal objects, currently logged in HUD steps and returned internally; GET /agent/runs/:id only exposes shared alerts. They have no shared persisted shape or approval endpoint. A proper review card needs an agreed B/C shared contract, storage, SSE/retrieval and authenticated approval/rejection path. Suggested fields: id, runId, kind, basis, district, level, villageIds, messages, vulnerable counts, status and decision identity/time. Existing Alert requires a village, centre and route; do not invent those for district advisories. No unsupported approval UI has been added.
- Full-page recovery of automatically triggered or old runs still needs a listing endpoint. Known manually started runs reconcile every five seconds.
- Real paid agent/TTS runs, current Atlas processor health, actual delivery and deployed hosting are not established by local frontend tests. B/C and an operator must complete these checks with intended credentials/destinations. Old billing-cap notes are historical, not a current diagnosis.
- Render deployment configuration remains documented in the root DEPLOYMENT.md. Review the build, SSE, public-demo restrictions and Atlas networking at the deployed URL. No deployment or real message delivery is performed by frontend verification.
