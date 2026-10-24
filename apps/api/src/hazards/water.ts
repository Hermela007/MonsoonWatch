// Water model (pure functions; DB access lives in ./index.ts). Everything here is an APPROXIMATION —
// see docs/HAZARDS.md for every assumption. Units: metres above mean sea level (JPS datum, verified
// against the DEM by `pnpm prep:hazards`), m³/s for GloFAS discharge.

export interface Thresholds { normal: number; alert: number; warning: number; danger: number }

export interface Gauge {
  id: string;
  name: string;
  lngLat: [number, number];
  thresholds: Thresholds;
  cellId: string; // nearest GloFAS cell, used in replay
}

export interface GaugeLevel {
  id: string;
  levelM: number;
  source: "jps" | "glofas-curve";
  dischargeM3s?: number;
  readingTs?: string;
}

export interface Segment {
  id: string;
  groundM: number | null;
  riverDistM: number | null;
  gaugeId: string | null;
  gaugeDistM: number | null;
}

/** A segment is in the floodplain only this close to an OSM river line. */
export const FLOODPLAIN_M = 3000;
/** A gauge's water surface is applied only this far (straight line) from the gauge: the river surface
 *  slopes ~0.25 m/km on the main channel, so further away the error exceeds the DEM's. */
export const MAX_GAUGE_DIST_M = 20_000;
/** worst = likely + margin. Live: JPS level is measured; margin covers the next hours' rise (Kelantan
 *  gauges rise ~0.1–0.3 m/h in a monsoon surge) plus sensor error. Replay: the discharge→level curve
 *  below is a rough calibration, so its error is larger. */
export const UNCERTAINTY_M = { live: 0.5, replay: 2.0 } as const;

/** APPROXIMATE discharge → level curve for the replay (GloFAS gives discharge, JPS thresholds are levels).
 *  Same anchors as the riskRiver processor: 1,500 m³/s ↔ alert, 4,500 m³/s ↔ danger; 500 m³/s ↔ normal
 *  (typical dry-season flow in the 2014 series). Linear between anchors, clamped at normal below 500,
 *  extrapolated above 4,500 with the alert→danger slope. Applied to each gauge with its OWN thresholds
 *  and its nearest main-channel cell's discharge — a basin-wide severity index, not hydraulics. */
export const REPLAY_CURVE_M3S = { normal: 500, alert: 1500, danger: 4500 } as const;

export function dischargeToLevel(q: number, t: Thresholds): number {
  const { normal: qn, alert: qa, danger: qd } = REPLAY_CURVE_M3S;
  if (q <= qn) return t.normal;
  if (q <= qa) return t.normal + ((q - qn) / (qa - qn)) * (t.alert - t.normal);
  return t.alert + ((q - qa) / (qd - qa)) * (t.danger - t.alert); // also extrapolates above danger
}

export type Level = "normal" | "alert" | "warning" | "danger";

export function levelName(levelM: number, t: Thresholds): Level {
  if (levelM >= t.danger) return "danger";
  if (levelM >= t.warning) return "warning";
  if (levelM >= t.alert) return "alert";
  return "normal";
}

/** How far a gauge is into its flood range: 0 = alert, 1 = danger (can be < 0 or > 1). */
export function riskRatio(levelM: number, t: Thresholds): number {
  return t.danger > t.alert ? (levelM - t.alert) / (t.danger - t.alert) : levelM >= t.alert ? 1 : -1;
}

/** Replay: level at every gauge from its nearest cell's discharge. */
export function replayLevels(gauges: Gauge[], dischargeByCell: Map<string, number>): GaugeLevel[] {
  const out: GaugeLevel[] = [];
  for (const g of gauges) {
    const q = dischargeByCell.get(g.cellId);
    if (q === undefined) continue;
    out.push({ id: g.id, levelM: round2(dischargeToLevel(q, g.thresholds)), source: "glofas-curve", dischargeM3s: Math.round(q) });
  }
  return out;
}

/** The gauge furthest into its flood range (likelyLevelM / worstLevelM are reported there). */
export function highestRisk(gauges: Gauge[], levels: GaugeLevel[]): { gauge: Gauge; level: GaugeLevel } | null {
  const byId = new Map(gauges.map((g) => [g.id, g]));
  let best: { gauge: Gauge; level: GaugeLevel; r: number } | null = null;
  for (const l of levels) {
    const g = byId.get(l.id);
    if (!g) continue;
    const r = riskRatio(l.levelM, g.thresholds);
    if (!best || r > best.r) best = { gauge: g, level: l, r };
  }
  return best && { gauge: best.gauge, level: best.level };
}

/** Flooded = in the floodplain, near enough to its gauge, that gauge is at or above its JPS ALERT level
 *  (below alert the river is in its banks, so low DEM pixels along the channel must not "flood"), and the
 *  segment's lowest ground is below the gauge's water surface (+ optional margin for the worst case). */
export function floodedSegmentIds(segments: Segment[], gauges: Gauge[], levels: GaugeLevel[], marginM = 0): string[] {
  const alert = new Map(gauges.map((g) => [g.id, g.thresholds.alert]));
  const levelBy = new Map(levels.map((l) => [l.id, l.levelM]));
  const out: string[] = [];
  for (const s of segments) {
    if (s.groundM === null || s.riverDistM === null || s.gaugeId === null || s.gaugeDistM === null) continue;
    if (s.riverDistM > FLOODPLAIN_M || s.gaugeDistM > MAX_GAUGE_DIST_M) continue;
    const level = levelBy.get(s.gaugeId);
    const onset = alert.get(s.gaugeId);
    if (level === undefined || onset === undefined || level + marginM < onset) continue; // in-bank: no overbank flow
    if (s.groundM < level + marginM) out.push(s.id);
  }
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
