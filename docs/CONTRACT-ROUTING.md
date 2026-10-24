# Routing data contract — C's side (hazards, road status, centres, provenance)

**Status: PROPOSED** — the C-side details below need A and B to agree. The contract itself is already agreed:
**IMPLEMENTATION §1.7 decision 7** and [`packages/shared/src/routing.ts`](../packages/shared/src/routing.ts)
(`EvacuationRoute`, `RoadHazardStatus`, `CentreStatus`). This file does not restate those decisions; it says how C's
data fills them, and lists what is new or differs.

## 1. Scenario time
- One scenario = **`ts` (ISO) + `mode` (`live` | `replay`)**. The same pair drives the map (`/hazards`), road status
  (`getRoadStatus`), centre status (`/evac-centres`) and B's route (`routing.ts` `query.ts`, `query.mode`).
- In a replay, the UI takes `ts` from each SSE `replay.tick { ts }` and passes it with `mode=replay` everywhere.
- A date-only `ts` (`2014-12-24`) means the end of that day, Malaysia time (UTC+8), same as replay ticks.
- **Replay readings** are daily GloFAS values stamped end-of-day MYT. Between two daily values, discharge is
  interpolated linearly per cell (24 Dec 12:00 lies between 23 and 24 Dec). No value within 36 h → no data.
- **Live readings**: the latest JPS reading ≤ `ts`; older than **2 h** → stale.
- Results are cached per region + mode + bucket (live 5 min, replay 1 min). Responses carry `ts` (requested),
  `assessedAt` (scenario time used, = routing.ts `hazards.assessedAt`), `generatedAt` and `version` (cache key;
  changes when the road/gauge model or the scenario changes, = routing.ts `version`).

## 2. Road status — `RoadHazardStatus` (routing.ts)
`getRoadStatus(regionId, ts, mode)` in [`apps/api/src/hazards/index.ts`](../apps/api/src/hazards/index.ts), rules in
[`hazards/status.ts`](../apps/api/src/hazards/status.ts):

| Status | Meaning (C's rule) |
|---|---|
| `flooded` | In the model's blocked set (= `/hazards` `blockedRoadIds`): within 3 km of a river, its gauge fresh and ≥ alert, lowest ground below the water level. |
| `clear` | Assessed (in the floodplain, usable fresh gauge within 20 km, ground known) and above the water. |
| `outside_floodplain` | > 3 km from any mapped OSM river (or none within ~20 km). River flooding not expected; **surface/local flooding is NOT modelled**. |
| `unknown` | In the floodplain but: no usable gauge within 20 km (excluded/mis-geocoded gauges), gauge reading stale/missing at `ts`, or no ground elevation. Also any segment without precomputed hazard data. |

- An `unknown` segment is never in `blockedRoadIds` and never `clear` (the blocked set is computed from fresh levels only).
- Counts use routing.ts `hazards.segments` keys: `{ flooded, clear, outsideFloodplain, unknown }`.
- `landslideRoadIds`: segments crossing one of B's landslide runout lines at that scenario (bbox prefilter + exact
  test). Separate from flooding; feeds routing.ts `hazards.landslideRunoutsCrossed`.

## 3. Closures
No official road-closure feed (JKR/police) is available. `confirmedClosures` = `{ available: false, source: null }`
(routing.ts shape). **Absence of closures is not confirmation that roads are open** — this sentence is in `limitations`.

## 4. Centre status — `CentreStatus` (routing.ts)
`GET /api/regions/:id/evac-centres?ts&mode` (and `getCentreStatuses`). Per centre, the routing.ts centre fields
`status`, `source` (`osm-candidate` | `manual`), `capacityEstimated`, `headcountUpdatedAt` (set when a Saint "arrived"
check-in changes the headcount), plus `statusReason`, `statusBasis`, `statusAt` (= `ts`), `mode`.

| Status | Rule |
|---|---|
| `at_risk` | In the floodplain, usable fresh gauge, gauge ≥ alert and ground below the **likely** level (`statusBasis: "likely"`) — or only within the uncertainty margin, likely + 0.5 m live / + 2 m replay (`statusBasis: "uncertainty_margin"`). |
| `unknown` | In the floodplain without a usable fresh gauge, or no ground elevation. |
| `usable` | Assessed and above the water, gauge below alert (in-bank), or outside the floodplain (reason says surface flooding isn't modelled). |

## 5. Coverage, provenance, limitations (`/hazards` extras)
- `coverage`: `roadsSource: "OpenStreetMap"`, `roadsSnapshot`, `highwayClasses`, `footpaths: false`, `bbox`, `knownGaps[]`
  (west of 101.6°E (Lojing) and the far south are outside the bbox; Kelantan roads only; unmapped roads; excluded gauges).
- `sources[]`: plain strings (routing.ts shape) naming the source, URL and snapshot/reading time where known.
- `limitations[]`: no footpaths; no closures feed; estimated capacities; OSM-candidate centres; GloFAS replay
  approximate and timing uncalibrated; surface flooding not modelled; nearest-gauge water surface, DEM error.
- Also: `gauges[]` with `readingTs`, `stale`, `interpolated`; `gaugesWithoutReading[]`; `roadStatusCounts`,
  `unknownReasons`, `unknownRoadIds`, `landslideRoadIds`.

## 6. Travel restrictions on roads
Optional `RoadProps` (shared, additive): `oneway` (`forward` = from → to, `reverse`, `no`; roundabouts forward),
`bridge`, `access`, `maxweightT`, `surface` — copied from OSM tags; absent = not tagged (not "no restriction").
`planRoute` does not use them yet (B to decide).

## 7. Read-only public demo
Governed by **§1.7 decision 8** (`PUBLIC_DEMO=1`, A). Not changed here.

## 8. Costs already running
| Item | Cost |
|---|---|
| MongoDB Atlas M10 cluster | ~$0.09/h |
| 2 Atlas Stream Processing processors (SP2) | ~$0.13/h |
| Voyage rerank (`$rerank`) | within free tokens |
| JPS ingest | every 15 min from Heru's laptop (stops when the laptop does: live data then turns stale → `unknown`) |

## 9. Differences from the spec, and proposed routing.ts changes (for A + B to agree)
Kept to routing.ts where C's spec differed:
- `confirmedClosures` has no `note` field (routing.ts is `{ available, source }`); the sentence is in `limitations`.
- `sources` are strings, not `{ name, url, retrievedAt }` objects.
- Count keys are camelCase `outsideFloodplain` (routing.ts `hazards.segments`), while the status value is `outside_floodplain`.

Proposed (not made):
1. `EvacuationRoute.centre` and `alternatives[]`: add `statusReason` (why at_risk/unknown) and `statusBasis`.
2. `EvacuationRoute.hazards.confirmedClosures`: add `note` (the "absence ≠ open" sentence), if A wants it on the card.
3. Structured `sources: { name, url, retrievedAt }[]` instead of strings.
4. `EvacuationRoute`: add `coverage` (roads snapshot, footpaths, known gaps) so the route card can show it.
5. `hazards.segments`: optionally `unknownReasons` (`no_ground`, `no_gauge_in_range`, `stale_gauge`).
