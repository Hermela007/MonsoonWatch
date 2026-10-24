// Hazards for a region at one scenario time (ts + mode): flooded road segments, water levels, road and centre
// status, landslide (from B). One cached Scenario per region + mode + time bucket feeds all of them, so the
// map, hazards and routes always agree on the time.
//   getHazards(regionId, ts, mode)       → shared `Hazards` + provenance/coverage extras (GET /regions/:id/hazards)
//   getRoadStatus(regionId, ts, mode)    → per-segment RoadHazardStatus + landslideRoadIds (B's routing, in-process)
//   getCentreStatuses(regionId, ts, mode) → per-centre CentreStatus (GET /regions/:id/evac-centres)
// Statuses and names follow packages/shared/src/routing.ts (§1.7 decision 7). Model + assumptions: ./water.ts,
// ./status.ts and docs/HAZARDS.md. Needs `pnpm build:terrain` + `pnpm prep:hazards` to have run.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { COLLECTIONS, type EvacCentre, type Hazards, type LngLat, type Region, type RoadHazardStatus, type Station } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import {
  centreStatus, countStatuses, interpolateDaily, isStaleLive, roadStatus, roadsCrossingRunouts, bboxOf,
  LIVE_STALE_MS, REPLAY_MAX_GAP_MS, type Bbox, type CentreHazard, type CentreStatus, type RoadStatusCounts, type TimedValue, type UnknownReason,
} from "./status";
import {
  floodedSegmentIds, highestRisk, levelName, replayLevels, FLOODPLAIN_M, MAX_GAUGE_DIST_M, REPLAY_CURVE_M3S, UNCERTAINTY_M,
  type Gauge, type GaugeLevel, type PeakCalibration, type Segment,
} from "./water";

export type HazardMode = "live" | "replay";
export type { RoadStatusCounts, UnknownReason, CentreStatus };

export const LANDSLIDE_LABEL = "Screening tool. Shows where to check first. Does not replace an on-site engineer.";

/** A usable gauge with its reading at ts. stale = not fresh (live > 2 h old) → its segments are "unknown" and
 *  its level is shown for information only. Gauges with no reading at all are in `gaugesWithoutReading`. */
export interface GaugeOut {
  id: string;
  name: string;
  lngLat: LngLat;
  thresholds: Gauge["thresholds"];
  levelM: number;
  level: string; // normal | alert | warning | danger at levelM
  source: GaugeLevel["source"];
  readingTs: string | null; // live: JPS reading time; replay: the daily value interpolation starts from
  stale: boolean;
  interpolated?: boolean; // replay: between two daily values
  dischargeM3s?: number;
  calibratedPeakM?: number;
}

export interface HazardsResult extends Hazards {
  approximate: true;
  generatedAt: string;
  assessedAt: string; // scenario time the model was computed for (≤ 5 min from ts in live mode)
  version: string; // changes when the road/gauge model or the scenario changes (cache key)
  notes: string[];
  gauges: GaugeOut[];
  gaugesWithoutReading: { id: string; name: string; lngLat: LngLat }[];
  worst: { blockedRoadIds: string[] };
  roadStatusCounts: RoadStatusCounts; // key names as routing.ts hazards.segments
  unknownReasons: Record<UnknownReason, number>;
  unknownRoadIds: string[];
  landslideRoadIds: string[];
  confirmedClosures: { available: false; source: null }; // routing.ts shape
  coverage: Coverage;
  sources: string[]; // routing.ts: plain strings
  limitations: string[];
  /** UI label for the landslide layer (always present; also added to notes when landslide data exists). */
  landslideLabel: string;
}

export interface Coverage {
  roadsSource: "OpenStreetMap";
  roadsSnapshot: string | null;
  highwayClasses: string[];
  footpaths: false;
  bbox: Region["bbox"];
  knownGaps: string[];
}

export interface RoadStatusResult {
  regionId: string;
  ts: string;
  mode: HazardMode;
  assessedAt: string;
  version: string;
  /** Status of every road segment id in /geo (segments without hazard data are "unknown"). */
  statusById: ReadonlyMap<string, RoadHazardStatus>;
  status(id: string): RoadHazardStatus; // "unknown" for ids the model doesn't know
  counts: RoadStatusCounts;
  unknownReasons: Record<UnknownReason, number>;
  /** Segments crossing a landslide runout line (B's screening model) at this time. Separate from flooding. */
  landslideRoadIds: string[];
  source: string; // for routing.ts hazards.source
}

export interface CentreWithStatus extends EvacCentre {
  status: CentreStatus;
  statusReason: string;
  statusBasis: "likely" | "uncertainty_margin" | null; // for at_risk: which level put it at risk
  statusAt: string; // = scenario ts
  mode: HazardMode;
  source: string; // "osm-candidate" | "manual"
  capacityEstimated: boolean;
  headcountUpdatedAt: string | null;
}

/** Official Dec 2014 peaks (JPS table, see the file's `source`) — replay curve top anchors. */
interface CalibrationFile {
  source: { title: string; url: string };
  gauges: { official: string; stationId: string | null; peakM: number; peakAt: string | null }[];
}
export const CALIBRATION_2014: CalibrationFile = JSON.parse(readFileSync(new URL("./calibration-2014.json", import.meta.url), "utf8"));
/** GloFAS cells' "own Dec 2014 peak" is taken from replay readings in this window. */
const DEC_2014 = { from: new Date("2014-12-01T00:00:00+08:00"), to: new Date("2015-01-01T00:00:00+08:00") };

/** Landslide is B's (B5 computeLandslide). Register it with setLandslideProvider; until then it's empty. */
export type LandslideProvider = (ctx: { regionId: string; ts: Date; mode: HazardMode }) => Promise<Hazards["landslide"]> | Hazards["landslide"];
let landslideProvider: LandslideProvider = () => ({ cells: [], runouts: [] });
export function setLandslideProvider(fn: LandslideProvider): void {
  landslideProvider = fn;
  scenarios.clear();
}

/** Live readings older than this aren't even reported (they would be stale anyway). */
const LIVE_LOOKBACK_MS = 24 * 3600 * 1000;
/** Same classes as scripts/load-osm.ts ROAD_RE. */
const HIGHWAY_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "*_link"];
const OSM_SNAPSHOT = "2026-10-23T23:47:06Z"; // Overpass timestamp_osm_base of scripts/data/osm/geo.kelantan.json.gz

// ---- region model (changes only when prep:hazards / load:osm re-run) --------------------------------

type ModelSegment = Segment & { coords: LngLat[]; bbox: Bbox };
interface RegionModel {
  region: Region;
  gauges: Gauge[];
  segments: ModelSegment[];
  allRoadIds: string[]; // includes segments without hazard data
  version: string;
}
const models = new Map<string, Promise<RegionModel>>();

function regionModel(regionId: string): Promise<RegionModel> {
  let m = models.get(regionId);
  if (!m) {
    m = loadModel(regionId);
    m.catch(() => models.delete(regionId)); // retry next time
    models.set(regionId, m);
  }
  return m;
}

/** Drop the caches (e.g. after re-running prep:hazards in a long-lived API). */
export function invalidateHazardsCache(regionId?: string): void {
  if (regionId) models.delete(regionId);
  else models.clear();
  scenarios.clear();
}

async function loadModel(regionId: string): Promise<RegionModel> {
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: regionId });
  if (!region) throw new Error(`Region "${regionId}" not found`);
  const stations = await db
    .collection<Station & { hazardGauge?: { usable: boolean; cellId: string } }>(COLLECTIONS.stations)
    .find({ regionId, kind: "river", "hazardGauge.usable": true }, { projection: { name: 1, location: 1, thresholds: 1, hazardGauge: 1 } })
    .toArray();
  const cellPeaks = await cellPeaksDec2014(region);
  const gauges: Gauge[] = stations
    .filter((s) => s.thresholds)
    .map((s) => {
      const calibration = calibrationFor(s._id, cellPeaks.get(s.hazardGauge!.cellId));
      return { id: s._id, name: s.name, lngLat: s.location.coordinates, thresholds: s.thresholds!, cellId: s.hazardGauge!.cellId, ...(calibration ? { calibration } : {}) };
    });
  type Doc = { _id: string; geometry: { coordinates: LngLat[] }; hazard?: { groundM: number | null; riverDistM: number | null; gaugeId: string | null; gaugeDistM: number | null } };
  const docs = await db
    .collection<Doc>(COLLECTIONS.geo)
    .find({ regionId, layer: "road" } as never, { projection: { "geometry.coordinates": 1, hazard: 1 } })
    .toArray();
  const segments = docs
    .filter((d) => d.hazard)
    .map((d) => ({
      id: d._id, coords: d.geometry.coordinates, bbox: bboxOf(d.geometry.coordinates),
      groundM: d.hazard!.groundM, riverDistM: d.hazard!.riverDistM, gaugeId: d.hazard!.gaugeId, gaugeDistM: d.hazard!.gaugeDistM,
    }));
  if (segments.length === 0) throw new Error(`No road segments with hazard data for "${regionId}" — run \`pnpm prep:hazards\``);
  const version = createHash("sha1")
    .update(JSON.stringify([docs.length, segments.length, gauges.map((g) => [g.id, g.calibration?.peakM ?? null])]))
    .digest("hex")
    .slice(0, 8);
  return { region, gauges, segments, allRoadIds: docs.map((d) => d._id), version };
}

async function cellPeaksDec2014(region: Region): Promise<Map<string, number>> {
  const rows = await (await getDb())
    .collection(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; peak: number }>([
      { $match: { "meta.stationId": { $in: region.glofasCells.map((c) => c.id) }, "meta.mode": "replay", ts: { $gte: DEC_2014.from, $lt: DEC_2014.to } } },
      { $group: { _id: "$meta.stationId", peak: { $max: "$value" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.peak]));
}

function calibrationFor(stationId: string, cellPeakM3s: number | undefined): PeakCalibration | undefined {
  const g = CALIBRATION_2014.gauges.find((c) => c.stationId === stationId);
  return g && cellPeakM3s !== undefined ? { peakM: g.peakM, cellPeakM3s } : undefined;
}

// ---- readings at ts ---------------------------------------------------------------------------------

interface Reading { levelM: number | null; readingTs: Date | null; stale: boolean; source: GaugeLevel["source"]; interpolated?: boolean; dischargeM3s?: number }

/** Live: latest reading ≤ ts per gauge (looking back 24 h); stale when older than 2 h at ts. */
async function liveReadings(gauges: Gauge[], ts: Date): Promise<Map<string, Reading>> {
  const rows = await (await getDb())
    .collection(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; value: number; ts: Date }>([
      { $match: { "meta.stationId": { $in: gauges.map((g) => g.id) }, "meta.mode": "live", ts: { $lte: ts, $gte: new Date(ts.getTime() - LIVE_LOOKBACK_MS) } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", value: { $first: "$value" }, ts: { $first: "$ts" } } },
    ])
    .toArray();
  const byId = new Map(rows.map((r) => [r._id, r]));
  return new Map(
    gauges.map((g) => {
      const r = byId.get(g.id);
      return [g.id, r ? { levelM: r.value, readingTs: r.ts, stale: isStaleLive(r.ts, ts), source: "jps" } : { levelM: null, readingTs: null, stale: true, source: "jps" }];
    }),
  );
}

/** Replay: per GloFAS cell, the daily discharge interpolated at ts (status.ts interpolateDaily), then each
 *  gauge's level from its cell with the calibrated curve. */
async function replayReadings(region: Region, gauges: Gauge[], ts: Date): Promise<Map<string, Reading>> {
  const coll = (await getDb()).collection(COLLECTIONS.rawReadings);
  const cells = region.glofasCells.map((c) => c.id);
  const side = (before: boolean) =>
    coll
      .aggregate<{ _id: string; value: number; ts: Date }>([
        { $match: { "meta.stationId": { $in: cells }, "meta.mode": "replay", ts: before ? { $lte: ts, $gte: new Date(ts.getTime() - REPLAY_MAX_GAP_MS) } : { $gt: ts, $lte: new Date(ts.getTime() + REPLAY_MAX_GAP_MS) } } },
        { $sort: { ts: before ? -1 : 1 } },
        { $group: { _id: "$meta.stationId", value: { $first: "$value" }, ts: { $first: "$ts" } } },
      ])
      .toArray();
  const [prevRows, nextRows] = await Promise.all([side(true), side(false)]);
  const tv = (rows: { _id: string; value: number; ts: Date }[]) => new Map<string, TimedValue>(rows.map((r) => [r._id, { ts: r.ts, value: r.value }]));
  const prev = tv(prevRows), next = tv(nextRows);
  const atTs = new Map(cells.map((c) => [c, interpolateDaily(prev.get(c) ?? null, next.get(c) ?? null, ts)]));
  const discharge = new Map([...atTs].filter(([, v]) => v).map(([c, v]) => [c, v!.value]));
  const levels = new Map(replayLevels(gauges, discharge).map((l) => [l.id, l]));
  return new Map(
    gauges.map((g) => {
      const l = levels.get(g.id);
      const basis = atTs.get(g.cellId);
      return [g.id, l && basis
        ? { levelM: l.levelM, readingTs: basis.basisTs, stale: false, source: "glofas-curve", interpolated: basis.interpolated, dischargeM3s: l.dischargeM3s }
        : { levelM: null, readingTs: null, stale: true, source: "glofas-curve" }];
    }),
  );
}

// ---- scenario (cached) ------------------------------------------------------------------------------

interface Scenario {
  model: RegionModel;
  ts: Date; // scenario time used (first request in the bucket)
  mode: HazardMode;
  key: string;
  readings: Map<string, Reading>;
  freshLevels: GaugeLevel[]; // usable gauges with a fresh reading — the only levels that can flood anything
  blocked: Set<string>;
  worstIds: string[];
  statusById: Map<string, RoadHazardStatus>;
  unknownReasons: Record<UnknownReason, number>;
  landslide: Hazards["landslide"];
  landslideRoadIds: string[];
}

/** Live: 5-minute buckets (JPS reports every 15 min). Replay: per minute (ticks are fixed times). */
const LIVE_BUCKET_MS = 5 * 60 * 1000;
const REPLAY_BUCKET_MS = 60 * 1000;
const MAX_SCENARIOS = 24;
const scenarios = new Map<string, Promise<Scenario>>();

export class RegionNotFoundError extends Error {}

async function scenario(regionId: string, ts: Date, mode: HazardMode): Promise<Scenario> {
  const bucket = Math.floor(ts.getTime() / (mode === "live" ? LIVE_BUCKET_MS : REPLAY_BUCKET_MS));
  const key = `${regionId}|${mode}|${bucket}`;
  let s = scenarios.get(key);
  if (!s) {
    s = computeScenario(regionId, ts, mode, key);
    s.catch(() => scenarios.delete(key));
    scenarios.set(key, s);
    while (scenarios.size > MAX_SCENARIOS) scenarios.delete(scenarios.keys().next().value!); // oldest first
  }
  return s;
}

async function computeScenario(regionId: string, ts: Date, mode: HazardMode, key: string): Promise<Scenario> {
  let model: RegionModel;
  try {
    model = await regionModel(regionId);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) throw new RegionNotFoundError(err.message);
    throw err;
  }
  const { region, gauges, segments } = model;
  const readings = mode === "live" ? await liveReadings(gauges, ts) : await replayReadings(region, gauges, ts);
  const freshLevels: GaugeLevel[] = [...readings]
    .filter(([, r]) => !r.stale && r.levelM !== null)
    .map(([id, r]) => ({ id, levelM: r.levelM!, source: r.source, ...(r.readingTs ? { readingTs: r.readingTs.toISOString() } : {}), ...(r.dischargeM3s !== undefined ? { dischargeM3s: r.dischargeM3s } : {}) }));
  const fresh = new Map(freshLevels.map((l) => [l.id, l.levelM]));
  const blocked = new Set(floodedSegmentIds(segments, gauges, freshLevels));
  const worstIds = floodedSegmentIds(segments, gauges, freshLevels, UNCERTAINTY_M[mode]);

  const statusById = new Map<string, RoadHazardStatus>(model.allRoadIds.map((id) => [id, "unknown"])); // no hazard data = unknown
  const unknownReasons: Record<UnknownReason, number> = { no_ground: 0, no_gauge_in_range: 0, stale_gauge: 0 };
  for (const seg of segments) {
    const r = roadStatus(seg, fresh, blocked);
    statusById.set(seg.id, r.status);
    if (r.reason) unknownReasons[r.reason]++;
  }
  const landslide = await landslideProvider({ regionId, ts, mode });
  const landslideRoadIds = roadsCrossingRunouts(segments, landslide.runouts);
  return { model, ts, mode, key, readings, freshLevels, blocked, worstIds, statusById, unknownReasons, landslide, landslideRoadIds };
}

const versionOf = (s: Scenario) => `${s.model.version}-${createHash("sha1").update(s.key).digest("hex").slice(0, 6)}`;
const MODEL_SOURCE = "MonsoonWatch flood model (JPS gauges, AWS Terrain Tiles DEM, OSM rivers) — approximate";

// ---- public API -------------------------------------------------------------------------------------

/** Per-segment road status for B's routing (in-process). Same scenario as getHazards. */
export async function getRoadStatus(regionId: string, ts: Date = new Date(), mode: HazardMode = "live"): Promise<RoadStatusResult> {
  const s = await scenario(regionId, ts, mode);
  return {
    regionId,
    ts: ts.toISOString(),
    mode,
    assessedAt: s.ts.toISOString(),
    version: versionOf(s),
    statusById: s.statusById,
    status: (id) => s.statusById.get(id) ?? "unknown",
    counts: countStatuses(s.statusById.values()),
    unknownReasons: { ...s.unknownReasons },
    landslideRoadIds: s.landslideRoadIds,
    source: mode === "replay" ? `${MODEL_SOURCE}; RECONSTRUCTED Dec 2014 from GloFAS` : MODEL_SOURCE,
  };
}

export async function getHazards(regionId: string, ts: Date = new Date(), mode: HazardMode = "live"): Promise<HazardsResult> {
  const s = await scenario(regionId, ts, mode);
  const { model } = s;
  const margin = UNCERTAINTY_M[mode];
  const blockedSegs = model.segments.filter((seg) => s.blocked.has(seg.id));
  const top = highestRisk(model.gauges, s.freshLevels);
  const withReading = model.gauges.filter((g) => s.readings.get(g.id)!.levelM !== null);
  const gaugesWithoutReading = model.gauges.filter((g) => s.readings.get(g.id)!.levelM === null).map((g) => ({ id: g.id, name: g.name, lngLat: g.lngLat }));
  const gauges: GaugeOut[] = withReading.map((g) => {
    const r = s.readings.get(g.id)!;
    return {
      id: g.id, name: g.name, lngLat: g.lngLat, thresholds: g.thresholds,
      levelM: r.levelM!, level: levelName(r.levelM!, g.thresholds),
      source: r.source, readingTs: r.readingTs?.toISOString() ?? null, stale: r.stale,
      ...(r.interpolated !== undefined ? { interpolated: r.interpolated } : {}),
      ...(r.dischargeM3s !== undefined ? { dischargeM3s: r.dischargeM3s } : {}),
      ...(mode === "replay" && g.calibration ? { calibratedPeakM: g.calibration.peakM } : {}),
    };
  });
  const staleCount = gauges.filter((g) => g.stale).length + gaugesWithoutReading.length;
  const counts = countStatuses(s.statusById.values());

  const notes = [
    "APPROXIMATE flood model: a road segment is flooded when its lowest DEM ground is below the water surface at its nearest river gauge.",
    `Floodplain: within ${FLOODPLAIN_M / 1000} km of an OSM river and ${MAX_GAUGE_DIST_M / 1000} km of the gauge; no flooding while a gauge is below its JPS alert level (in-bank).`,
    `Road status: "unknown" = in a river corridor without a usable, fresh gauge reading (or no ground elevation) — never shown as safe. ${counts.unknown} unknown segments; ${staleCount} of ${model.gauges.length} usable gauges have no fresh reading at this time.`,
    `DEM: AWS Terrain Tiles (SRTM-derived), 75 m grid, vertical error several metres.`,
    `likelyLevelM/worstLevelM are at the highest-risk gauge (furthest into its alert→danger range); worst = likely + ${margin} m.`,
    mode === "replay"
      ? `RECONSTRUCTED Dec 2014: levels derived from GloFAS daily discharge (linearly interpolated between daily values at ts) with an APPROXIMATE curve (${REPLAY_CURVE_M3S.normal} m³/s → normal, ${REPLAY_CURVE_M3S.alert} → alert, ${REPLAY_CURVE_M3S.danger} → danger level of each gauge, linear). Gauges with an official 2014 peak (${CALIBRATION_2014.source.url}) reach it when their GloFAS cell is at its Dec 2014 peak; peak timing is not calibrated (GloFAS peaks on 24 Dec everywhere, the real peaks were 24–26 Dec).`
      : `Live levels: latest JPS reading per gauge at or before ts; a reading older than ${LIVE_STALE_MS / 3600_000} h is stale and its segments are "unknown".`,
  ];
  if (s.landslide.cells.length > 0 || s.landslide.runouts.length > 0) notes.push(LANDSLIDE_LABEL);

  const latestLive = mode === "live" ? gauges.map((g) => g.readingTs).filter(Boolean).sort().at(-1) : null;
  const sources = [
    `OpenStreetMap roads and rivers (© OpenStreetMap contributors, ODbL) via Overpass, snapshot ${OSM_SNAPSHOT}`,
    mode === "live"
      ? `JPS Public Infobanjir river levels (publicinfobanjir.water.gov.my)${latestLive ? `, latest reading ${latestLive}` : ""}`
      : "GloFAS river discharge (reanalysis) via Open-Meteo Flood API (flood-api.open-meteo.com), Dec 2014 — RECONSTRUCTED",
    ...(mode === "replay" ? [`Official Dec 2014 peak levels: JPS "Laporan Catatan Aras Air Tertinggi" (${CALIBRATION_2014.source.url})`] : []),
    "Elevation: AWS Terrain Tiles (Terrarium, SRTM-derived), z11",
    "JPS gauge thresholds (normal/alert/warning/danger) from publicinfobanjir.water.gov.my",
    ...(s.landslide.cells.length || s.landslide.runouts.length ? ["Landslide screening: MonsoonWatch model (B) on Deep Research option A rain thresholds"] : []),
  ];
  const limitations = [
    "No footpaths: only OSM roads (motorway … residential) are mapped.",
    "No official road-closure feed (JKR/police) is available; absence of closures is NOT confirmation that roads are open.",
    "Evacuation centre capacities are estimates; most centres are OSM candidates (schools, halls, mosques), not confirmed PPS.",
    "Surface/local flooding (rain ponding, drains) is not modelled: \"outside_floodplain\" only means river flooding is not expected.",
    ...(mode === "replay" ? ["GloFAS replay is approximate and its timing is not calibrated (peaks on 24 Dec everywhere)."] : []),
    "Water surface = nearest gauge level (no slope interpolation); DEM vertical error several metres; no levees.",
  ];

  return {
    regionId,
    ts: ts.toISOString(),
    mode,
    water: {
      likelyLevelM: top ? top.level.levelM : 0,
      worstLevelM: top ? Math.round((top.level.levelM + margin) * 100) / 100 : 0,
      byCell: s.freshLevels.map((l) => ({ id: l.id, levelM: l.levelM })),
    },
    landslide: s.landslide,
    blockedRoads: { type: "MultiLineString", coordinates: blockedSegs.map((seg) => seg.coords) },
    blockedRoadIds: blockedSegs.map((seg) => seg.id),
    approximate: true,
    generatedAt: new Date().toISOString(),
    assessedAt: s.ts.toISOString(),
    version: versionOf(s),
    notes,
    gauges,
    gaugesWithoutReading,
    worst: { blockedRoadIds: s.worstIds },
    roadStatusCounts: counts,
    unknownReasons: { ...s.unknownReasons },
    unknownRoadIds: [...s.statusById].filter(([, st]) => st === "unknown").map(([id]) => id),
    landslideRoadIds: s.landslideRoadIds,
    confirmedClosures: { available: false, source: null },
    coverage: {
      roadsSource: "OpenStreetMap",
      roadsSnapshot: OSM_SNAPSHOT,
      highwayClasses: HIGHWAY_CLASSES,
      footpaths: false,
      bbox: model.region.bbox,
      knownGaps: [
        `West of ${model.region.bbox[0]}°E (Lojing) and the far south (below ${model.region.bbox[1]}°N) are outside the region bbox`,
        "Roads in Terengganu, Pahang, Perak and Thailand are not loaded (Kelantan only)",
        "Unmapped and newly built roads, tracks and footpaths are missing",
        `River gauges excluded from the model (mis-located or no thresholds) leave river corridors "unknown"`,
      ],
    },
    sources,
    limitations,
    landslideLabel: LANDSLIDE_LABEL,
  };
}

/** Status of every evac centre at ts (same scenario as the road status). */
export async function getCentreStatuses(regionId: string, ts: Date = new Date(), mode: HazardMode = "live"): Promise<CentreWithStatus[]> {
  const s = await scenario(regionId, ts, mode);
  const centres = await (await getDb())
    .collection<EvacCentre & { hazard?: CentreHazard; source?: string; capacityEstimated?: boolean; headcountUpdatedAt?: string }>(COLLECTIONS.evacCentres)
    .find({ regionId })
    .toArray();
  const fresh = new Map(s.freshLevels.map((l) => [l.id, l.levelM]));
  const gauges = new Map(s.model.gauges.map((g) => [g.id, g]));
  return centres.map(({ hazard, ...c }) => {
    const st = centreStatus(hazard, fresh, gauges, UNCERTAINTY_M[mode]);
    return {
      ...c,
      status: st.status,
      statusReason: st.reason,
      statusBasis: st.basis,
      statusAt: ts.toISOString(),
      mode,
      source: c.source ?? "unknown",
      capacityEstimated: c.capacityEstimated ?? true,
      headcountUpdatedAt: c.headcountUpdatedAt ?? null,
    };
  });
}
