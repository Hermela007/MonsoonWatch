// Deterministic risk screen + Argon shortlist. Used to build Argon's prompt and to guarantee
// coverage (coverage.ts); the checks and subagents keep the full Situation.
//
// A village is AT RISK only on concrete evidence at the village:
//   - a flooded road segment within 0.5 km (C's flood model; it floods roads only with the river at alert+)
//   - a landslide runout within 1 km (= our landslide_screen events)
//   - a warning/danger gauge within 3 km where the flood model assessed NO road within 1 km
//     (the model can't say → unknown, never safe)
// A gauge at alert+ within 10 km sets the flood level but is not enough on its own: those villages
// are "watch" (counted per district in Argon's prompt, not alerted individually).

import type { EvacCentre, KnowledgeChunk, LngLat, RiskLevel, StationWithLatest, Village } from "@monsoonwatch/shared";
import { haversineKm, pointToLineKm } from "./geo";
import { levelFromRisk } from "./landslide";
import type { Situation } from "./situation";
import { levelFromThresholds } from "./verify";

export const SHORTLIST = {
  floodedNearKm: 0.5,
  runoutNearKm: 1,
  /** Gauge / river risk event that sets a village's flood level. */
  gaugeNearKm: 10,
  /** Flood-model gap: a warning/danger gauge this close and no assessed road within coverageKm. */
  gapGaugeKm: 3,
  coverageKm: 1,
  maxVillages: 40,
  maxCentres: 30,
  centreNearKm: 15,
  /** All of them (≈12k tokens): Argon cites past flood reports when it escalates a village (escalation.ts). */
  maxKnowledge: 40,
  coordDecimals: 4,
} as const;
export type ShortlistOptions = Partial<typeof SHORTLIST>;

export type AlertLevel = Exclude<RiskLevel, "normal">;
const LEVEL_RANK: Record<RiskLevel, number> = { normal: 0, alert: 1, warning: 2, danger: 3 };
const KNOWLEDGE_ORDER: Record<KnowledgeChunk["kind"], number> = { postmortem: 0, plan: 1, deep_research: 2, other: 3 };
const VULNERABLE = ["bedridden", "disabled", "elderly", "noTransport"] as const;

export interface RiskSignal {
  kind: "gauge" | "river_event" | "flooded_road" | "landslide_runout" | "flood_model_gap" | "argon_escalation";
  level: AlertLevel | null;
  km: number;
  /** Station / risk event id behind a gauge or river_event signal (cited by the rules planner). */
  sourceId?: string;
  /** Station the signal is about (gauge: itself; river_event: the event's station). */
  stationId?: string;
  /** Short, checkable text for the prompt and area warnings, e.g. "gauge X DANGER 3.2 km". */
  text: string;
}

export interface VillageRisk {
  village: Village;
  /** Highest level the evidence supports (flood: cited gauge/event; "alert" if flood model only). */
  level: AlertLevel;
  hazard: "flood" | "landslide";
  signals: RiskSignal[];
  /** Concrete evidence types at the village (flooded road, runout) — the main tie-break. */
  concrete: number;
  /** Nearest warning/danger gauge or river event, km (Infinity if none within gaugeNearKm). */
  gaugeKm: number;
  vulnerable: number;
}

export interface RiskScreen {
  /** Most at-risk first. */
  atRisk: VillageRisk[];
  /** Gauge at alert+ nearby but no concrete evidence at the village. */
  watch: { village: Village; level: AlertLevel }[];
  /** No risk signal, but the flood model can't say: nearest road "unknown" (no gauge in range) or no road within coverageKm. Never "safe". */
  unknown: { village: Village; reason: string }[];
  /** No risk signal and the nearest road was assessed (clear / outside the floodplain). */
  noSignal: Village[];
}

export interface DistrictSummary {
  district: string;
  atRisk: number;
  highestLevel: AlertLevel | null;
  floodedRoad: number;
  landslideRunout: number;
  floodModelGap: number;
  watch: number;
  unknown: number;
  noSignal: number;
}

export interface Shortlist {
  screen: RiskScreen;
  villages: VillageRisk[];
  centres: EvacCentre[];
  stations: StationWithLatest[];
  knowledge: KnowledgeChunk[];
  /** Villages NOT sent to Argon, per district (at-risk over the cap, watch, no signal). */
  notSent: DistrictSummary[];
  omitted: {
    atRiskOverCap: number;
    watch: number;
    unknown: number;
    noSignal: number;
    centresFar: number;
    centresOverCap: number;
    stationsNoReading: number;
    knowledgeOverCap: number;
  };
}

// ---- geometry: a coarse grid so 765 villages × 84k road segments stays fast ----

interface Line { coords: LngLat[]; bbox: [number, number, number, number]; level: AlertLevel | null; id?: string }

function lineOf(coords: LngLat[], level: AlertLevel | null, id?: string): Line {
  const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
  return { coords, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], level, ...(id !== undefined && { id }) };
}

export class LineIndex {
  private readonly cells = new Map<string, Line[]>();
  constructor(lines: Line[], private readonly cellDeg = 0.02) {
    for (const line of lines) {
      const [x0, y0, x1, y1] = line.bbox;
      for (let cx = Math.floor(x0 / cellDeg); cx <= Math.floor(x1 / cellDeg); cx++) {
        for (let cy = Math.floor(y0 / cellDeg); cy <= Math.floor(y1 / cellDeg); cy++) {
          const k = `${cx},${cy}`;
          const list = this.cells.get(k);
          if (list) list.push(line);
          else this.cells.set(k, [line]);
        }
      }
    }
  }

  static of(lines: { coords: LngLat[]; level?: AlertLevel | null; id?: string }[]): LineIndex {
    return new LineIndex(lines.filter((l) => l.coords.length > 0).map((l) => lineOf(l.coords, l.level ?? null, l.id)));
  }

  /** Highest-level line within `km`; among equals, the closest. */
  nearest(p: LngLat, km: number): { level: AlertLevel | null; km: number; id?: string } | null {
    const r = Math.ceil(km / 111 / this.cellDeg) + 1;
    const cx = Math.floor(p[0] / this.cellDeg), cy = Math.floor(p[1] / this.cellDeg);
    const seen = new Set<Line>();
    let best: { level: AlertLevel | null; km: number; id?: string } | null = null;
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        for (const line of this.cells.get(`${x},${y}`) ?? []) {
          if (seen.has(line)) continue;
          seen.add(line);
          const d = pointToLineKm(p, line.coords);
          if (d > km) continue;
          const rank = line.level ? LEVEL_RANK[line.level] : 0;
          const bestRank = best?.level ? LEVEL_RANK[best.level] : 0;
          if (!best || rank > bestRank || (rank === bestRank && d < best.km)) best = { level: line.level, km: d, ...(line.id !== undefined && { id: line.id }) };
        }
      }
    }
    return best;
  }
}

interface Point { id: string; lngLat: LngLat; level: AlertLevel; stationId?: string }

/** Highest-level point within `km`; among equals, the closest. */
function strongestPoint(p: LngLat, points: Point[], km: number): { point: Point; km: number } | null {
  let best: { point: Point; km: number } | null = null;
  for (const point of points) {
    const d = haversineKm(p, point.lngLat);
    if (d > km) continue;
    const rank = LEVEL_RANK[point.level];
    if (!best || rank > LEVEL_RANK[best.point.level] || (rank === LEVEL_RANK[best.point.level] && d < best.km)) best = { point, km: d };
  }
  return best;
}

const atLeastAlert = (l: RiskLevel): l is AlertLevel => LEVEL_RANK[l] >= LEVEL_RANK.alert;
const km1 = (km: number) => Math.round(km * 10) / 10;
const maxLevel = (a: AlertLevel, b: AlertLevel) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a);
const vulnerableCount = (v: Village) => (v.vulnerable ? VULNERABLE.reduce((n, k) => n + (v.vulnerable![k] ?? 0), 0) : 0);

/**
 * Most at-risk first: highest level → more concrete evidence (flooded road, runout) → nearer
 * warning/danger gauge → more vulnerable residents → more people.
 */
export function compareRisk(a: VillageRisk, b: VillageRisk): number {
  return LEVEL_RANK[b.level] - LEVEL_RANK[a.level] ||
    b.concrete - a.concrete ||
    a.gaugeKm - b.gaugeKm ||
    b.vulnerable - a.vulnerable ||
    b.village.population - a.village.population ||
    a.village._id.localeCompare(b.village._id);
}

/** Classify every village: at risk (concrete evidence), watch (gauge only) or no signal. Pure. */
export function screenVillages(s: Situation, opts: ShortlistOptions = {}): RiskScreen {
  const o = { ...SHORTLIST, ...opts };
  const located = new Map<string, LngLat>([
    ...s.stations.map((st) => [st._id, st.location.coordinates] as [string, LngLat]),
    ...(s.glofas ?? []).map((g) => [g.id, g.lngLat] as [string, LngLat]),
  ]);
  const gauges: Point[] = [];
  for (const st of s.stations) {
    if (!st.thresholds || !st.latest) continue;
    const level = levelFromThresholds(st.latest.value, st.thresholds);
    if (atLeastAlert(level)) gauges.push({ id: st._id, lngLat: st.location.coordinates, level });
  }
  const riverEvents: Point[] = [];
  for (const e of s.riskEvents) {
    const at = e.type === "river_threshold" && e.stationId ? located.get(e.stationId) : undefined;
    if (at && atLeastAlert(e.level)) riverEvents.push({ id: e._id, lngLat: at, level: e.level, stationId: e.stationId! });
  }
  // Flooded segments with their ids when the road layer is loaded (to find the gauge that floods them).
  const blockedIds = new Set(s.hazards.blockedRoadIds);
  const floodedRoads = s.roads.filter((r) => blockedIds.has(String(r.id)));
  const flooded = LineIndex.of(floodedRoads.length
    ? floodedRoads.map((r) => ({ coords: r.geometry.coordinates, id: String(r.id) }))
    : s.hazards.blockedRoads.coordinates.map((coords) => ({ coords })));
  const gaugeById = new Map(gauges.map((g) => [g.id, g]));
  const runouts = LineIndex.of(s.hazards.landslide.runouts.map((r) => ({ coords: r.coordinates, level: levelFromRisk(r.risk) })));
  // Unknown ≠ safe: without the assessed set, the flood model covers nothing.
  const assessed = LineIndex.of(s.assessedRoadIds ? s.roads.filter((r) => s.assessedRoadIds!.has(String(r.id))).map((r) => ({ coords: r.geometry.coordinates })) : []);
  // C's per-segment status (when loaded): the nearest road within coverageKm says whether the model can judge this spot.
  const allRoads = s.roadStatusOf ? LineIndex.of(s.roads.map((r) => ({ coords: r.geometry.coordinates, id: String(r.id) }))) : null;
  /** null = the model can judge it; otherwise why it can't (unknown ≠ safe). */
  const modelBlindSpot = (p: LngLat): string | null => {
    if (!allRoads) return assessed.nearest(p, o.coverageKm) ? null : `flood model has no road data within ${o.coverageKm} km`;
    const near = allRoads.nearest(p, o.coverageKm);
    if (!near?.id) return `no mapped road within ${o.coverageKm} km — flood model can't assess this spot`;
    return s.roadStatusOf!(near.id) === "unknown" ? "nearest road's flood status is unknown (no river gauge in range)" : null;
  };

  const screen: RiskScreen = { atRisk: [], watch: [], unknown: [], noSignal: [] };
  for (const v of s.villages) {
    const p = v.location.coordinates;
    const signals: RiskSignal[] = [];
    const road = flooded.nearest(p, o.floodedNearKm);
    // C's flood model floods a segment from ONE gauge (its nearest, ≤ 20 km): cite that gauge when known.
    const floodGauge = road?.id ? gaugeById.get(s.floodGaugeByRoadId?.get(road.id) ?? "") : undefined;
    const g = floodGauge ? { point: floodGauge, km: haversineKm(p, floodGauge.lngLat) } : strongestPoint(p, gauges, o.gaugeNearKm);
    if (g) signals.push({ kind: "gauge", level: g.point.level, km: g.km, sourceId: g.point.id, stationId: g.point.id, text: `gauge ${g.point.id} ${g.point.level.toUpperCase()} ${km1(g.km)} km` });
    // Prefer the event about the cited gauge's own station (so they can be compared), else the strongest nearby.
    const own = g ? riverEvents.filter((x) => x.stationId === g.point.id) : [];
    const e = (own.length ? strongestPoint(p, own, Infinity) : null) ?? strongestPoint(p, riverEvents, o.gaugeNearKm);
    if (e) signals.push({ kind: "river_event", level: e.point.level, km: e.km, sourceId: e.point.id, stationId: e.point.stationId, text: `river event ${e.point.id} ${e.point.level.toUpperCase()} ${km1(e.km)} km` });
    const river = [g, e].filter((x) => x !== null).map((x) => ({ level: x.point.level, km: x.km }));
    const floodLevel = river.reduce<AlertLevel | null>((m, x) => (m ? maxLevel(m, x.level) : x.level), null);
    const high = river.filter((x) => LEVEL_RANK[x.level] >= LEVEL_RANK.warning);
    const gaugeKm = high.length ? Math.min(...high.map((x) => x.km)) : Infinity;

    if (road) signals.push({ kind: "flooded_road", level: null, km: road.km, ...(floodGauge && { sourceId: floodGauge.id }), text: `flooded road ${km1(road.km)} km${floodGauge ? ` (flooded from gauge ${floodGauge.id})` : ""} (approximate flood model)` });
    const ls = runouts.nearest(p, o.runoutNearKm);
    if (ls) signals.push({ kind: "landslide_runout", level: ls.level, km: ls.km, text: `landslide runout ${ls.level!.toUpperCase()} ${km1(ls.km)} km (screening)` });
    const blind = road ? null : modelBlindSpot(p);
    const gap = !road && gaugeKm <= o.gapGaugeKm && blind !== null;
    if (gap) signals.push({ kind: "flood_model_gap", level: null, km: gaugeKm, text: `${blind} (unknown, not safe)` });

    const concrete = (road ? 1 : 0) + (ls ? 1 : 0);
    if (concrete === 0 && !gap) {
      if (floodLevel) screen.watch.push({ village: v, level: floodLevel });
      else if (blind) screen.unknown.push({ village: v, reason: blind });
      else screen.noSignal.push(v);
      continue;
    }
    // Flood evidence takes the cited river level (flood model alone → "alert"); landslide its band.
    const flood: AlertLevel | null = road || gap ? (floodLevel ?? "alert") : null;
    const slide: AlertLevel | null = ls ? ls.level : null;
    const hazard = flood && (!slide || LEVEL_RANK[flood] >= LEVEL_RANK[slide]) ? "flood" : "landslide";
    screen.atRisk.push({
      village: v, level: hazard === "flood" ? flood! : slide!, hazard, signals, concrete, gaugeKm, vulnerable: vulnerableCount(v),
    });
  }
  screen.atRisk.sort(compareRisk);
  return screen;
}

/** Per-district counts of villages (at risk, watch, no signal) in the given sets. */
export function summariseDistricts(atRisk: VillageRisk[], watch: RiskScreen["watch"], noSignal: Village[], unknown: RiskScreen["unknown"] = []): DistrictSummary[] {
  const by = new Map<string, DistrictSummary>();
  const get = (d: string) => {
    let x = by.get(d);
    if (!x) by.set(d, (x = { district: d, atRisk: 0, highestLevel: null, floodedRoad: 0, landslideRunout: 0, floodModelGap: 0, watch: 0, unknown: 0, noSignal: 0 }));
    return x;
  };
  for (const r of atRisk) {
    const x = get(r.village.district);
    x.atRisk++;
    x.highestLevel = x.highestLevel ? maxLevel(x.highestLevel, r.level) : r.level;
    if (r.signals.some((sig) => sig.kind === "flooded_road")) x.floodedRoad++;
    if (r.signals.some((sig) => sig.kind === "landslide_runout")) x.landslideRunout++;
    if (r.signals.some((sig) => sig.kind === "flood_model_gap")) x.floodModelGap++;
  }
  for (const w of watch) get(w.village.district).watch++;
  for (const u of unknown) get(u.village.district).unknown++;
  for (const v of noSignal) get(v.district).noSignal++;
  return [...by.values()].sort((a, b) =>
    (b.highestLevel ? LEVEL_RANK[b.highestLevel] : 0) - (a.highestLevel ? LEVEL_RANK[a.highestLevel] : 0) || b.atRisk - a.atRisk || a.district.localeCompare(b.district));
}

/** What Argon gets: the most at-risk villages, centres near them, stations with a reading. */
export function shortlistForArgon(s: Situation, opts: ShortlistOptions = {}): Shortlist {
  const o = { ...SHORTLIST, ...opts };
  const screen = screenVillages(s, o);
  const villages = screen.atRisk.slice(0, o.maxVillages);

  const near = s.centres
    .map((c) => ({ c, km: Math.min(...villages.map((v) => haversineKm(v.village.location.coordinates, c.location.coordinates))) }))
    .filter((x) => x.km <= o.centreNearKm)
    .sort((a, b) => a.km - b.km);
  const centres = near.slice(0, o.maxCentres).map((x) => x.c);
  const stations = s.stations.filter((st) => st.latest);
  const knowledge = [...s.knowledge].sort((a, b) => KNOWLEDGE_ORDER[a.kind] - KNOWLEDGE_ORDER[b.kind]).slice(0, o.maxKnowledge);
  const overCap = screen.atRisk.slice(o.maxVillages);

  return {
    screen, villages, centres, stations, knowledge,
    notSent: summariseDistricts(overCap, screen.watch, screen.noSignal, screen.unknown),
    omitted: {
      atRiskOverCap: overCap.length,
      watch: screen.watch.length,
      unknown: screen.unknown.length,
      noSignal: screen.noSignal.length,
      centresFar: s.centres.length - near.length,
      centresOverCap: near.length - centres.length,
      stationsNoReading: s.stations.length - stations.length,
      knowledgeOverCap: s.knowledge.length - knowledge.length,
    },
  };
}

/** One line for the Tech HUD: what the screen found and what Argon was not sent. */
export function shortlistSummary(sl: Shortlist): string {
  const m = sl.omitted;
  const left = [
    m.atRiskOverCap > 0 ? `${m.atRiskOverCap} at-risk villages over the cap (covered by queue / area-wide warnings)` : "",
    `${m.watch} watch villages (gauge at alert+ nearby, no flooding or runout at the village — advisory)`,
    m.unknown > 0 ? `${m.unknown} villages where the flood model can't judge (unknown, advisory)` : "",
    `${m.noSignal} villages with no risk signal (nearest road assessed)`,
    m.centresFar + m.centresOverCap > 0 ? `${m.centresFar + m.centresOverCap} centres far from them` : "",
    m.stationsNoReading > 0 ? `${m.stationsNoReading} stations with no reading` : "",
    m.knowledgeOverCap > 0 ? `${m.knowledgeOverCap} documents` : "",
  ].filter(Boolean);
  return `Risk screen: ${sl.screen.atRisk.length} villages at risk; Argon sent ${sl.villages.length} villages, ${sl.centres.length} centres, ${sl.stations.length} stations; not sent: ${left.join(", ")} (not sent ≠ safe)`;
}
