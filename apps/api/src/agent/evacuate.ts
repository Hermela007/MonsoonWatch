// Evacuation routing core — the ONE routing logic shared by resident journeys
// (GET /regions/:id/evacuation-route, routes/evacuation-route.ts) and the Gemini agent.
// Deterministic, no LLM. Returns the shared contract exactly (packages/shared/src/routing.ts).
//
// Rules (agreed with A + C):
//   - never a straight line: geometry only when status = "ok", built from road segments
//   - origin too far from the road network → "off_network" (says how far); no roads → "no_routing_data"
//   - tries the nearest centres with room for `people` that are not at risk; picks the shortest usable
//     route (centres C marks "usable" before "unknown"); lists the rest as alternatives
//   - car / walk never use flooded segments; boat → "unsupported_mode" (no navigable-water data)
//   - a requested centre that is missing, full or at risk → "centre_unavailable" + alternatives, no silent switch
//   - missing hazard data = "unknown", never "safe"; crossesFlood is false ONLY when every segment was assessed

import type { CentreStatusSchema, EvacCentre, EvacuationRoute, EvacuationRouteFailure, LngLat, RoadHazardStatus, TravelMode } from "@monsoonwatch/shared";
import type { z } from "zod";
import { haversineKm } from "./geo";
import { nearestNode, planRoute, type RoadGraph, type RouteResult } from "./route";

export type CentreStatus = z.infer<typeof CentreStatusSchema>;

export const SPEED_KMH: Record<"car" | "walk", number> = { car: 30, walk: 4 };
export const MAX_SNAP_KM: Record<TravelMode, number> = { car: 2, walk: 1, boat: 2 };
/** OSM highway values a travel mode may not use. */
export const EXCLUDE: Record<TravelMode, ReadonlySet<string>> = {
  car: new Set(["footway", "path", "steps", "pedestrian", "cycleway", "bridleway", "corridor"]),
  walk: new Set(["motorway", "motorway_link"]),
  boat: new Set(),
};
const MAX_CANDIDATES = 8;
export const MAX_CENTRE_KM = 40;

/** A centre with C's status for this time + mode (getCentreStatuses), or "unknown" when unavailable. */
export interface CentreInfo extends EvacCentre {
  status: CentreStatus;
  source: string;
  capacityEstimated: boolean;
  headcountUpdatedAt: string | null;
}

/** C's road status for this time + mode (getRoadStatus); `statusOf: null` = hazard data unavailable. */
export interface RoadHazards {
  statusOf: ((segmentId: string) => RoadHazardStatus) | null;
  floodedIds: string[];
  landslideRoadIds: ReadonlySet<string> | null;
  assessedAt: string | null;
  source: string | null;
  notes: string[];
}

export interface EvacuationInput {
  regionId: string;
  /** null = road network not available for this region. */
  graph: RoadGraph | null;
  centres: CentreInfo[];
  hazards: RoadHazards;
  from: LngLat;
  travel: TravelMode;
  mode: "live" | "replay";
  ts: string;
  centreId?: string | null;
  people?: number;
  version: string;
  sources: string[];
  limitations?: string[];
  testData?: boolean;
  now?: Date;
}

type Step = EvacuationRoute["steps"][number];
type Segments = NonNullable<RouteResult["segments"]>;

const toRad = (d: number) => (d * Math.PI) / 180;
export function bearingDeg(a: LngLat, b: LngLat): number {
  const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
  const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) - Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
const compass = (deg: number) => COMPASS[Math.round(deg / 45) % 8]!;

function turn(prev: number, next: number): string {
  const d = ((next - prev + 540) % 360) - 180; // -180..180, + = right
  if (Math.abs(d) < 20) return "Continue";
  if (Math.abs(d) < 60) return d > 0 ? "Bear right" : "Bear left";
  if (Math.abs(d) < 150) return d > 0 ? "Turn right" : "Turn left";
  return "Make a U-turn";
}

/** Road-following geometry (snapped start → segments → snapped end) and steps indexing into it. */
export function buildGeometryAndSteps(segments: Segments, centreName: string, travel: "car" | "walk"): { coordinates: LngLat[]; steps: Step[] } {
  const coordinates: LngLat[] = [];
  // Group consecutive segments on the same named road (or the same unnamed road type).
  const groups: { name: string | null; label: string; distanceM: number; start: number; end: number }[] = [];
  for (const s of segments) {
    const start = coordinates.length === 0 ? 0 : coordinates.length - 1;
    coordinates.push(...(coordinates.length === 0 ? s.coords : s.coords.slice(1)));
    const end = coordinates.length - 1;
    const name = s.name ?? null;
    const label = name ?? `${s.highway.replace(/_/g, " ")} road`;
    const last = groups.at(-1);
    if (last && last.label === label) {
      last.distanceM += s.lengthM;
      last.end = end;
    } else {
      groups.push({ name, label, distanceM: s.lengthM, start, end });
    }
  }
  if (groups.length === 0) return { coordinates, steps: [] };
  const verb = travel === "walk" ? "Walk" : "Drive";
  const bearingAt = (i: number, j: number) => bearingDeg(coordinates[i]!, coordinates[Math.min(j, coordinates.length - 1)]!);
  const steps: Step[] = groups.map((g, i) => {
    const on = g.name ? g.name : `the ${g.label}`; // unnamed → road type from OSM, never an invented name
    let instruction: string;
    if (i === 0) instruction = `${verb} ${compass(bearingAt(g.start, g.start + 1))} on ${on}`;
    else {
      const t = turn(bearingAt(Math.max(0, g.start - 1), g.start), bearingAt(g.start, g.start + 1));
      instruction = t === "Continue" ? `Continue onto ${on}` : `${t} onto ${on}`;
    }
    return { instruction, roadName: g.name, distanceM: Math.round(g.distanceM), startIndex: g.start, endIndex: g.end };
  });
  const last = coordinates.length - 1;
  steps.push({ instruction: `Arrive at ${centreName}`, roadName: null, distanceM: 0, startIndex: last, endIndex: last });
  return { coordinates, steps };
}

const free = (c: EvacCentre) => c.capacity - c.headcount;

export function evacuationRoute(input: EvacuationInput): EvacuationRoute {
  const { graph, centres, hazards, from, travel } = input;
  const people = input.people ?? 1;
  const tag = input.testData ? "[TEST DATA] " : "";
  const hazardsKnown = hazards.statusOf !== null;
  const limitations = [
    ...(travel === "boat" ? [] : [`Travel time assumes an average ${SPEED_KMH[travel]} km/h ${travel === "car" ? "by car" : "on foot"}; real conditions may be slower.`]),
    "Road network from OpenStreetMap; small paths, recent changes and one-way/access restrictions may be missing.",
    "No official road-closure feed (JKR/police): absence of closures is NOT confirmation that roads are open.",
    "Evacuation centre capacities are estimates; most centres are OSM candidates (schools, halls, mosques), not confirmed PPS.",
    ...(hazardsKnown ? [] : ["Flood data unavailable: this route has NOT been checked for flooding."]),
    ...(input.limitations ?? []),
  ];
  const base: EvacuationRoute = {
    status: "no_route",
    reason: null,
    message: "",
    query: { regionId: input.regionId, travel, mode: input.mode, ts: input.ts, centreId: input.centreId ?? null, people },
    generatedAt: (input.now ?? new Date()).toISOString(),
    version: input.version,
    origin: { requested: from, snapped: null, snapDistanceM: null },
    centre: null,
    geometry: null,
    distanceM: null,
    durationSeconds: null,
    durationBasis: null,
    steps: [],
    hazards: {
      status: hazardsKnown ? "assessed" : "unknown",
      assessedAt: hazards.assessedAt,
      source: hazards.source,
      crossesFlood: null,
      segments: { flooded: 0, clear: 0, outsideFloodplain: 0, unknown: 0 },
      floodedSegmentsAvoided: null,
      detourM: null,
      landslideRunoutsCrossed: null,
      confirmedClosures: { available: false, source: null },
      notes: [...hazards.notes],
    },
    alternatives: [],
    sources: input.sources,
    limitations,
  };
  const fail = (reason: EvacuationRouteFailure, message: string, extra: Partial<EvacuationRoute> = {}): EvacuationRoute =>
    ({ ...base, reason, message: `${tag}${message}`, ...extra });

  if (travel === "boat") {
    return fail("unsupported_mode", "Boat routing is not available: there is no navigable-water data, so no boat route is claimed. Officials coordinate rescue boats.", {
      hazards: { ...base.hazards, status: "unknown", assessedAt: null, source: null },
      sources: [],
      limitations: ["Boat routing needs navigable-water data, which MonsoonWatch does not have."],
    });
  }
  if (!graph || graph.nodeCoord.size === 0) {
    return fail("no_routing_data", "No road network is loaded for this region, so no route can be planned.", { hazards: { ...base.hazards, status: "unknown" } });
  }

  const snap = nearestNode(graph, from)!;
  const snapDistanceM = Math.round(snap.km * 1000);
  if (snap.km > MAX_SNAP_KM[travel]) {
    return fail("off_network", `This location is ${snap.km.toFixed(1)} km from the nearest mapped road (max ${MAX_SNAP_KM[travel]} km ${travel === "car" ? "by car" : "on foot"}). Move to a road or ask officials for help.`, {
      origin: { requested: from, snapped: null, snapDistanceM },
    });
  }
  const origin = { requested: from, snapped: graph.nodeCoord.get(snap.id)!, snapDistanceM };

  const flooded = hazards.floodedIds;
  const tryCentres = (list: CentreInfo[]) =>
    list.map((c) => ({ c, r: planRoute(graph, flooded, from, c.location.coordinates, "road", { excludeHighways: EXCLUDE[travel] }) }));
  type Tried = ReturnType<typeof tryCentres>[number];
  const usable = (t: Tried) => t.r.found && !t.r.crossesFlood && (t.r.endSnapKm ?? 0) <= MAX_SNAP_KM.car;
  const reasonFor = (t: Tried): EvacuationRouteFailure => (t.r.segmentIds.length && t.r.crossesFlood ? "all_routes_flooded" : "disconnected");
  const altOf = (t: Tried): EvacuationRoute["alternatives"][number] => ({
    centreId: t.c._id, name: t.c.name,
    status: usable(t) ? "ok" : "no_route",
    reason: usable(t) ? null : reasonFor(t),
    distanceM: usable(t) ? Math.round(t.r.lengthKm * 1000) : null,
    freePlaces: free(t.c),
    centreStatus: t.c.status,
  });
  /** Nearest centres (straight line) that are not at risk and have room for `people`. */
  const eligible = (exclude?: string) => centres
    .filter((c) => c._id !== exclude && c.status !== "at_risk" && free(c) >= people)
    .map((c) => ({ c, km: haversineKm(from, c.location.coordinates) }))
    .filter((x) => x.km <= MAX_CENTRE_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_CANDIDATES)
    .map((x) => x.c);

  // A requested centre: no silent switch — explain, and list alternatives.
  if (input.centreId) {
    const c = centres.find((x) => x._id === input.centreId);
    const unavailable = !c ? `Evacuation centre "${input.centreId}" was not found.`
      : c.status === "at_risk" ? `${c.name} is at risk at this time (flood model) and is not used.`
      : free(c) < people ? `${c.name} has ${Math.max(0, free(c))} free places; your group needs ${people}.`
      : null;
    if (unavailable) {
      return fail("centre_unavailable", `${unavailable} See the alternatives.`, { origin, alternatives: tryCentres(eligible(input.centreId)).map(altOf) });
    }
    const [t] = tryCentres([c!]);
    if (!usable(t!)) {
      const reason = reasonFor(t!);
      return fail(reason, reason === "all_routes_flooded"
        ? `Every ${travel} route to ${c!.name} crosses a flooded road.`
        : `No road connection to ${c!.name}.`, { origin, alternatives: tryCentres(eligible(c!._id)).map(altOf) });
    }
    return success(t!, []);
  }

  const candidates = eligible();
  if (candidates.length === 0) {
    const near = centres.filter((c) => haversineKm(from, c.location.coordinates) <= MAX_CENTRE_KM);
    return fail("no_centre_with_space", near.length
      ? `No evacuation centre within ${MAX_CENTRE_KM} km has room for ${people} ${people === 1 ? "person" : "people"} and is not at risk.`
      : `No evacuation centre within ${MAX_CENTRE_KM} km.`, { origin });
  }
  const tried = tryCentres(candidates);
  const ok = tried.filter(usable).sort((a, b) => (a.c.status === "usable" ? 0 : 1) - (b.c.status === "usable" ? 0 : 1) || a.r.lengthKm - b.r.lengthKm);
  const best = ok[0];
  if (!best) {
    const anyFlooded = tried.some((t) => reasonFor(t) === "all_routes_flooded");
    return fail(anyFlooded ? "all_routes_flooded" : "disconnected", anyFlooded
      ? `Every ${travel} route to the ${tried.length} nearest centres with space crosses a flooded road.`
      : `No road connection to the ${tried.length} nearest centres with space.`, { origin, alternatives: tried.map(altOf) });
  }
  return success(best, tried.filter((t) => t !== best).map(altOf));

  function success(t: Tried, alternatives: EvacuationRoute["alternatives"]): EvacuationRoute {
    const mode = travel as "car" | "walk";
    const segs = t.r.segments ?? [];
    const { coordinates, steps } = buildGeometryAndSteps(segs, t.c.name, mode);
    const distanceM = Math.round(segs.reduce((n, s) => n + s.lengthM, 0));
    const durationSeconds = Math.max(60, Math.round((distanceM / 1000 / SPEED_KMH[mode]) * 3600));

    const counts = { flooded: 0, clear: 0, outsideFloodplain: 0, unknown: 0 };
    for (const s of segs) {
      const st = hazards.statusOf ? hazards.statusOf(s.id) : "unknown";
      if (st === "outside_floodplain") counts.outsideFloodplain++;
      else counts[st]++;
    }
    const allAssessed = hazardsKnown && counts.unknown === 0;
    const runouts = hazards.landslideRoadIds ? segs.filter((s) => hazards.landslideRoadIds!.has(s.id)).length : null;
    // The direct route ignoring floods: how many flooded segments did we avoid, and at what cost?
    let avoided: number | null = null;
    let detourM: number | null = null;
    if (hazardsKnown) {
      avoided = 0;
      detourM = 0;
      if (flooded.length) {
        const direct = planRoute(graph!, [], from, t.c.location.coordinates, "road", { excludeHighways: EXCLUDE[travel] });
        if (direct.found) {
          const set = new Set(flooded);
          avoided = direct.segmentIds.filter((id) => set.has(id)).length;
          detourM = avoided ? Math.max(0, distanceM - Math.round(direct.lengthKm * 1000)) : 0;
        }
      }
    }
    const notes = [
      ...base.hazards.notes,
      ...(counts.unknown ? [`${counts.unknown} road section${counts.unknown === 1 ? " has" : "s have"} no usable gauge reading: flood status unknown.`] : []),
      ...(runouts ? [`Route crosses ${runouts} road section(s) on a landslide runout path (screening model, not a site survey) — check before travelling.`] : []),
    ];
    const minutes = Math.round(durationSeconds / 60);
    return {
      ...base,
      status: "ok",
      reason: null,
      message: `${tag}${t.c.name}: ${(distanceM / 1000).toFixed(1)} km ${mode === "car" ? "by car" : "on foot"}, about ${minutes} min`,
      origin,
      centre: {
        id: t.c._id, name: t.c.name, lngLat: t.c.location.coordinates, capacity: t.c.capacity, headcount: t.c.headcount,
        freePlaces: free(t.c), status: t.c.status, source: t.c.source, capacityEstimated: t.c.capacityEstimated, headcountUpdatedAt: t.c.headcountUpdatedAt,
      },
      geometry: { type: "LineString", coordinates },
      distanceM,
      durationSeconds,
      durationBasis: `assumed average ${SPEED_KMH[mode]} km/h ${mode === "car" ? "by car" : "on foot"}`,
      steps,
      hazards: {
        ...base.hazards,
        status: !hazardsKnown ? "unknown" : allAssessed ? "assessed" : "partial",
        crossesFlood: counts.flooded > 0 ? true : allAssessed ? false : null,
        segments: counts,
        floodedSegmentsAvoided: avoided,
        detourM,
        landslideRunoutsCrossed: runouts,
        notes,
      },
      alternatives,
    };
  }
}
