// Evacuation routing core — the ONE routing logic shared by resident journeys (A's request) and the
// Gemini agent. Deterministic, no LLM. The HTTP endpoint (shape pending A + C agreement) will be a
// thin wrapper around `evacuationRoute`.
//
// Rules (from A's brief):
//   - never return a straight line as a successful route (geometry only when status = "ok")
//   - start point too far from the road network → "off_network" (says how far)
//   - tries the nearest centres with free places; picks the shortest usable route; lists the rest
//   - car / walk never use flooded segments; boat may (follows roads as a proxy for channels)
//   - missing hazard data = "unknown", never "safe"; unassessed road segments → "partial"

import type { EvacCentre, Hazards, LngLat } from "@monsoonwatch/shared";
import { firstIntersectingSegment, haversineKm } from "./geo";
import { planRoute, type RoadGraph, type RouteResult } from "./route";

export type Travel = "car" | "walk" | "boat";

export const SPEED_KMH: Record<Travel, number> = { car: 30, walk: 4, boat: 8 };
export const MAX_SNAP_KM: Record<Travel, number> = { car: 2, walk: 1, boat: 2 };
/** OSM highway values a travel mode may not use. */
export const EXCLUDE: Record<Travel, ReadonlySet<string>> = {
  car: new Set(["footway", "path", "steps", "pedestrian", "cycleway", "bridleway", "corridor"]),
  walk: new Set(["motorway", "motorway_link"]),
  boat: new Set(),
};
const MAX_CANDIDATES = 8;
const MAX_CENTRE_KM = 40;

export type RouteFailure = "off_network" | "disconnected" | "all_routes_flooded" | "no_centre_with_space" | "centre_unavailable";

export interface RouteStep { instruction: string; road?: string; distanceM: number; bearingDeg: number }

export interface HazardInfo {
  /** Flooded segment ids; null = hazard data unavailable (→ "unknown", never "safe"). */
  blockedRoadIds: string[] | null;
  /** Segments the hazard model actually assessed; null = not known (→ at best "partial"). */
  assessedRoadIds: ReadonlySet<string> | null;
  runouts: Hazards["landslide"]["runouts"];
  notes: string[];
}

export interface EvacuationRouteResult {
  status: "ok" | "no_route";
  reason?: RouteFailure;
  message: string;
  travel: Travel;
  from: { lngLat: LngLat; snappedTo?: LngLat; snapDistanceM?: number };
  centre?: { id: string; name: string; lngLat: LngLat; capacity: number; headcount: number; freePlaces: number };
  geometry?: { type: "LineString"; coordinates: LngLat[] };
  distanceM?: number;
  durationMin?: number;
  steps?: RouteStep[];
  hazards: {
    status: "assessed" | "partial" | "unknown";
    crossesFlood: boolean;
    /** Flooded segments on the direct (flood-ignoring) route that this route avoids. */
    floodedSegmentsAvoided: number;
    /** Extra distance compared with the direct route because of flooding (m). */
    detourM: number;
    unassessedSegments: number;
    landslideRunoutsCrossed: number;
    notes: string[];
  };
  alternatives: { centreId: string; name: string; status: "ok" | "no_route"; reason?: RouteFailure; distanceM?: number }[];
  limitations: string[];
  /** For the agent / route check: the segment ids used. */
  segmentIds?: string[];
}

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

/** Turn-by-turn steps from consecutive road segments, grouped by road name (or type if unnamed). */
export function buildSteps(segments: NonNullable<RouteResult["segments"]>, centreName: string, travel: Travel): RouteStep[] {
  if (segments.length === 0) return [];
  const label = (s: (typeof segments)[number]) => s.name ?? `${s.highway.replace(/_/g, " ")} road`;
  const groups: { road: string; named: boolean; distanceM: number; coords: LngLat[] }[] = [];
  for (const s of segments) {
    const road = label(s);
    const last = groups.at(-1);
    if (last && last.road === road) {
      last.distanceM += s.lengthM;
      last.coords.push(...s.coords.slice(1));
    } else {
      groups.push({ road, named: !!s.name, distanceM: s.lengthM, coords: [...s.coords] });
    }
  }
  const verb = travel === "boat" ? "Go" : travel === "walk" ? "Walk" : "Drive";
  const steps: RouteStep[] = groups.map((g, i) => {
    const c = g.coords;
    const startBearing = bearingDeg(c[0]!, c[Math.min(c.length - 1, 1)]!);
    const on = g.named ? `onto ${g.road}` : `onto the ${g.road}`;
    let instruction: string;
    if (i === 0) instruction = `${verb} ${compass(startBearing)} on ${g.named ? g.road : `the ${g.road}`}`;
    else {
      const p = groups[i - 1]!.coords;
      const t = turn(bearingDeg(p[Math.max(0, p.length - 2)]!, p[p.length - 1]!), startBearing);
      instruction = t === "Continue" ? `Continue ${on}` : `${t} ${on}`;
    }
    return { instruction, ...(g.named ? { road: g.road } : {}), distanceM: Math.round(g.distanceM), bearingDeg: startBearing };
  });
  steps.push({ instruction: `Arrive at ${centreName}`, distanceM: 0, bearingDeg: steps.at(-1)!.bearingDeg });
  return steps;
}

export interface EvacuationInput {
  graph: RoadGraph;
  centres: EvacCentre[];
  hazards: HazardInfo;
  from: LngLat;
  travel: Travel;
  /** Force a specific centre. */
  centreId?: string;
}

export function evacuationRoute(input: EvacuationInput): EvacuationRouteResult {
  const { graph, centres, hazards, from, travel } = input;
  const blocked = hazards.blockedRoadIds ?? [];
  const mode = travel === "boat" ? "boat" : "road";
  const limitations = [
    `Travel time assumes ${SPEED_KMH[travel]} km/h; real conditions may be slower.`,
    ...(travel === "boat" ? ["Boat routes follow the road network as a stand-in for navigable water; real channels and currents are unknown."] : []),
    "Road network from OpenStreetMap; small paths or recent changes may be missing.",
    ...(hazards.blockedRoadIds === null ? ["Flood data unavailable: this route has NOT been checked for flooding."] : []),
  ];
  const baseHazards = (crossesFlood = false, unassessed = 0, runouts = 0, avoided = 0, detourM = 0): EvacuationRouteResult["hazards"] => ({
    status: hazards.blockedRoadIds === null ? "unknown" : hazards.assessedRoadIds === null || unassessed > 0 ? "partial" : "assessed",
    crossesFlood, floodedSegmentsAvoided: avoided, detourM, unassessedSegments: unassessed, landslideRunoutsCrossed: runouts,
    notes: [
      ...hazards.notes,
      ...(hazards.blockedRoadIds !== null && hazards.assessedRoadIds === null ? ["Which road segments the flood model assessed is not known; treat unassessed roads as unknown."] : []),
    ],
  });
  const fail = (reason: RouteFailure, message: string, alternatives: EvacuationRouteResult["alternatives"] = []): EvacuationRouteResult => ({
    status: "no_route", reason, message, travel, from: { lngLat: from }, hazards: baseHazards(), alternatives, limitations,
  });

  // Candidate centres: forced, or the nearest with free places.
  let candidates: EvacCentre[];
  if (input.centreId) {
    const c = centres.find((x) => x._id === input.centreId);
    if (!c) return fail("centre_unavailable", `Evacuation centre "${input.centreId}" not found`);
    if (c.capacity - c.headcount <= 0) return fail("centre_unavailable", `${c.name} is full (${c.headcount}/${c.capacity})`);
    candidates = [c];
  } else {
    candidates = centres
      .filter((c) => c.capacity - c.headcount > 0)
      .map((c) => ({ c, km: haversineKm(from, c.location.coordinates) }))
      .filter((x) => x.km <= MAX_CENTRE_KM)
      .sort((a, b) => a.km - b.km)
      .slice(0, MAX_CANDIDATES)
      .map((x) => x.c);
    if (candidates.length === 0) return fail("no_centre_with_space", `No evacuation centre with free places within ${MAX_CENTRE_KM} km`);
  }

  const tried: { c: EvacCentre; r: RouteResult }[] = candidates.map((c) => ({
    c, r: planRoute(graph, blocked, from, c.location.coordinates, mode, { excludeHighways: EXCLUDE[travel] }),
  }));

  // Start too far from any road (same for every candidate).
  const startKm = tried[0]!.r.startSnapKm;
  if (startKm !== undefined && startKm > MAX_SNAP_KM[travel]) {
    return fail("off_network", `Starting point is ${startKm.toFixed(1)} km from the nearest mapped road (max ${MAX_SNAP_KM[travel]} km for ${travel})`);
  }

  const usable = tried.filter((t) => t.r.found && (t.r.endSnapKm ?? 0) <= MAX_SNAP_KM.car && (mode === "boat" || !t.r.crossesFlood));
  const reasonFor = (t: (typeof tried)[number]): RouteFailure =>
    !t.r.segmentIds.length ? "disconnected" : t.r.crossesFlood && mode === "road" ? "all_routes_flooded" : "disconnected";
  usable.sort((a, b) => a.r.lengthKm - b.r.lengthKm);
  const best = usable[0];
  const alternatives = tried
    .filter((t) => t !== best)
    .map((t) => ({
      centreId: t.c._id, name: t.c.name,
      status: (usable.includes(t) ? "ok" : "no_route") as "ok" | "no_route",
      ...(usable.includes(t) ? { distanceM: Math.round(t.r.lengthKm * 1000) } : { reason: reasonFor(t) }),
    }));

  if (!best) {
    const flooded = tried.some((t) => t.r.crossesFlood);
    return flooded
      ? fail("all_routes_flooded", `Every ${travel} route to the ${tried.length} nearest centres crosses a flooded road${travel === "boat" ? "" : " — a boat may be needed"}`, alternatives)
      : fail("disconnected", `No road connection to the ${tried.length} nearest centres`, alternatives);
  }

  const r = best.r;
  const segs = r.segments ?? [];
  const runoutsCrossed = hazards.runouts.filter((ro) => firstIntersectingSegment(r.coordinates, ro.coordinates) >= 0).length;
  const unassessed = hazards.assessedRoadIds ? segs.filter((s) => !hazards.assessedRoadIds!.has(s.id)).length : 0;
  const distanceM = Math.round(r.lengthKm * 1000);
  // Compare with the direct route ignoring floods: how many flooded segments did we avoid, and at what cost?
  let avoided = 0;
  let detourM = 0;
  if (mode === "road" && blocked.length) {
    const direct = planRoute(graph, [], from, best.c.location.coordinates, "road", { excludeHighways: EXCLUDE[travel] });
    if (direct.found) {
      const blockedSet = new Set(blocked);
      avoided = direct.segmentIds.filter((id) => blockedSet.has(id)).length;
      detourM = Math.max(0, distanceM - Math.round(direct.lengthKm * 1000));
    }
  }
  const centre = best.c;
  // Road-following geometry: snapped start → segments → snapped end (no straight-line shortcut).
  const coords = segs.flatMap((s, i) => (i === 0 ? s.coords : s.coords.slice(1)));
  return {
    status: "ok",
    message: `${centre.name}: ${(distanceM / 1000).toFixed(1)} km by ${travel}`,
    travel,
    from: { lngLat: from, ...(coords[0] ? { snappedTo: coords[0] } : {}), ...(r.startSnapKm !== undefined ? { snapDistanceM: Math.round(r.startSnapKm * 1000) } : {}) },
    centre: { id: centre._id, name: centre.name, lngLat: centre.location.coordinates, capacity: centre.capacity, headcount: centre.headcount, freePlaces: centre.capacity - centre.headcount },
    geometry: { type: "LineString", coordinates: coords },
    distanceM,
    durationMin: Math.max(1, Math.round((r.lengthKm / SPEED_KMH[travel]) * 60)),
    steps: buildSteps(segs, centre.name, travel),
    hazards: baseHazards(r.crossesFlood, unassessed, runoutsCrossed, avoided, avoided ? detourM : 0),
    alternatives,
    limitations: [
      ...limitations,
      ...(runoutsCrossed ? [`Route crosses ${runoutsCrossed} landslide runout path(s) from the screening model — check before travelling.`] : []),
    ],
    segmentIds: r.segmentIds,
  };
}
