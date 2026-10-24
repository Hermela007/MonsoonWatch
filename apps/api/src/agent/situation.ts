// Everything the agent knows about a region at one moment. Loaded from MongoDB (situation-db.ts)
// or from the labelled TEST scenario (sample/kelantan-test.ts).

import type { EvacCentre, Hazards, KnowledgeChunk, LngLat, Reading, Region, RiskEvent, RiskLevel, RoadFeature, StationWithLatest, Village } from "@monsoonwatch/shared";
import { haversineKm, pointToLineKm } from "./geo";
import { levelFromRisk } from "./landslide";
import { levelFromThresholds } from "./verify";

export interface Situation {
  region: Region;
  mode: "live" | "replay";
  now: Date;
  stations: StationWithLatest[];
  riskEvents: RiskEvent[];
  villages: Village[];
  centres: EvacCentre[];
  roads: RoadFeature[];
  hazards: Pick<Hazards, "blockedRoads" | "blockedRoadIds" | "landslide">;
  knowledge: KnowledgeChunk[];
  /** GloFAS main-channel cells (discharge m³/s, reconstructed) — the river evidence in the 2014 replay. */
  glofas?: { id: string; label: string; lngLat: LngLat; latest: Reading | null }[];
  /** Road segments the flood model assessed (others are unknown, not safe). Not sent to Gemini. */
  assessedRoadIds?: ReadonlySet<string>;
  /** Caveats from the hazard models (approximate flood model, screening landslide model). */
  hazardNotes?: string[];
  /** True for the sample scenario: shown in HUD summaries so test output is never mistaken for real. */
  isTestData: boolean;
}

// ---- Argon shortlist ----
// Deterministic pre-filter used ONLY to build Argon's prompt (keeps its input small). The checks
// and subagents keep the full Situation. A village with no risk signal is left out of the prompt,
// not declared safe: the run logs how many were left out.

export const SHORTLIST = {
  maxVillages: 40,
  maxCentres: 30,
  maxKnowledge: 10,
  /** Village counts as "near" a gauge / risk-event station within this distance. */
  gaugeNearKm: 10,
  /** …and near a flooded road or landslide runout within this distance (= landslide_screen events). */
  hazardNearKm: 1,
  /** Centres sent: within this distance of a shortlisted village. */
  centreNearKm: 15,
  coordDecimals: 4,
} as const;

const LEVEL_RANK: Record<RiskLevel, number> = { normal: 0, alert: 1, warning: 2, danger: 3 };
const KNOWLEDGE_ORDER: Record<KnowledgeChunk["kind"], number> = { postmortem: 0, plan: 1, deep_research: 2, other: 3 };

export interface RiskSignal {
  kind: "gauge" | "risk_event" | "flooded_road" | "landslide_runout";
  /** null for a flooded road (the flood model gives no level); ranked like "alert". */
  level: Exclude<RiskLevel, "normal"> | null;
  /** Distance from the village, km. */
  km: number;
  /** Short, checkable text for the prompt, e.g. "gauge X DANGER 3.2 km". */
  text: string;
}

export interface Shortlist {
  villages: { village: Village; signals: RiskSignal[] }[];
  centres: EvacCentre[];
  stations: StationWithLatest[];
  knowledge: KnowledgeChunk[];
  omitted: {
    villagesNoSignal: number;
    villagesOverCap: number;
    centresFar: number;
    centresOverCap: number;
    stationsNoReading: number;
    knowledgeOverCap: number;
  };
}

interface Point { id: string; lngLat: LngLat; level: Exclude<RiskLevel, "normal"> }
interface Line { coords: LngLat[]; bbox: [number, number, number, number]; level: Exclude<RiskLevel, "normal"> | null }

const atLeastAlert = (l: RiskLevel): l is Exclude<RiskLevel, "normal"> => LEVEL_RANK[l] >= LEVEL_RANK.alert;
const rankOf = (sig: RiskSignal) => (sig.level ? LEVEL_RANK[sig.level] : LEVEL_RANK.alert);
const km1 = (km: number) => Math.round(km * 10) / 10;
const AT_VILLAGE: ReadonlySet<RiskSignal["kind"]> = new Set(["flooded_road", "landslide_runout"]);

/** Highest-level point within `nearKm`; among equals, the closest. One per village keeps the prompt short. */
function strongestPoint(p: LngLat, points: Point[], nearKm: number): { point: Point; km: number } | null {
  let best: { point: Point; km: number } | null = null;
  for (const point of points) {
    const km = haversineKm(p, point.lngLat);
    if (km > nearKm) continue;
    const rank = LEVEL_RANK[point.level];
    if (!best || rank > LEVEL_RANK[best.point.level] || (rank === LEVEL_RANK[best.point.level] && km < best.km)) best = { point, km };
  }
  return best;
}

/**
 * Most at-risk first: highest level → a hazard AT the village (flooded road / runout within
 * hazardNearKm) → nearest evidence → more people. In a valley-wide flood (24 Dec 2014: 17 of 18
 * gauges at WARNING) the level alone ties hundreds of villages, so the tie-breaks matter.
 */
export function compareRisk(a: { village: Village; signals: RiskSignal[] }, b: { village: Village; signals: RiskSignal[] }): number {
  const maxRank = (x: typeof a) => Math.max(...x.signals.map(rankOf));
  const atVillage = (x: typeof a) => (x.signals.some((sig) => AT_VILLAGE.has(sig.kind)) ? 1 : 0);
  const nearest = (x: typeof a) => Math.min(...x.signals.filter((sig) => rankOf(sig) === maxRank(x)).map((sig) => sig.km));
  return maxRank(b) - maxRank(a) ||
    atVillage(b) - atVillage(a) ||
    nearest(a) - nearest(b) ||
    b.village.population - a.village.population ||
    a.village._id.localeCompare(b.village._id);
}

function lineOf(coords: LngLat[], level: Line["level"]): Line {
  const xs = coords.map((c) => c[0]), ys = coords.map((c) => c[1]);
  return { coords, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], level };
}

/** Nearest line within `nearKm` (bbox pre-filter keeps this cheap for thousands of villages). */
function nearestLine(p: LngLat, lines: Line[], nearKm: number): { line: Line; km: number } | null {
  const pad = (nearKm / 111) * 1.5;
  let best: { line: Line; km: number } | null = null;
  for (const line of lines) {
    const [x0, y0, x1, y1] = line.bbox;
    if (p[0] < x0 - pad || p[0] > x1 + pad || p[1] < y0 - pad || p[1] > y1 + pad) continue;
    const km = pointToLineKm(p, line.coords);
    if (km > nearKm) continue;
    // Highest level wins; among equals, the closest.
    const rank = line.level ? LEVEL_RANK[line.level] : 0;
    const bestRank = best?.line.level ? LEVEL_RANK[best.line.level] : 0;
    if (!best || rank > bestRank || (rank === bestRank && km < best.km)) best = { line, km };
  }
  return best;
}

/** Risk signals for every village (pure). */
export function villageRiskSignals(s: Situation, opts: Partial<typeof SHORTLIST> = {}): Map<string, RiskSignal[]> {
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
  const events: Point[] = [];
  for (const e of s.riskEvents) {
    // landslide_screen events are built from runouts (covered below) and carry no station.
    const at = e.stationId ? located.get(e.stationId) : undefined;
    if (at && atLeastAlert(e.level)) events.push({ id: e._id, lngLat: at, level: e.level });
  }
  const flooded = s.hazards.blockedRoads.coordinates.filter((c) => c.length > 0).map((c) => lineOf(c, null));
  const runouts = s.hazards.landslide.runouts.filter((r) => r.coordinates.length > 0).map((r) => lineOf(r.coordinates, levelFromRisk(r.risk)));

  const out = new Map<string, RiskSignal[]>();
  for (const v of s.villages) {
    const p = v.location.coordinates;
    const sig: RiskSignal[] = [];
    const g = strongestPoint(p, gauges, o.gaugeNearKm);
    if (g) sig.push({ kind: "gauge", level: g.point.level, km: g.km, text: `gauge ${g.point.id} ${g.point.level.toUpperCase()} ${km1(g.km)} km` });
    const e = strongestPoint(p, events, o.gaugeNearKm);
    if (e) sig.push({ kind: "risk_event", level: e.point.level, km: e.km, text: `risk event ${e.point.id} ${e.point.level.toUpperCase()} ${km1(e.km)} km` });
    const road = nearestLine(p, flooded, o.hazardNearKm);
    if (road) sig.push({ kind: "flooded_road", level: null, km: road.km, text: `flooded road ${km1(road.km)} km (approximate flood model)` });
    const ls = nearestLine(p, runouts, o.hazardNearKm);
    if (ls) sig.push({ kind: "landslide_runout", level: ls.line.level, km: ls.km, text: `landslide runout ${ls.line.level!.toUpperCase()} ${km1(ls.km)} km (screening)` });
    if (sig.length > 0) out.set(v._id, sig);
  }
  return out;
}

/** What Argon gets: villages with a risk signal (most at-risk first), nearby centres, stations with a reading. */
export function shortlistForArgon(s: Situation, opts: Partial<typeof SHORTLIST> = {}): Shortlist {
  const o = { ...SHORTLIST, ...opts };
  const signals = villageRiskSignals(s, o);
  const ranked = s.villages
    .filter((v) => signals.has(v._id))
    .map((v) => ({ village: v, signals: signals.get(v._id)! }))
    .sort(compareRisk);
  const villages = ranked.slice(0, o.maxVillages);

  const near = s.centres
    .map((c) => ({ c, km: Math.min(...villages.map((v) => haversineKm(v.village.location.coordinates, c.location.coordinates))) }))
    .filter((x) => x.km <= o.centreNearKm)
    .sort((a, b) => a.km - b.km);
  const centres = near.slice(0, o.maxCentres).map((x) => x.c);

  const stations = s.stations.filter((st) => st.latest);
  const knowledge = [...s.knowledge].sort((a, b) => KNOWLEDGE_ORDER[a.kind] - KNOWLEDGE_ORDER[b.kind]).slice(0, o.maxKnowledge);

  return {
    villages, centres, stations, knowledge,
    omitted: {
      villagesNoSignal: s.villages.length - ranked.length,
      villagesOverCap: ranked.length - villages.length,
      centresFar: s.centres.length - near.length,
      centresOverCap: near.length - centres.length,
      stationsNoReading: s.stations.length - stations.length,
      knowledgeOverCap: s.knowledge.length - knowledge.length,
    },
  };
}

/** One line for the Tech HUD: what the shortlist left out of Argon's prompt. */
export function shortlistSummary(sl: Shortlist): string {
  const m = sl.omitted;
  const parts = [
    `${m.villagesNoSignal} villages with no risk signal not sent`,
    m.villagesOverCap > 0 ? `${m.villagesOverCap} lower-risk villages over the cap of ${sl.villages.length}` : "",
    m.centresFar + m.centresOverCap > 0 ? `${m.centresFar + m.centresOverCap} centres far from them` : "",
    m.stationsNoReading > 0 ? `${m.stationsNoReading} stations with no reading` : "",
    m.knowledgeOverCap > 0 ? `${m.knowledgeOverCap} documents` : "",
  ].filter(Boolean);
  return `Argon shortlist: ${sl.villages.length} villages, ${sl.centres.length} centres, ${sl.stations.length} stations sent; left out: ${parts.join(", ")} (left out ≠ safe)`;
}

const round = (c: LngLat, dp: number): LngLat => {
  const f = 10 ** dp;
  return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
};

/**
 * Compact view for Argon's prompt: no road geometry (Argon doesn't route; planRoute does).
 * Shortlisted by default; `{ full: true }` sends everything (used by --dry-run for comparison).
 */
export function situationForPrompt(s: Situation, opts: { full?: boolean; shortlist?: Shortlist } = {}) {
  const dp = SHORTLIST.coordDecimals;
  const sl = opts.full
    ? { villages: s.villages.map((village) => ({ village, signals: [] as RiskSignal[] })), centres: s.centres, stations: s.stations, knowledge: s.knowledge, omitted: null }
    : (opts.shortlist ?? shortlistForArgon(s));
  return {
    testData: s.isTestData,
    region: { id: s.region._id, name: s.region.name, languages: s.region.languages, timezone: s.region.timezone },
    mode: s.mode,
    now: s.now.toISOString(),
    ...(sl.omitted && {
      shortlist: `Only villages with a deterministic risk signal are listed (most at-risk first); ${sl.omitted.villagesNoSignal + sl.omitted.villagesOverCap} others were left out — not checked as safe.`,
    }),
    stations: sl.stations.map((st) => ({
      id: st._id, name: st.name, kind: st.kind, district: st.district, basin: st.basin,
      lngLat: round(st.location.coordinates, dp), thresholdsM: st.thresholds,
      latest: st.latest ? { ts: st.latest.ts, value: st.latest.value, rain6dMm: st.latest.rain6d } : null,
    })),
    riskEvents: s.riskEvents.map((e) => ({ id: e._id, ts: e.ts, type: e.type, stationId: e.stationId, level: e.level, value: e.value, threshold: e.threshold, message: e.message })),
    villages: sl.villages.map(({ village: v, signals }) => ({
      id: v._id, name: v.name, district: v.district, lngLat: round(v.location.coordinates, dp), population: v.population, vulnerable: v.vulnerable,
      ...(signals.length > 0 && { riskSignals: signals.map((x) => x.text) }),
    })),
    evacCentres: sl.centres.map((c) => ({ id: c._id, name: c.name, lngLat: round(c.location.coordinates, dp), capacity: c.capacity, headcount: c.headcount, elevationM: c.elevationM })),
    glofasCells: (s.glofas ?? []).map((g) => ({
      id: g.id, label: g.label, lngLat: round(g.lngLat, dp),
      latestDischargeM3s: g.latest ? { ts: g.latest.ts, value: g.latest.value } : null,
      note: "Reconstructed GloFAS discharge (m³/s), not a water level; thresholds approximate",
    })),
    floodedRoadSegments: s.hazards.blockedRoadIds.length,
    hazardNotes: s.hazardNotes ?? [],
    landslideRunouts: s.hazards.landslide.runouts.length,
    knowledge: sl.knowledge.map((k) => ({ title: k.title, kind: k.kind, sourceUrl: k.sourceUrl, text: k.chunk })),
  };
}
