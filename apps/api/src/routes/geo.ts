// C: OSM map layers for a region (§1.6 decision 4), loaded by `pnpm load:osm`.
// Roads are split at junctions (one feature per segment, from/to = OSM node ids) for B's routing.
// Buildings are not loaded yet (Kelantan has too many) — always an empty collection for now.
//   GET /regions/:id/geo                  all layers
//   GET /regions/:id/geo?layers=roads     only the listed layers (roads, rivers, buildings)
import type { FastifyInstance } from "fastify";
import { COLLECTIONS, type GeoLayers, type LineStringGeom, type RiverFeature, type RoadProps } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { HttpError } from "../errors";
import { requireRegion } from "./regions";

type Layer = "roads" | "rivers" | "buildings";
const LAYERS: Layer[] = ["roads", "rivers", "buildings"];

interface GeoDoc<P> { _id: string; regionId: string; layer: "road" | "river"; geometry: LineStringGeom; properties: P }

function parseLayers(raw: string | undefined): Set<Layer> {
  if (!raw) return new Set(LAYERS);
  const asked = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = asked.filter((l) => !LAYERS.includes(l as Layer));
  if (unknown.length) throw new HttpError(400, "bad_request", `Unknown layer(s): ${unknown.join(", ")} (use ${LAYERS.join(", ")})`);
  return new Set(asked as Layer[]);
}

async function features<P>(regionId: string, layer: "road" | "river") {
  const docs = await (await getDb())
    .collection<GeoDoc<P>>(COLLECTIONS.geo)
    .find({ regionId, layer }, { projection: { geometry: 1, properties: 1 } })
    .sort({ _id: 1 })
    .toArray();
  return docs.map((d) => ({ type: "Feature" as const, id: d._id, geometry: d.geometry, properties: d.properties }));
}

export async function geoRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { layers?: string } }>("/regions/:id/geo", async (req): Promise<GeoLayers> => {
    const layers = parseLayers(req.query.layers);
    await requireRegion(req.params.id);
    const [roads, rivers] = await Promise.all([
      layers.has("roads") ? features<RoadProps>(req.params.id, "road") : [],
      layers.has("rivers") ? features<RiverFeature["properties"]>(req.params.id, "river") : [],
    ]);
    return {
      regionId: req.params.id,
      roads: { type: "FeatureCollection", features: roads },
      rivers: { type: "FeatureCollection", features: rivers },
      buildings: { type: "FeatureCollection", features: [] },
    };
  });
}
