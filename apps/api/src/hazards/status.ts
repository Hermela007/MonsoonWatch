// Pure status rules for one scenario time (ts + mode). Names and statuses follow the agreed routing contract
// (packages/shared/src/routing.ts, IMPLEMENTATION §1.7 decision 7): missing hazard data = "unknown", never safe.
// DB access lives in ./index.ts. Everything here is an APPROXIMATION — see docs/HAZARDS.md.
import type { LngLat, RoadHazardStatus } from "@monsoonwatch/shared";
import { FLOODPLAIN_M, MAX_GAUGE_DIST_M, type Gauge, type Segment } from "./water";

/** Live: a gauge reading older than this at ts is stale (JPS reports every 15 min). */
export const LIVE_STALE_MS = 2 * 3600 * 1000;
/** Replay: daily GloFAS values; no reading within this of ts → no data. */
export const REPLAY_MAX_GAP_MS = 36 * 3600 * 1000;

// ---- replay time ------------------------------------------------------------------------------------

export interface TimedValue { ts: Date; value: number }

/** Daily replay value at `ts`: linear between the readings either side (stamped end-of-day MYT), so
 *  24 Dec 12:00 lies between the 23 and 24 Dec values. Only the nearer side within REPLAY_MAX_GAP_MS
 *  when the other is missing or too far; null when neither is close enough. */
export function interpolateDaily(prev: TimedValue | null, next: TimedValue | null, ts: Date): { value: number; basisTs: Date; interpolated: boolean } | null {
  const t = ts.getTime();
  const near = (v: TimedValue | null) => v !== null && Math.abs(t - v.ts.getTime()) <= REPLAY_MAX_GAP_MS;
  if (prev && next && near(prev) && near(next) && next.ts.getTime() > prev.ts.getTime()) {
    const f = (t - prev.ts.getTime()) / (next.ts.getTime() - prev.ts.getTime());
    return { value: prev.value + f * (next.value - prev.value), basisTs: prev.ts, interpolated: f > 0 };
  }
  if (prev && near(prev)) return { value: prev.value, basisTs: prev.ts, interpolated: false };
  if (next && near(next)) return { value: next.value, basisTs: next.ts, interpolated: false };
  return null;
}

/** Live freshness. */
export const isStaleLive = (readingTs: Date, ts: Date) => ts.getTime() - readingTs.getTime() > LIVE_STALE_MS;

// ---- roads ------------------------------------------------------------------------------------------

export type UnknownReason = "no_ground" | "no_gauge_in_range" | "stale_gauge";

/** Per-segment status. `freshLevels` holds ONLY usable gauges with a fresh reading at ts; `flooded` is the
 *  model's blocked set computed from those same levels, so an unknown segment can never be flooded or clear. */
export function roadStatus(
  s: Segment,
  freshLevels: Map<string, number>,
  flooded: Set<string>,
): { status: RoadHazardStatus; reason?: UnknownReason } {
  // riverDistM null = no OSM river within the ~20 km search radius of prep:hazards.
  if (s.riverDistM === null || s.riverDistM > FLOODPLAIN_M) return { status: "outside_floodplain" };
  if (s.groundM === null) return { status: "unknown", reason: "no_ground" };
  if (s.gaugeId === null || s.gaugeDistM === null || s.gaugeDistM > MAX_GAUGE_DIST_M) return { status: "unknown", reason: "no_gauge_in_range" };
  if (!freshLevels.has(s.gaugeId)) return { status: "unknown", reason: "stale_gauge" };
  return { status: flooded.has(s.id) ? "flooded" : "clear" };
}

/** Counts with the key names of routing.ts `hazards.segments`. */
export interface RoadStatusCounts { flooded: number; clear: number; outsideFloodplain: number; unknown: number }

export function countStatuses(statuses: Iterable<RoadHazardStatus>): RoadStatusCounts {
  const c: RoadStatusCounts = { flooded: 0, clear: 0, outsideFloodplain: 0, unknown: 0 };
  for (const s of statuses) {
    if (s === "outside_floodplain") c.outsideFloodplain++;
    else c[s]++;
  }
  return c;
}

// ---- centres ----------------------------------------------------------------------------------------

export type CentreStatus = "usable" | "at_risk" | "unknown"; // routing.ts CentreStatusSchema
export interface CentreHazard { groundM: number | null; riverDistM: number | null; gaugeId: string | null; gaugeDistM: number | null }

/** Centre status at ts. Same model as roads: no overbank flooding while the gauge is below its JPS alert
 *  level. `basis` says whether at_risk comes from the likely level or only from the uncertainty margin. */
export function centreStatus(
  h: CentreHazard | undefined,
  freshLevels: Map<string, number>,
  gauges: Map<string, Pick<Gauge, "name" | "thresholds">>,
  marginM: number,
): { status: CentreStatus; reason: string; basis: "likely" | "uncertainty_margin" | null } {
  if (!h) return { status: "unknown", reason: "No hazard data for this centre (prep:hazards has not assessed it).", basis: null };
  if (h.riverDistM === null || h.riverDistM > FLOODPLAIN_M) {
    return { status: "usable", reason: `More than ${FLOODPLAIN_M / 1000} km from a mapped river: river flooding not expected. Local/surface flooding is not modelled.`, basis: null };
  }
  if (h.groundM === null) return { status: "unknown", reason: "In a river corridor, but no ground elevation for this point.", basis: null };
  if (h.gaugeId === null || h.gaugeDistM === null || h.gaugeDistM > MAX_GAUGE_DIST_M) {
    return { status: "unknown", reason: `In a river corridor, but no usable river gauge within ${MAX_GAUGE_DIST_M / 1000} km.`, basis: null };
  }
  const g = gauges.get(h.gaugeId);
  const level = freshLevels.get(h.gaugeId);
  const gname = g?.name ?? h.gaugeId;
  if (!g || level === undefined) return { status: "unknown", reason: `In a river corridor, but gauge ${gname} has no fresh reading at this time.`, basis: null };
  const r1 = (n: number) => Math.round(n * 10) / 10;
  const facts = `ground ${r1(h.groundM)} m, likely water ${r1(level)} m at ${gname}`;
  if (level >= g.thresholds.alert && h.groundM < level) return { status: "at_risk", reason: `Below the likely water level: ${facts}.`, basis: "likely" };
  if (level + marginM >= g.thresholds.alert && h.groundM < level + marginM) {
    return { status: "at_risk", reason: `Within the ±${marginM} m uncertainty margin: ${facts} (worst ${r1(level + marginM)} m).`, basis: "uncertainty_margin" };
  }
  return {
    status: "usable",
    reason: level < g.thresholds.alert ? `Assessed: ${gname} is below its alert level (${facts}).` : `Assessed: above the water (${facts}).`,
    basis: null,
  };
}

// ---- landslide runouts × roads ----------------------------------------------------------------------

function segmentsCross(p1: LngLat, p2: LngLat, q1: LngLat, q2: LngLat): boolean {
  const o = (a: LngLat, b: LngLat, c: LngLat) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  const on = (a: LngLat, b: LngLat, c: LngLat) => Math.min(a[0], b[0]) <= c[0] && c[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= c[1] && c[1] <= Math.max(a[1], b[1]);
  const d1 = o(q1, q2, p1), d2 = o(q1, q2, p2), d3 = o(p1, p2, q1), d4 = o(p1, p2, q2);
  if (d1 !== d2 && d3 !== d4) return true;
  return (d1 === 0 && on(q1, q2, p1)) || (d2 === 0 && on(q1, q2, p2)) || (d3 === 0 && on(p1, p2, q1)) || (d4 === 0 && on(p1, p2, q2));
}

type Bbox = [number, number, number, number];
const bboxOf = (c: LngLat[]): Bbox => {
  let [a, b, x, y] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of c) { a = Math.min(a, lon); b = Math.min(b, lat); x = Math.max(x, lon); y = Math.max(y, lat); }
  return [a, b, x, y];
};
const overlaps = (p: Bbox, q: Bbox) => p[0] <= q[2] && q[0] <= p[2] && p[1] <= q[3] && q[1] <= p[3];

/** Road segment ids whose line crosses any runout line. Bbox prefilter per runout, then exact edge tests. */
export function roadsCrossingRunouts(roads: { id: string; coords: LngLat[]; bbox?: Bbox }[], runouts: { coordinates: LngLat[] }[]): string[] {
  if (runouts.length === 0) return [];
  const out: string[] = [];
  const rb = runouts.map((r) => ({ c: r.coordinates, b: bboxOf(r.coordinates) }));
  for (const road of roads) {
    const b = road.bbox ?? bboxOf(road.coords);
    const hit = rb.some((r) => {
      if (!overlaps(b, r.b)) return false;
      for (let i = 1; i < road.coords.length; i++) for (let j = 1; j < r.c.length; j++) {
        if (segmentsCross(road.coords[i - 1]!, road.coords[i]!, r.c[j - 1]!, r.c[j]!)) return true;
      }
      return false;
    });
    if (hit) out.push(road.id);
  }
  return out;
}

export { bboxOf, type Bbox };
