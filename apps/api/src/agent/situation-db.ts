// Loads a Situation from MongoDB (C's collections). Read-only.
//   mode "live":   latest live readings, risk events from the last 24 h.
//   mode "replay": the 2014 replay as of `at` (the replay clock) — latest replay reading per
//                  station / GloFAS cell at or before `at`, replay risk events in the 24 h before.
// Hazards: C6 getHazards (flooded road segments from the water model; landslide from our screening
// model, registered as its landslide provider). Villages near a landslide runout get a
// `landslide_screen` risk event so the agent can cite it and verify.ts can check it.

import {
  COLLECTIONS,
  type EvacCentre, type KnowledgeChunk, type LineStringGeom, type Reading, type Region, type RiskEvent,
  type RoadFeature, type RoadProps, type Station, type StationWithLatest, type Village,
} from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { toReading, type ReadingDoc } from "../db/readings";
import { serialize } from "../events/change-streams";
import { getHazards } from "../hazards";
import { landslideEventsForVillages } from "./landslide";
import { computeLandslideDetailed, registerLandslideProvider } from "./landslide-provider";
import type { Situation } from "./situation";

const RISK_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KNOWLEDGE = 40;

export interface LoadOptions {
  mode?: "live" | "replay";
  /** Live: now. Replay: the replay clock (e.g. the triggering risk event's ts). */
  at?: Date;
}

export async function loadSituationFromDb(regionId: string, opts: LoadOptions = {}): Promise<Situation> {
  const mode = opts.mode ?? "live";
  const at = opts.at ?? new Date();
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: regionId });
  if (!region) throw new Error(`Region "${regionId}" not found`);

  const stations = await db
    .collection<Station>(COLLECTIONS.stations)
    .find({ regionId, location: { $exists: true } }, { projection: { jps: 0 } })
    .toArray();
  const cells = region.glofasCells ?? [];
  const ids = [...stations.map((s) => s._id), ...cells.map((c) => c.id)];
  const latest = await db
    .collection<ReadingDoc>(COLLECTIONS.rawReadings)
    .aggregate<{ _id: string; doc: ReadingDoc }>([
      { $match: { "meta.stationId": { $in: ids }, "meta.mode": mode, ts: { $lte: at } } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", doc: { $first: "$$ROOT" } } },
    ])
    .toArray();
  const byId = new Map<string, Reading>(latest.map((l) => [l._id, toReading(l.doc)]));

  // C6 hazards first: in the 2014 replay JPS river gauges have no readings, so their water level is
  // RECONSTRUCTED by C's model from GloFAS discharge (approximate curve). Use it as the gauge's
  // reading, and say so in the station name the HUD and checks print.
  registerLandslideProvider();
  const hazards = await getHazards(regionId, at, mode);
  const reconstructed = new Map(mode === "replay" ? hazards.gauges.filter((g) => g.source === "glofas-curve").map((g) => [g.id, g]) : []);
  const withLatest: StationWithLatest[] = stations.map((s) => {
    const g = reconstructed.get(s._id);
    if (!g || byId.has(s._id)) return { ...s, latest: byId.get(s._id) ?? null };
    return {
      ...s,
      name: `${s.name} [level reconstructed from GloFAS, approximate]`,
      latest: { ts: g.readingTs ?? at.toISOString(), value: Math.round(g.levelM * 100) / 100, meta: { stationId: s._id, kind: "river", source: "glofas", mode } },
    };
  });

  const since = new Date(at.getTime() - RISK_WINDOW_MS);
  // `mode` is an extra field C's stream processor writes on risk events; older docs may lack it (= live).
  const modeFilter = mode === "replay" ? { mode: "replay" } : { mode: { $ne: "replay" } };
  const riskDocs = await db
    .collection(COLLECTIONS.riskEvents)
    .find({ regionId, ...modeFilter, ts: { $gte: since, $lte: at } })
    .sort({ ts: -1 })
    .limit(200)
    .toArray();
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

  const detail = await computeLandslideDetailed(regionId, at, mode).catch(() => null);
  const landslideEvents = detail ? landslideEventsForVillages(regionId, at.toISOString(), villages, detail.landslide, detail.sources) : [];

  return {
    region,
    mode,
    now: at,
    stations: withLatest,
    riskEvents: [...riskEvents, ...landslideEvents],
    villages,
    centres,
    roads,
    hazards: {
      blockedRoadIds: hazards.blockedRoadIds,
      blockedRoads: hazards.blockedRoads,
      landslide: detail?.landslide ?? hazards.landslide,
    },
    hazardNotes: [
      ...hazards.notes,
      ...(detail ? [`Landslide SCREENING (not a site survey): thresholds from ${detail.configSource}; ${detail.landslide.runouts.length} runouts.`] : []),
    ],
    knowledge: knowledge.map((k) => serialize<KnowledgeChunk>(k)),
    glofas: cells.map((c) => ({ id: c.id, label: c.label, lngLat: c.lngLat, latest: byId.get(c.id) ?? null })),
    isTestData: false,
  };
}
