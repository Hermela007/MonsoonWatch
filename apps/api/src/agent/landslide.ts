// B5 — landslide SCREENING model (GUIDELINES §6.4). Deterministic and transparent, no LLM:
//   risk = f(slope from C's terrain grid, accumulated rain at the nearest rain station, cited thresholds)
// then, for the highest-risk cells, a steepest-descent RUNOUT path downhill. Villages near a runout
// get a `landslide_screen` risk event the agent can cite (checked by verify.ts).
//
// UI label (required): "Screening tool. Shows where to check first. Does not replace an on-site engineer."
//
// Thresholds: Deep Research, team option A (research/output/landslide-thresholds.<region>.json):
//   alert 47.66 mm / 3 d (national, may over-warn in Kelantan) · warning 100 mm / 1 d (JKR/JICA)
//   danger 240 mm / 1 d (MetMalaysia) · slope ≥ 25° (KPKT/CIDB hilly-terrain guidelines).
// Risk bands encode the level so it survives the shared `{ risk }` shape:
//   alert 0.20–0.40 · warning 0.50–0.70 · danger 0.80–1.00 (higher within a band = steeper slope).

import { existsSync, readFileSync } from "node:fs";
import type { Hazards, LngLat, RiskEvent, RiskLevel, Village } from "@monsoonwatch/shared";
import type { ElevationGrid } from "../hazards/terrain";
import { haversineKm } from "./geo";

export type RainLevel = Exclude<RiskLevel, "normal">;
export interface LevelThreshold { level: RainLevel; days: number; mm: number }
export interface LandslideConfig { slopeMinDeg: number; levels: LevelThreshold[]; source: string }

/** Team option A defaults (same values as the committed research output). */
export const OPTION_A: LandslideConfig = {
  slopeMinDeg: 25,
  levels: [
    { level: "alert", days: 3, mm: 47.66 },
    { level: "warning", days: 1, mm: 100 },
    { level: "danger", days: 1, mm: 240 },
  ],
  source: "Deep Research option A (MDPI Atmosphere 2024; JKR/JICA; MetMalaysia; KPKT/CIDB)",
};

/** Prefer the research output file if present (so a re-run of Deep Research flows through). */
export function loadLandslideConfig(regionId: string): LandslideConfig {
  const file = new URL(`./research/output/landslide-thresholds.${regionId}.json`, import.meta.url);
  try {
    if (!existsSync(file)) return OPTION_A;
    const j = JSON.parse(readFileSync(file, "utf8")) as { check?: { passed?: boolean }; levels?: LevelThreshold[]; extraction?: { slopeMinDeg?: number } };
    if (!j.check?.passed || !j.levels?.length) return OPTION_A;
    return {
      slopeMinDeg: j.extraction?.slopeMinDeg ?? OPTION_A.slopeMinDeg,
      levels: j.levels.map(({ level, days, mm }) => ({ level, days, mm })),
      source: `research/output/landslide-thresholds.${regionId}.json`,
    };
  } catch {
    return OPTION_A;
  }
}

const RANK: Record<RainLevel, number> = { alert: 1, warning: 2, danger: 3 };
const BAND: Record<RainLevel, number> = { alert: 0.2, warning: 0.5, danger: 0.8 };

export function levelFromRisk(risk: number): RainLevel {
  return risk >= 0.8 ? "danger" : risk >= 0.5 ? "warning" : "alert";
}

export interface RainPoint {
  stationId: string;
  lngLat: LngLat;
  /** Today's total (replay: the day's total; live: since midnight), mm. */
  value: number;
  /** 6 previous daily totals, oldest first (last = yesterday); null = missing → 0. */
  rain6d?: (number | null)[];
}

/** Rain over the last `days` days including today, mm. */
export function rainOverDays(p: Pick<RainPoint, "value" | "rain6d">, days: number): number {
  const prev = (p.rain6d ?? []).slice(-(days - 1)).reduce<number>((s, v) => s + (v ?? 0), 0);
  return Math.round((p.value + (days > 1 ? prev : 0)) * 10) / 10;
}

/** Highest level whose threshold is reached at this station (null = below every threshold). */
export function rainLevel(p: RainPoint, cfg: LandslideConfig): { level: RainLevel; days: number; mm: number; threshold: number } | null {
  let best: { level: RainLevel; days: number; mm: number; threshold: number } | null = null;
  for (const t of cfg.levels) {
    const mm = rainOverDays(p, t.days);
    if (mm >= t.mm && (!best || RANK[t.level] > RANK[best.level])) best = { level: t.level, days: t.days, mm, threshold: t.mm };
  }
  return best;
}

const elev = (g: ElevationGrid, x: number, y: number): number | null => {
  if (x < 0 || y < 0 || x >= g.width || y >= g.height) return null;
  const v = g.data[y * g.width + x]!;
  return v === g.nodata ? null : v * g.scale;
};

/** Slope (degrees) at pixel (x, y) from central differences `step` pixels apart. */
export function slopeDegAt(g: ElevationGrid, x: number, y: number, step = 2): number | null {
  const l = elev(g, x - step, y), r = elev(g, x + step, y), u = elev(g, x, y - step), d = elev(g, x, y + step);
  if (l === null || r === null || u === null || d === null) return null;
  const run = 2 * step * g.metresPerPx;
  const gx = (r - l) / run, gy = (d - u) / run;
  return (Math.atan(Math.hypot(gx, gy)) * 180) / Math.PI;
}

export const pxToLngLat = (g: ElevationGrid, x: number, y: number): LngLat => [
  Math.round((g.bbox[0] + (x + 0.5) * g.dLon) * 1e5) / 1e5,
  Math.round((g.bbox[3] - (y + 0.5) * g.dLat) * 1e5) / 1e5,
];

/** Steepest-descent path downhill until the ground flattens (< `flatDeg`), a pit, or `maxSteps`. */
export function runoutPath(g: ElevationGrid, x0: number, y0: number, maxSteps = 60, flatDeg = 3): LngLat[] {
  const path: LngLat[] = [pxToLngLat(g, x0, y0)];
  let x = x0, y = y0;
  for (let i = 0; i < maxSteps; i++) {
    const here = elev(g, x, y);
    if (here === null) break;
    let best: { x: number; y: number; drop: number; dist: number } | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const e = elev(g, x + dx, y + dy);
      if (e === null) continue;
      const dist = Math.hypot(dx, dy) * g.metresPerPx;
      const drop = (here - e) / dist;
      if (drop > 0 && (!best || drop > best.drop)) best = { x: x + dx, y: y + dy, drop, dist };
    }
    if (!best) break; // pit
    x = best.x; y = best.y;
    path.push(pxToLngLat(g, x, y));
    if ((Math.atan(best.drop) * 180) / Math.PI < flatDeg) break; // reached flat ground
  }
  return path;
}

export interface RunoutSource { slopeDeg: number; level: RainLevel; stationId: string; rainMm: number; days: number; threshold: number }

export interface ScreenOptions {
  /** Sample every N pixels (≈ N × 75 m). */
  cellPx?: number;
  maxCells?: number;
  maxRunouts?: number;
  /** Rain stations further than this from a cell are not used for it. */
  maxStationKm?: number;
  /**
   * Populated places (village locations). Besides the statewide top runouts, the highest-risk
   * slope within `focusKm` of each place also gets a runout, so slopes ABOVE villages are
   * screened, not only the steepest remote hills.
   */
  focus?: LngLat[];
  focusKm?: number;
  /** Cap on the extra per-village runouts. */
  maxFocusRunouts?: number;
}

/** The screening itself. Pure: grid + rain + config in, cells + runouts (+ their sources) out. */
export function screenLandslides(
  g: ElevationGrid,
  rain: RainPoint[],
  cfg: LandslideConfig,
  opts: ScreenOptions = {},
): { landslide: Hazards["landslide"]; sources: RunoutSource[] } {
  const cellPx = opts.cellPx ?? 13;
  const maxCells = opts.maxCells ?? 3000;
  const maxRunouts = opts.maxRunouts ?? 25;
  const maxKm = opts.maxStationKm ?? 25;
  const all = rain.map((p) => ({ p, lvl: rainLevel(p, cfg) }));
  if (!all.some((r) => r.lvl)) return { landslide: { cells: [], runouts: [] }, sources: [] };

  const cells: { x: number; y: number; lngLat: LngLat; risk: number; src: RunoutSource }[] = [];
  for (let y = cellPx; y < g.height - cellPx; y += cellPx) {
    for (let x = cellPx; x < g.width - cellPx; x += cellPx) {
      const slope = slopeDegAt(g, x, y);
      if (slope === null || slope < cfg.slopeMinDeg) continue;
      const lngLat = pxToLngLat(g, x, y);
      // The cell's OWN nearest rain station decides (not the nearest one that happens to be over a
      // threshold, which would borrow rain from up to maxKm away and over-warn).
      let near: (typeof all)[number] | null = null;
      let nearKm = Infinity;
      for (const r of all) {
        const km = haversineKm(lngLat, r.p.lngLat);
        if (km < nearKm) { near = r; nearKm = km; }
      }
      if (!near?.lvl || nearKm > maxKm) continue;
      const lvl = near.lvl;
      const slopeFrac = Math.min(1, (slope - cfg.slopeMinDeg) / 25);
      const risk = Math.min(1, Math.round((BAND[lvl.level] + 0.2 * slopeFrac) * 100) / 100);
      cells.push({ x, y, lngLat, risk, src: { slopeDeg: Math.round(slope), level: lvl.level, stationId: near.p.stationId, rainMm: lvl.mm, days: lvl.days, threshold: lvl.threshold } });
    }
  }
  cells.sort((a, b) => b.risk - a.risk);

  const runouts: Hazards["landslide"]["runouts"] = [];
  const sources: RunoutSource[] = [];
  const starts: LngLat[] = [];
  const tryRunout = (c: (typeof cells)[number], spreadKm: number): boolean => {
    if (starts.some((s) => haversineKm(s, c.lngLat) < spreadKm)) return false; // spread runouts out
    const path = runoutPath(g, c.x, c.y);
    if (path.length < 3) return false;
    starts.push(c.lngLat);
    runouts.push({ type: "LineString", coordinates: path, risk: c.risk });
    sources.push(c.src);
    return true;
  };
  for (const c of cells) {
    if (runouts.length >= maxRunouts) break;
    tryRunout(c, 1.5);
  }

  // Slopes near villages: per place, its highest-risk cells within focusKm (cells sorted by risk).
  if (opts.focus?.length) {
    const focusKm = opts.focusKm ?? 3;
    const cap = opts.maxFocusRunouts ?? 300;
    const cellDeg = 0.03; // ≈ 3.3 km buckets
    const bucket = new Map<string, (typeof cells)[number][]>();
    for (const c of cells) {
      const k = `${Math.floor(c.lngLat[0] / cellDeg)},${Math.floor(c.lngLat[1] / cellDeg)}`;
      const list = bucket.get(k);
      if (list) list.push(c);
      else bucket.set(k, [c]);
    }
    let added = 0;
    for (const p of opts.focus) {
      if (added >= cap) break;
      const bx = Math.floor(p[0] / cellDeg), by = Math.floor(p[1] / cellDeg);
      const near: (typeof cells)[number][] = [];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const c of bucket.get(`${bx + dx},${by + dy}`) ?? []) if (haversineKm(p, c.lngLat) <= focusKm) near.push(c);
      }
      near.sort((a, b) => b.risk - a.risk);
      for (const c of near.slice(0, 5)) if (tryRunout(c, 0.5)) { added++; break; } // the riskiest slope that yields a runout
    }
  }
  return { landslide: { cells: cells.slice(0, maxCells).map(({ lngLat, risk }) => ({ lngLat, risk })), runouts }, sources };
}

/**
 * Villages within `nearKm` of a runout path get a `landslide_screen` risk event (source "agent") —
 * evidence the orchestrator can cite and verify.ts checks (value = risk, threshold = level band).
 */
export function landslideEventsForVillages(
  regionId: string,
  ts: string,
  villages: Village[],
  landslide: Hazards["landslide"],
  sources: RunoutSource[],
  nearKm = 1.0,
): RiskEvent[] {
  const out: RiskEvent[] = [];
  for (const v of villages) {
    let best: { i: number; km: number } | null = null;
    landslide.runouts.forEach((r, i) => {
      for (const p of r.coordinates) {
        const km = haversineKm(v.location.coordinates, p);
        if (km <= nearKm && (!best || r.risk > landslide.runouts[best.i]!.risk)) best = { i, km };
      }
    });
    if (!best) continue;
    const { i, km } = best as { i: number; km: number };
    const r = landslide.runouts[i]!;
    const s = sources[i]!;
    const level = levelFromRisk(r.risk);
    out.push({
      _id: `ls:${v._id}:${level}:${ts.slice(0, 10)}`,
      regionId, ts, type: "landslide_screen", level,
      value: r.risk, threshold: BAND[level],
      message: `Landslide screening (not a site survey): runout from a ${s.slopeDeg}° slope passes ${Math.round(km * 1000)} m from ${v.name}; ` +
        `${s.rainMm} mm over ${s.days} d at ${s.stationId} ≥ ${s.threshold} mm (${level.toUpperCase()})`,
      source: "agent",
    });
  }
  return out;
}
