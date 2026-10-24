# Hazards model & approximations

`GET /api/regions/:id/hazards?ts=<ISO>&mode=live|replay` (or `getHazards()` in-process, `apps/api/src/hazards/index.ts`)
says which road segments are flooded at a time. It is a **screening model for a demo**, not hydraulics.
Every response carries `approximate: true` and `notes[]`; the UI must label the flood layer as approximate.

## Pipeline

| Step | Command / file | Output |
|---|---|---|
| Terrain | `pnpm build:terrain` (`scripts/build-terrain.ts`) | `apps/api/data/terrain/kelantan.elev.{json,i16.gz}` (75 m grid, 4.1 MB), `apps/web/public/terrain/kelantan.png` (150 m heightmap, 2.0 MB), `Region.terrain` |
| Precompute | `pnpm prep:hazards` (`scripts/prep-hazards.ts`) | `hazard` field on every road segment in `geo`, `hazardGauge` on river stations, JPS datum check |
| Model | `apps/api/src/hazards/water.ts` (pure, tested in `water.test.ts`) | flooded segment ids, levels |
| API | `apps/api/src/hazards/index.ts`, `routes/hazards.ts` | `Hazards` + `approximate`, `notes`, `gauges`, `worst` |

Re-run `pnpm prep:hazards` after `pnpm load:osm` (which replaces the geo docs) or `pnpm build:terrain`, then restart the API (segments are cached in memory).

## Terrain
- **Source:** AWS Terrain Tiles (Terrarium PNGs, `elevation_m = R·256 + G + B/256 − 32768`), **zoom 11**: ~76 m/px natively here, which matches the 75 m model grid. z12 would quadruple the files for detail the SRTM-derived data (several metres vertical error, canopy/buildings included) can't support.
- Resampled (bilinear) from Web Mercator to a **regular lon/lat grid** over `Region.bbox`: pixel (col,row) centre = `minLon + (col+0.5)·dLon`, `maxLat − (row+0.5)·dLat`, row 0 = north.
- **Voids:** tile values below −50 m (the sea here is shallower) are voids (66 px, down to −1,820 m) and are filled from neighbouring pixels.
- **Heightmap for the web:** 776×1262 px, ~150 m/px, same Terrarium RGB encoding (lossless). Range −26…2,176 m.
- **Spot checks:** Kota Bharu 11 m, Gua Musang town 131 m, Kuala Krai 40 m, Gunung Gagau area max 1,350 m (real summit ~1,376 m).

## JPS datum check (`pnpm prep:hazards`)
JPS river levels are **metres above mean sea level**. At correctly located gauges, the live level is within a few metres of the
**valley floor** (lowest DEM within 1 km ≈ the river channel): Kuala Krai +0.1 m, Dabong −1.9 m, Limau Kasturi +1.1 m,
Jerimbong −0.1 m, Pasir Puteh +0.4 m, Tambatan D'Raja +0.8 m. Median gap −0.1 m, 18/26 within ±10 m.
Against the DEM *at the geocoded point* only 8/26 are within ±10 m (median −10.5 m): that point is usually the bank or
town, 10–30 m above the water in incised valleys, so it is the wrong comparison.

**Gauges used:** 18 of 35. A gauge is **excluded** when its location is a district centre (too coarse), it lies
outside the DEM, it has no thresholds, or its live level is **> 10 m from the valley floor** — that means Nominatim put it
in the wrong place (Kg. Pulai +106 m, Kg. Lembaga +84 m, Kusial −272 m, Tualang +20 m, …). Fixing those geocodes
(`locationSource: "manual"`) would add them back.

## Road segment precompute (`hazard` field on `geo` road docs; not part of the shared contract)
- `groundM`: **lowest** DEM elevation sampled along the segment (every ~40 m + vertices). **Bridges** (OSM `bridge=*`, 2,177
  segments) use the lower of their two end points instead, otherwise every bridge would "flood" from the river under it.
- `riverDistM`: distance to the nearest OSM `waterway=river` line. `riverName`: its name (465 of 883 river ways are unnamed).
- `gaugeId`: nearest usable gauge **on the same named river**; if the river is unnamed or has no gauge, the nearest usable gauge overall. `gaugeDistM` = straight-line distance.
- `cellId`: nearest GloFAS cell (used for gauges in the replay).

## Water levels
- **Live:** latest JPS reading per usable gauge in the 24 h before `ts`.
- **Replay (RECONSTRUCTED Dec 2014):** GloFAS gives daily discharge, not levels. Each gauge gets a level from its nearest
  main-channel cell's discharge with an **APPROXIMATE** piecewise-linear curve on the gauge's own JPS thresholds:
  **500 m³/s → normal, 1,500 → alert, 4,500 → danger**, clamped at normal below 500, extrapolated above 4,500 with the
  alert→danger slope. Same anchors as the `riskRiver` stream processor. This is a basin-wide severity index, not a rating curve.
- **Calibration on official 2014 peaks (APPROXIMATE):** the uncalibrated curve under-flooded Kuala Krai town (26.2 m at the
  24 Dec GloFAS peak vs 34.17 m recorded). [`apps/api/src/hazards/calibration-2014.json`](../apps/api/src/hazards/calibration-2014.json)
  holds the recorded peaks from the JPS table "Laporan Catatan Aras Air Tertinggi" (1 Dec 2014 – 10 Feb 2015), reproduced in
  <https://cgss.usm.my/images/Air_-_Prof._Ir._Mohd_Nordin_Adlan.pdf>, with per-gauge timestamps. For a calibrated gauge the curve
  gets one extra **top anchor: (its GloFAS cell's own Dec 2014 peak discharge → the official peak level)**; the normal/alert/danger
  anchors stay, except any at or above the peak (in discharge or level), which is dropped so the curve keeps rising. Linear between
  anchors, extrapolated above the top one with the last segment's slope (never reached in the replay: the cell peak is the series
  maximum). Uncalibrated gauges keep the 500/1,500/4,500 curve. Cell peaks come from the replay readings at load time.
- **Timing is not calibrated:** GloFAS peaks on **24 Dec** in all four cells (5,139–5,187 m³/s), so every calibrated gauge reaches its
  peak on 24 Dec in the replay, while the real peaks were staggered (Tualang 24 Dec 06:00, Dabong 24 Dec 16:00, Kuala Krai 25 Dec
  15:00, Guillemard and Tambatan DiRaja 26 Dec 00:00; Rantau Panjang and Pasir Puteh peaked earlier, on 18 Dec).

| Official gauge (JPS table) | Our station | Thresholds (table vs ours) | Peak | Used |
|---|---|---|---|---|
| Sg. Galas, Dabong | `gen-WL-54255735a9` Sg. Galas di Dabong | 28/32/35/38 vs 28/35/37/38 — **alert/warning differ** | 46.47 m, 24 Dec 16:00 | ✅ |
| Sg. Lebir, Tualang | `0730971WL` Sg. Lebir di Kg. Tualang | 23/27/31/35 vs 23/30/34/35 — **alert/warning differ** | 42.17 m, 24 Dec 06:00 | — gauge excluded (mis-geocoded) |
| Sg. Kelantan, Tangga Krai | `gen-WL-a1dafac05a` Sg. Kelantan di Kuala Krai | 17/20/22.5/25 — match | 34.17 m, 25 Dec 15:00 | ✅ |
| Sg. Kelantan, Jambatan Guillemard | **not mapped** — `0731371WL` Kusial or `gen-WL-cf8c18d849` Kusial Baru (both 7/12/14/16 vs 10/12/14/16) | ambiguous | 22.74 m, 26 Dec 00:00 | — (both excluded anyway) |
| Sg. Kelantan, Tambatan DiRaja | `0730671WL` Sg. Kelantan di Tambatan D'Raja | 1/3/4/5 — match | 6.89 m, 26 Dec 00:00 | ✅ |
| Sg. Golok, Rantau Panjang | `0740121WL` Sg. Golok di Rantau Panjang | 5/7/8/9 — match | 10.84 m, 18 Dec 11:00 | ✅ |
| Sg. Golok, Jenob | `0740261WL` Sg. Golok di Kg. Jenob | 19/21.5/22.5/23.5 — match | 24.93 m (date garbled in source) | — gauge excluded |
| Sg. Semerak, Pasir Puteh | `0731001WL` Sg. Semerak di Pasir Puteh | 0.4/2/2.3/3 vs 2/2.5/3/3.2 — **all differ** | 2.67 m, 18 Dec 07:00 | ✅ (peak < our danger 3.2 → danger anchor dropped) |

Threshold differences are between the 2014 table and today's JPS thresholds; the curve uses today's (ours) for the lower anchors.
Replay 24 Dec levels at the calibrated gauges now equal the official peaks (Dabong 46.47, Kuala Krai 34.17, Tambatan DiRaja 6.89,
Rantau Panjang 10.84, Pasir Puteh 2.67 m; before: 38.69, 26.15, 5.43, 9.44, 3.35 m).
- **Likely vs worst:** worst = likely + **0.5 m live** (next hours' rise of ~0.1–0.3 m/h plus sensor error) or **+2.0 m replay**
  (curve error; kept after calibration because timing and the gauges in between are not calibrated). `blockedRoadIds` uses *likely*; the extra field `worst.blockedRoadIds` uses *worst*.
- `water.byCell`: one entry per usable gauge (`id` = JPS station id) with its `levelM`. `likelyLevelM` / `worstLevelM` are the
  values at the **highest-risk gauge** = the one furthest into its alert→danger range (`(level − alert)/(danger − alert)`),
  not the highest absolute level (gauges range from ~1 m at the coast to ~100 m upstream). Extra field `gauges[]` adds
  name, location, level name, thresholds, source and (replay) discharge.

## Flooded roads
A segment is flooded (likely) when **all** hold:
1. within **3 km** of an OSM river line (floodplain),
2. within **20 km** of its gauge (the river surface slopes ~0.25 m/km on the main channel, so a far gauge's level is wrong),
3. its gauge is **at or above its JPS alert level** (below alert the river is in its banks, so low DEM pixels along the
   channel must not flood),
4. `groundM` < the gauge's water level.

Returned as `blockedRoadIds` (for B's `planRoute` / route check) and `blockedRoads` (MultiLineString, for A).
Limitations: nearest-gauge water surface (no slope interpolation), DEM vertical error, no levees/embankments, no rainfall
ponding away from rivers, no flow routing.

## Results (24 Oct 2026, after calibration)
| Case | Blocked (likely / worst) | Where |
|---|---|---|
| Replay 12 Dec 2014 (before) | 0 / 4,361 | — (unchanged by calibration) |
| Replay 24 Dec 2014 (peak) | 14,172 / 27,209 (uncalibrated: 11,946 / 22,173) | Bachok 4,326 · Pasir Mas 2,606 · Kota Bharu 2,139 · Tanah Merah 1,668 · Jeli 1,363 · Pasir Puteh 1,074 · **Kuala Krai 773** (was 115) · Tumpat 166 · Machang 35 · Gua Musang 22 |
| Live now | 0 | all gauges below alert |

Within 8 km of a town at the 24 Dec peak (uncalibrated → calibrated): **Kuala Krai 8 → 411**, Manik Urai 21 → 55, Dabong 60 → 247,
Tanah Merah 388 → 388, Pasir Mas 780 → 876, Kota Bharu 545 → 1,392.

Fail → replan cases for the agent (replay), all dry on 12 Dec:
- **Manek Urai → SMK Manek Urai** (3.1 km): cut on 24 Dec (`758750157:1`, `758750181:0`), no dry road route.
- **Kuala Gris → SK Dabong** (13.5 km): cut on 24 Dec (`423971461:2`, `423971461:3`, `236081850:0`). Before calibration it had a
  +10.9 km dry detour; now **no dry road route** (Dabong floods).
- **Kampung Wakaf Bata → SMK Dato' Mahmud Paduka Raja (2)** (Tanah Merah, 4.2 km): cut on 24 Dec (`421609682:0`), **dry detour
  10.3 km (+6.1 km)** — the fail → replan → pass case.

## Landslide
Owned by B (B5 `computeLandslide`, registered with `setLandslideProvider(fn)` from `apps/api/src/hazards`). Every response has the
extra field **`landslideLabel`: "Screening tool. Shows where to check first. Does not replace an on-site engineer."**; the same
sentence is added to `notes` whenever `landslide.cells` or `landslide.runouts` is non-empty. The UI must show it on the landslide layer.
