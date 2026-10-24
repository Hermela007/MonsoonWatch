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
  calibration?: PeakCalibration; // official Dec 2014 peak (replay curve top anchor), if known
}

/** Official 2014 peak level at a gauge, paired with its GloFAS cell's own Dec 2014 peak discharge. */
export interface PeakCalibration {
  peakM: number;
  cellPeakM3s: number;
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
 *  and its nearest main-channel cell's discharge — a basin-wide severity index, not hydraulics.
 *  Gauges with an official 2014 peak get it as an extra top anchor (curveAnchors). */
export const REPLAY_CURVE_M3S = { normal: 500, alert: 1500, danger: 4500 } as const;

/** Curve anchors [discharge m³/s, level m], ascending. Uncalibrated: normal/alert/danger. Calibrated
 *  (calibration-2014.json): the official 2014 peak is added as the TOP anchor at the cell's own Dec 2014
 *  peak discharge, and any anchor at or above it (in discharge or level) is dropped so the curve stays
 *  increasing — e.g. Pasir Puteh peaked (2.67 m) below its current danger level (3.2 m). */
export function curveAnchors(t: Thresholds, cal?: PeakCalibration): [number, number][] {
  const { normal: qn, alert: qa, danger: qd } = REPLAY_CURVE_M3S;
  const base: [number, number][] = [[qn, t.normal], [qa, t.alert], [qd, t.danger]];
  if (!cal) return base;
  const below = base.filter(([q, l]) => q < cal.cellPeakM3s && l < cal.peakM);
  return below.length ? [...below, [cal.cellPeakM3s, cal.peakM]] : base; // degenerate calibration → ignore it
}

/** Piecewise linear through the anchors; clamped at the first anchor below, extrapolated with the last
 *  segment's slope above the top anchor. */
export function dischargeToLevel(q: number, t: Thresholds, cal?: PeakCalibration): number {
  const a = curveAnchors(t, cal);
  if (q <= a[0]![0]) return a[0]![1];
  for (let i = 1; i < a.length; i++) {
    const [q0, l0] = a[i - 1]!;
    const [q1, l1] = a[i]!;
    if (q <= q1 || i === a.length - 1) return l0 + ((q - q0) / (q1 - q0)) * (l1 - l0);
  }
  return a[0]![1]; // single anchor (unreachable: base always has three)
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
    out.push({ id: g.id, levelM: round2(dischargeToLevel(q, g.thresholds, g.calibration)), source: "glofas-curve", dischargeM3s: Math.round(q) });
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
