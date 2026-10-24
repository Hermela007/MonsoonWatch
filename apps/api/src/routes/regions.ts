// C: region config, stations (with latest live reading), villages, evac centres.
import type { FastifyInstance } from "fastify";
import { COLLECTIONS, type EvacCentre, type Region, type Station, type StationWithLatest, type Village } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { toReading, type ReadingDoc } from "../db/readings";
import { HttpError } from "../errors";

export async function requireRegion(id: string): Promise<Region> {
  const region = await (await getDb()).collection<Region>(COLLECTIONS.regions).findOne({ _id: id });
  if (!region) throw new HttpError(404, "not_found", `Region "${id}" not found`);
  return region;
}

export async function regionRoutes(app: FastifyInstance) {
  app.get("/regions", async (): Promise<Region[]> => {
    return (await getDb()).collection<Region>(COLLECTIONS.regions).find().toArray();
  });

  app.get<{ Params: { id: string } }>("/regions/:id", async (req) => requireRegion(req.params.id));

  // Stations without coordinates yet (not geocoded) are left out — Station.location is required.
  app.get<{ Params: { id: string } }>("/regions/:id/stations", async (req): Promise<StationWithLatest[]> => {
    await requireRegion(req.params.id);
    const db = await getDb();
    const stations = await db
      .collection<Station>(COLLECTIONS.stations)
      .find({ regionId: req.params.id, location: { $exists: true } }, { projection: { jps: 0 } })
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
    return stations.map((s) => ({ ...s, latest: byStation.get(s._id) ?? null }));
  });

  app.get<{ Params: { id: string } }>("/regions/:id/villages", async (req): Promise<Village[]> => {
    await requireRegion(req.params.id);
    return (await getDb()).collection<Village>(COLLECTIONS.villages).find({ regionId: req.params.id }).toArray();
  });

  app.get<{ Params: { id: string } }>("/regions/:id/evac-centres", async (req): Promise<EvacCentre[]> => {
    await requireRegion(req.params.id);
    return (await getDb()).collection<EvacCentre>(COLLECTIONS.evacCentres).find({ regionId: req.params.id }).toArray();
  });
}
