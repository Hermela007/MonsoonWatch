// Wires the landslide screening (landslide.ts) to MongoDB + C's terrain, and registers it with C's
// hazards model (setLandslideProvider) so GET /api/regions/:id/hazards includes landslide cells and
// runouts for the 3D layer. Results are cached briefly per region/mode/time.

import { COLLECTIONS, type Hazards, type Station } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { setLandslideProvider, type HazardMode } from "../hazards";
import { loadElevationGrid } from "../hazards/terrain";
import { loadLandslideConfig, screenLandslides, type RainPoint, type RunoutSource } from "./landslide";

const LIVE_MAX_AGE_MS = 24 * 3600 * 1000;
const REPLAY_MAX_AGE_MS = 2 * 24 * 3600 * 1000; // replay rain is daily
const CACHE_MS = 60_000;

export interface LandslideDetail { landslide: Hazards["landslide"]; sources: RunoutSource[]; configSource: string }

const cache = new Map<string, { at: number; value: Promise<LandslideDetail> }>();

export async function rainAt(regionId: string, ts: Date, mode: HazardMode): Promise<RainPoint[]> {
  const db = await getDb();
  const stations = await db
    .collection<Station>(COLLECTIONS.stations)
    .find({ regionId, kind: "rain", location: { $exists: true } }, { projection: { location: 1 } })
    .toArray();
  if (stations.length === 0) return [];
  const maxAge = mode === "live" ? LIVE_MAX_AGE_MS : REPLAY_MAX_AGE_MS;
  const rows = await db
    .collection(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; value: number; rain6d?: (number | null)[] }>([
      { $match: { "meta.stationId": { $in: stations.map((s) => s._id) }, "meta.kind": "rain", "meta.mode": mode, ts: { $lte: ts, $gte: new Date(ts.getTime() - maxAge) } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", value: { $first: "$value" }, rain6d: { $first: "$rain6d" } } },
    ])
    .toArray();
  const loc = new Map(stations.map((s) => [s._id, s.location.coordinates]));
  return rows.filter((r) => loc.has(r._id) && typeof r.value === "number").map((r) => ({ stationId: r._id, lngLat: loc.get(r._id)!, value: r.value, rain6d: r.rain6d }));
}

export function computeLandslideDetailed(regionId: string, ts: Date, mode: HazardMode): Promise<LandslideDetail> {
  // Replay data is daily → cache per day; live per minute.
  const slot = mode === "replay" ? ts.toISOString().slice(0, 10) : String(Math.floor(ts.getTime() / CACHE_MS));
  const key = `${regionId}:${mode}:${slot}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (mode === "replay" ? 10 * CACHE_MS : CACHE_MS)) return hit.value;
  const value = (async () => {
    const grid = loadElevationGrid(regionId);
    const cfg = loadLandslideConfig(regionId);
    const rain = await rainAt(regionId, ts, mode);
    const { landslide, sources } = screenLandslides(grid, rain, cfg);
    return { landslide, sources, configSource: cfg.source };
  })();
  value.catch(() => cache.delete(key));
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** For C's hazards model: cells + runouts (empty, not an error, if terrain/rain are missing). */
export async function computeLandslide(ctx: { regionId: string; ts: Date; mode: HazardMode }): Promise<Hazards["landslide"]> {
  try {
    return (await computeLandslideDetailed(ctx.regionId, ctx.ts, ctx.mode)).landslide;
  } catch (err) {
    console.warn(`[agent] landslide screening unavailable: ${(err as Error).message}`);
    return { cells: [], runouts: [] };
  }
}

let registered = false;
/** Idempotent; called from the agent routes and the situation loader. */
export function registerLandslideProvider(): void {
  if (registered) return;
  registered = true;
  setLandslideProvider(computeLandslide);
}
