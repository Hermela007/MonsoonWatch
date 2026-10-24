// Hazards for a region at a time (C6): flooded road segments + water levels (+ landslide from B).
//   getHazards(regionId, ts, mode) → shared `Hazards` plus extra fields: approximate, notes, gauges, worst.
// Call in-process (B's situation) or via GET /api/regions/:id/hazards. Model + assumptions: ./water.ts
// and docs/HAZARDS.md. Needs `pnpm build:terrain` + `pnpm prep:hazards` to have run.
import { COLLECTIONS, type Hazards, type LngLat, type Region, type Station } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import {
  floodedSegmentIds, highestRisk, levelName, replayLevels, FLOODPLAIN_M, MAX_GAUGE_DIST_M, REPLAY_CURVE_M3S, UNCERTAINTY_M,
  type Gauge, type GaugeLevel, type Segment,
} from "./water";

export type HazardMode = "live" | "replay";

export interface HazardsResult extends Hazards {
  approximate: true;
  notes: string[];
  gauges: (GaugeLevel & { name: string; lngLat: LngLat; level: string; thresholds: Gauge["thresholds"] })[];
  worst: { blockedRoadIds: string[] };
}

/** Landslide is B's (B5 computeLandslide). Register it with setLandslideProvider; until then it's empty. */
export type LandslideProvider = (ctx: { regionId: string; ts: Date; mode: HazardMode }) => Promise<Hazards["landslide"]> | Hazards["landslide"];
let landslideProvider: LandslideProvider = () => ({ cells: [], runouts: [] });
export function setLandslideProvider(fn: LandslideProvider): void {
  landslideProvider = fn;
}

const LIVE_MAX_AGE_MS = 24 * 3600 * 1000; // ignore gauges with no live reading in the last 24 h
const REPLAY_MAX_AGE_MS = 2 * 24 * 3600 * 1000; // GloFAS is daily

interface RegionModel {
  region: Region;
  gauges: Gauge[];
  segments: (Segment & { coords: LngLat[] })[];
}
const models = new Map<string, Promise<RegionModel>>();

/** Region data that only changes when `pnpm prep:hazards` re-runs — cached in memory per process. */
function regionModel(regionId: string): Promise<RegionModel> {
  let m = models.get(regionId);
  if (!m) {
    m = loadModel(regionId);
    m.catch(() => models.delete(regionId)); // retry next time
    models.set(regionId, m);
  }
  return m;
}

/** Drop the cache (e.g. after re-running prep:hazards in a long-lived API). */
export function invalidateHazardsCache(regionId?: string): void {
  if (regionId) models.delete(regionId);
  else models.clear();
}

async function loadModel(regionId: string): Promise<RegionModel> {
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: regionId });
  if (!region) throw new Error(`Region "${regionId}" not found`);
  const stations = await db
    .collection<Station & { hazardGauge?: { usable: boolean; cellId: string } }>(COLLECTIONS.stations)
    .find({ regionId, kind: "river", "hazardGauge.usable": true }, { projection: { name: 1, location: 1, thresholds: 1, hazardGauge: 1 } })
    .toArray();
  const gauges: Gauge[] = stations
    .filter((s) => s.thresholds)
    .map((s) => ({ id: s._id, name: s.name, lngLat: s.location.coordinates, thresholds: s.thresholds!, cellId: s.hazardGauge!.cellId }));
  type Doc = { _id: string; geometry: { coordinates: LngLat[] }; hazard?: { groundM: number | null; riverDistM: number | null; gaugeId: string | null; gaugeDistM: number | null } };
  const docs = await db
    .collection<Doc>(COLLECTIONS.geo)
    .find({ regionId, layer: "road" } as never, { projection: { "geometry.coordinates": 1, hazard: 1 } })
    .toArray();
  const segments = docs
    .filter((d) => d.hazard)
    .map((d) => ({ id: d._id, coords: d.geometry.coordinates, groundM: d.hazard!.groundM, riverDistM: d.hazard!.riverDistM, gaugeId: d.hazard!.gaugeId, gaugeDistM: d.hazard!.gaugeDistM }));
  if (segments.length === 0) throw new Error(`No road segments with hazard data for "${regionId}" — run \`pnpm prep:hazards\``);
  return { region, gauges, segments };
}

async function liveLevels(gauges: Gauge[], ts: Date): Promise<GaugeLevel[]> {
  const rows = await (await getDb())
    .collection(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; value: number; ts: Date }>([
      { $match: { "meta.stationId": { $in: gauges.map((g) => g.id) }, "meta.mode": "live", ts: { $lte: ts, $gte: new Date(ts.getTime() - LIVE_MAX_AGE_MS) } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", value: { $first: "$value" }, ts: { $first: "$ts" } } },
    ])
    .toArray();
  return rows.map((r) => ({ id: r._id, levelM: r.value, source: "jps", readingTs: r.ts.toISOString() }));
}

async function replayDischarge(region: Region, ts: Date): Promise<Map<string, number>> {
  const rows = await (await getDb())
    .collection(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; value: number }>([
      { $match: { "meta.stationId": { $in: region.glofasCells.map((c) => c.id) }, "meta.mode": "replay", ts: { $lte: ts, $gte: new Date(ts.getTime() - REPLAY_MAX_AGE_MS) } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", value: { $first: "$value" } } },
    ])
    .toArray();
  return new Map(rows.map((r) => [r._id, r.value]));
}

export class RegionNotFoundError extends Error {}

export async function getHazards(regionId: string, ts: Date = new Date(), mode: HazardMode = "live"): Promise<HazardsResult> {
  let model: RegionModel;
  try {
    model = await regionModel(regionId);
  } catch (err) {
    if (err instanceof Error && err.message.includes("not found")) throw new RegionNotFoundError(err.message);
    throw err;
  }
  const { region, gauges, segments } = model;
  const levels = mode === "live" ? await liveLevels(gauges, ts) : replayLevels(gauges, await replayDischarge(region, ts));
  const margin = UNCERTAINTY_M[mode];

  const blocked = new Set(floodedSegmentIds(segments, gauges, levels));
  const worstIds = floodedSegmentIds(segments, gauges, levels, margin);
  const blockedSegs = segments.filter((s) => blocked.has(s.id));
  const top = highestRisk(gauges, levels);
  const byGauge = new Map(gauges.map((g) => [g.id, g]));
  const gaugeOut = levels.map((l) => {
    const g = byGauge.get(l.id)!;
    return { ...l, name: g.name, lngLat: g.lngLat, level: levelName(l.levelM, g.thresholds), thresholds: g.thresholds };
  });

  const notes = [
    "APPROXIMATE flood model: a road segment is flooded when its lowest DEM ground is below the water surface at its nearest river gauge.",
    `Floodplain: within ${FLOODPLAIN_M / 1000} km of an OSM river and ${MAX_GAUGE_DIST_M / 1000} km of the gauge; no flooding while a gauge is below its JPS alert level (in-bank).`,
    `DEM: AWS Terrain Tiles (SRTM-derived), 75 m grid, vertical error several metres.`,
    `likelyLevelM/worstLevelM are at the highest-risk gauge (furthest into its alert→danger range); worst = likely + ${margin} m.`,
    mode === "replay"
      ? `RECONSTRUCTED Dec 2014: levels derived from GloFAS discharge with an approximate curve (${REPLAY_CURVE_M3S.normal} m³/s → normal, ${REPLAY_CURVE_M3S.alert} → alert, ${REPLAY_CURVE_M3S.danger} → danger level of each gauge, linear, extrapolated above).`
      : "Live levels: latest JPS reading per gauge in the last 24 h (metres above mean sea level).",
    "Landslide: provided by the agent's screening model when registered; empty otherwise.",
  ];

  return {
    regionId,
    ts: ts.toISOString(),
    mode,
    water: {
      likelyLevelM: top ? top.level.levelM : 0,
      worstLevelM: top ? Math.round((top.level.levelM + margin) * 100) / 100 : 0,
      byCell: levels.map((l) => ({ id: l.id, levelM: l.levelM })),
    },
    landslide: await landslideProvider({ regionId, ts, mode }),
    blockedRoads: { type: "MultiLineString", coordinates: blockedSegs.map((s) => s.coords) },
    blockedRoadIds: blockedSegs.map((s) => s.id),
    approximate: true,
    notes,
    gauges: gaugeOut,
    worst: { blockedRoadIds: worstIds },
  };
}
