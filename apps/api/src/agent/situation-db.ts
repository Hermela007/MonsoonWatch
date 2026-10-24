// Loads a Situation from MongoDB (C's collections). Read-only.
// Hazards (flooded segments, landslide runouts) come from C6 `/hazards` once it exists — until
// then they are empty, which the HUD summary makes visible.

import {
  COLLECTIONS,
  type EvacCentre, type KnowledgeChunk, type Region, type RiskEvent, type RoadFeature, type RoadProps,
  type Station, type StationWithLatest, type Village, type LineStringGeom,
} from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { toReading, type ReadingDoc } from "../db/readings";
import { serialize } from "../events/change-streams";
import type { Situation } from "./situation";

const RISK_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KNOWLEDGE = 40;

export async function loadSituationFromDb(regionId: string, now = new Date()): Promise<Situation> {
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: regionId });
  if (!region) throw new Error(`Region "${regionId}" not found`);

  const stations = await db
    .collection<Station>(COLLECTIONS.stations)
    .find({ regionId, location: { $exists: true } }, { projection: { jps: 0 } })
    .toArray();
  const latest = await db
    .collection<ReadingDoc>(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; doc: ReadingDoc }>([
      { $match: { "meta.stationId": { $in: stations.map((s) => s._id) }, "meta.mode": "live" } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", doc: { $first: "$$ROOT" } } },
    ])
    .toArray();
  const byStation = new Map(latest.map((l) => [l._id, toReading(l.doc)]));
  const withLatest: StationWithLatest[] = stations.map((s) => ({ ...s, latest: byStation.get(s._id) ?? null }));

  const since = new Date(now.getTime() - RISK_WINDOW_MS);
  const riskDocs = await db.collection(COLLECTIONS.riskEvents).find({ regionId, ts: { $gte: since } }).sort({ ts: -1 }).limit(200).toArray();
  const riskEvents = riskDocs.map((d) => serialize<RiskEvent>(d));

  const [villages, centres, knowledge, roadDocs] = await Promise.all([
    db.collection<Village>(COLLECTIONS.villages).find({ regionId }).toArray(),
    db.collection<EvacCentre>(COLLECTIONS.evacCentres).find({ regionId }).toArray(),
    db.collection<KnowledgeChunk>(COLLECTIONS.knowledge).find({ regionId }).limit(MAX_KNOWLEDGE).toArray(),
    db.collection<{ _id: string; geometry: LineStringGeom; properties: RoadProps }>(COLLECTIONS.geo)
      .find({ regionId, layer: "road" }, { projection: { geometry: 1, properties: 1 } })
      .toArray(),
  ]);
  const roads: RoadFeature[] = roadDocs.map((d) => ({ type: "Feature", id: d._id, geometry: d.geometry, properties: d.properties }));

  return {
    region,
    mode: "live",
    now,
    stations: withLatest,
    riskEvents,
    villages,
    centres,
    roads,
    // TODO(C6): use /regions/:id/hazards (blockedRoadIds + runouts) when it lands.
    hazards: { blockedRoadIds: [], blockedRoads: { type: "MultiLineString", coordinates: [] }, landslide: { cells: [], runouts: [] } },
    knowledge: knowledge.map((k) => serialize<KnowledgeChunk>(k)),
    isTestData: false,
  };
}
