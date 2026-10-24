// GET /api/regions/:id/evacuation-route — Citymapper-style evacuation journey (A's request, 24 Oct).
// Agreed fields: A (frontend) + C (hazard/centre provenance) + B (routing). Deterministic, no Gemini.
// The SAME routing code serves resident journeys and the Gemini agent's alert routes.
//
// Query: ?lng=&lat=&travel=car|walk|boat&mode=live|replay&ts=<ISO>&centreId=<optional>&people=<default 1>
// Coordinates are GeoJSON [lon, lat]. Units are in the field names.
import { z } from "zod";

const LngLat = z.tuple([z.number(), z.number()]);

export const TravelModeSchema = z.enum(["car", "walk", "boat"]);
export type TravelMode = z.infer<typeof TravelModeSchema>;

/** C's per-segment status for a time + mode (getRoadStatus). */
export const RoadHazardStatusSchema = z.enum([
  "flooded", //            model says under water
  "clear", //              assessed, above the water
  "outside_floodplain", // > 3 km from a mapped river: river flooding not expected; local/surface flooding NOT modelled
  "unknown", //            in a river corridor but no usable or fresh gauge reading
]);
export type RoadHazardStatus = z.infer<typeof RoadHazardStatusSchema>;

export const EvacuationRouteFailureSchema = z.enum([
  "off_network", //          origin too far from any mapped road (never silently connected)
  "no_routing_data", //      road network not available for this region (≠ disconnected)
  "disconnected", //         network exists, but no connection to any candidate centre
  "all_routes_flooded", //   every route to the candidates crosses a flooded segment
  "no_centre_with_space", // no centre with room for `people` within range
  "centre_unavailable", //   requested centreId missing, full or at risk — alternatives are returned, no silent switch
  "unsupported_mode", //     e.g. boat: no navigable-water data, so no boat route is claimed
]);
export type EvacuationRouteFailure = z.infer<typeof EvacuationRouteFailureSchema>;

export const CentreStatusSchema = z.enum(["usable", "at_risk", "unknown"]);

export const EvacuationRouteSchema = z.object({
  status: z.enum(["ok", "no_route"]),
  reason: EvacuationRouteFailureSchema.nullable(), // null when ok
  message: z.string(), // one plain sentence for the UI

  // Provenance and caching (C): echo the query; `version` changes when the road graph or hazards change.
  query: z.object({
    regionId: z.string(),
    travel: TravelModeSchema,
    mode: z.enum(["live", "replay"]),
    ts: z.string(), // scenario time (ISO)
    centreId: z.string().nullable(),
    people: z.number().int().min(1), // household / group size; capacity checks use it
  }),
  generatedAt: z.string(),
  version: z.string(),

  origin: z.object({
    requested: LngLat,
    snapped: LngLat.nullable(), // nearest road node; null when off_network / no data
    snapDistanceM: z.number().nullable(),
  }),

  centre: z
    .object({
      id: z.string(),
      name: z.string(),
      lngLat: LngLat,
      capacity: z.number(),
      headcount: z.number(),
      freePlaces: z.number(),
      status: CentreStatusSchema, // C: at_risk | unknown | usable, for this time + mode
      source: z.string(), // e.g. "osm-candidate" (not a confirmed PPS)
      capacityEstimated: z.boolean(),
      headcountUpdatedAt: z.string().nullable(),
    })
    .nullable(),

  geometry: z.object({ type: z.literal("LineString"), coordinates: z.array(LngLat) }).nullable(), // null unless ok; never a straight line
  distanceM: z.number().nullable(),
  durationSeconds: z.number().nullable(), // null when not supported
  durationBasis: z.string().nullable(), // e.g. "assumed average 30 km/h by car"

  // Steps index into geometry.coordinates. roadName null = unnamed road (neutral instruction, never invented).
  steps: z.array(
    z.object({
      instruction: z.string(),
      roadName: z.string().nullable(),
      distanceM: z.number(),
      startIndex: z.number().int(),
      endIndex: z.number().int(),
    }),
  ),

  hazards: z.object({
    // A's UI: assessed → "Checked against available hazard data" · partial → "Some sections lack hazard
    // information" · unknown → "Hazard conditions unavailable — not checked for flooding or landslides".
    // No status ever earns a "safe" badge.
    status: z.enum(["assessed", "partial", "unknown"]),
    assessedAt: z.string().nullable(), // hazard model time used
    source: z.string().nullable(), // e.g. "MonsoonWatch flood model (JPS gauges, DEM) — approximate"
    crossesFlood: z.boolean().nullable(), // null = not fully assessed; false ONLY when every segment was assessed
    segments: z.object({ flooded: z.number(), clear: z.number(), outsideFloodplain: z.number(), unknown: z.number() }),
    floodedSegmentsAvoided: z.number().nullable(), // vs the direct route ignoring floods
    detourM: z.number().nullable(),
    landslideRunoutsCrossed: z.number().nullable(), // screening model; null when unavailable
    confirmedClosures: z.object({ available: z.boolean(), source: z.string().nullable() }), // no official closure data yet
    notes: z.array(z.string()),
  }),

  alternatives: z.array(
    z.object({
      centreId: z.string(),
      name: z.string(),
      status: z.enum(["ok", "no_route"]),
      reason: EvacuationRouteFailureSchema.nullable(),
      distanceM: z.number().nullable(),
      freePlaces: z.number(),
      centreStatus: CentreStatusSchema,
    }),
  ),

  sources: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type EvacuationRoute = z.infer<typeof EvacuationRouteSchema>;
