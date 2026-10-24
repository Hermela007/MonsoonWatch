// B: GET /regions/:id/evacuation-route?lng=&lat=&travel=car|walk|boat&mode=live|replay&ts=<ISO>&centreId=&people=
// → EvacuationRoute (packages/shared/src/routing.ts), A's resident journey. Thin wrapper over agent/evacuate.ts
// (the same routing the agent uses). Deterministic, no Gemini. Public GET (allowed under PUBLIC_DEMO).
// Road + centre status come from C's getRoadStatus / getCentreStatuses for the same ts + mode as /hazards; if
// the hazard model is unavailable the route is still planned, with every segment "unknown" (never "safe").

import type { FastifyInstance } from "fastify";
import { COLLECTIONS, type EvacCentre, type EvacuationRoute, type LineStringGeom, type Region, type RoadFeature, type RoadProps, TravelModeSchema } from "@monsoonwatch/shared";
import { evacuationRoute, type CentreInfo, type RoadHazards } from "../agent/evacuate";
import { buildRoadGraph, type RoadGraph } from "../agent/route";
import { getDb } from "../db/client";
import { HttpError } from "../errors";
import { getCentreStatuses, getRoadStatus, LANDSLIDE_LABEL, RegionNotFoundError } from "../hazards";
import { parseHazardsMode, parseHazardsTs } from "./hazards";

interface Query { lng?: string; lat?: string; travel?: string; mode?: string; ts?: string; centreId?: string; people?: string }

// ---- road graph cache (84k segments: build once per region) ----
const graphs = new Map<string, Promise<{ graph: RoadGraph; segments: number }>>();

async function loadGraph(regionId: string) {
  const docs = await (await getDb())
    .collection<{ _id: string; geometry: LineStringGeom; properties: RoadProps }>(COLLECTIONS.geo)
    .find({ regionId, layer: "road" } as never, { projection: { geometry: 1, properties: 1 } })
    .toArray();
  const roads: RoadFeature[] = docs.map((d) => ({ type: "Feature", id: d._id, geometry: d.geometry, properties: d.properties }));
  return { graph: buildRoadGraph(roads), segments: roads.length };
}

export function roadGraphFor(regionId: string) {
  let g = graphs.get(regionId);
  if (!g) {
    g = loadGraph(regionId);
    g.catch(() => graphs.delete(regionId)); // retry next time
    graphs.set(regionId, g);
  }
  return g;
}

/** Drop the cached graph (e.g. after C reloads the road network). */
export function invalidateRoadGraph(regionId?: string): void {
  if (regionId) graphs.delete(regionId);
  else graphs.clear();
}

// ---- query ----
function num(raw: string | undefined, name: string, min: number, max: number): number {
  const v = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(v) || v < min || v > max) throw new HttpError(400, "bad_request", `${name} must be a number between ${min} and ${max}, got "${raw ?? ""}"`);
  return v;
}

export function parseEvacuationQuery(q: Query) {
  const lng = num(q.lng, "lng", -180, 180);
  const lat = num(q.lat, "lat", -90, 90);
  const travel = TravelModeSchema.safeParse(q.travel ?? "car");
  if (!travel.success) throw new HttpError(400, "bad_request", `travel must be "car", "walk" or "boat", got "${q.travel}"`);
  const people = q.people === undefined ? 1 : num(q.people, "people", 1, 100_000);
  if (!Number.isInteger(people)) throw new HttpError(400, "bad_request", `people must be a whole number, got "${q.people}"`);
  return { from: [lng, lat] as [number, number], travel: travel.data, mode: parseHazardsMode(q.mode), ts: parseHazardsTs(q.ts), centreId: q.centreId || null, people };
}

export async function evacuationRouteRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: Query }>("/regions/:id/evacuation-route", async (req): Promise<EvacuationRoute> => {
    const q = parseEvacuationQuery(req.query);
    const regionId = req.params.id;
    const db = await getDb();
    const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: regionId }, { projection: { _id: 1 } });
    if (!region) throw new HttpError(404, "not_found", `Region "${regionId}" not found`);

    const notes: string[] = [];
    const [graphResult, roadStatus, centreStatuses] = await Promise.all([
      roadGraphFor(regionId).catch(() => null),
      getRoadStatus(regionId, q.ts, q.mode).catch((err) => {
        if (err instanceof RegionNotFoundError) throw err;
        notes.push(`Flood model unavailable (${(err as Error).message.slice(0, 120)}): every road section is "unknown".`);
        return null;
      }),
      getCentreStatuses(regionId, q.ts, q.mode).catch(() => null),
    ]);

    // Centre status from C; without it, every centre is "unknown" (never "usable" by default).
    const centres: CentreInfo[] = centreStatuses
      ? centreStatuses.map((c) => ({ ...c, status: c.status }))
      : (await db.collection<EvacCentre & { source?: string; capacityEstimated?: boolean; headcountUpdatedAt?: string }>(COLLECTIONS.evacCentres).find({ regionId }).toArray())
          .map((c) => ({ ...c, status: "unknown" as const, source: c.source ?? "osm-candidate", capacityEstimated: c.capacityEstimated ?? true, headcountUpdatedAt: c.headcountUpdatedAt ?? null }));
    if (!centreStatuses) notes.push("Centre flood status unavailable: every centre is \"unknown\".");

    const hazards: RoadHazards = roadStatus
      ? {
          statusOf: roadStatus.status,
          floodedIds: [...roadStatus.statusById].filter(([, st]) => st === "flooded").map(([id]) => id),
          landslideRoadIds: new Set(roadStatus.landslideRoadIds),
          assessedAt: roadStatus.assessedAt,
          source: roadStatus.source,
          notes,
        }
      : { statusOf: null, floodedIds: [], landslideRoadIds: null, assessedAt: null, source: null, notes };

    const ts = q.ts.toISOString();
    return evacuationRoute({
      regionId,
      graph: graphResult?.graph ?? null,
      centres,
      hazards,
      from: q.from,
      travel: q.travel,
      mode: q.mode,
      ts,
      centreId: q.centreId,
      people: q.people,
      version: `${regionId}:${q.mode}:${ts}:roads-${graphResult?.segments ?? 0}:hazards-${roadStatus?.version ?? "none"}`,
      sources: [
        "OpenStreetMap roads (© OpenStreetMap contributors, ODbL)",
        ...(roadStatus ? [roadStatus.source] : []),
        q.mode === "replay" ? "GloFAS river discharge (reanalysis), Dec 2014 — RECONSTRUCTED" : "JPS Public Infobanjir river levels and thresholds",
        "Evacuation centres: OpenStreetMap candidates with estimated capacities",
        ...(roadStatus?.landslideRoadIds.length ? ["MonsoonWatch landslide screening (not a site survey)"] : []),
      ],
      limitations: [
        ...(roadStatus ? ["Flood model is approximate (DEM vertical error several metres); surface/local flooding is not modelled."] : []),
        ...(q.mode === "replay" ? ["Dec 2014 replay: river levels RECONSTRUCTED from GloFAS discharge; timing not calibrated."] : []),
        ...(roadStatus?.landslideRoadIds.length ? [LANDSLIDE_LABEL] : []),
      ],
    });
  });
}
