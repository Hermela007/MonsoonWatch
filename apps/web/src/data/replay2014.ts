import type { LngLat } from '../geo/region';

/**
 * The Dec 2014 replay, driven by real data (Workstream C's committed files, see
 * apps/web/scripts/build-real-data.mjs):
 *   - rain: Open-Meteo historical daily precipitation, basin average of the region's points (mm)
 *   - river: GloFAS daily discharge on the main channel near Kuala Krai (m³/s)
 * Converting discharge (m³/s) to a river rise (m) is an APPROXIMATION (linear in flow above
 * the period's median, scaled to an assumed peak rise) and is labelled as such in the UI.
 */
export interface RealSeries {
  rain: { start: string; points: { lngLat: LngLat; dailyMm: number[] }[] };
  discharge: { start: string; cells: { lngLat: LngLat; dailyM3s: number[] }[] };
}

export const REPLAY_START_MS = Date.UTC(2014, 11, 16, 16); // 17 Dec 2014 00:00 MYT
export const REPLAY_HOURS = 14 * 24; // to 31 Dec 2014
/** Demo "now": 21 Dec 2014 08:00 MYT — heavy rain under way, river rising, three days before the peak. */
export const NOW_HOUR = 4 * 24 + 8;
/** Assumed river rise at the GloFAS peak (m). VERIFY against JPS Kuala Krai records. */
export const PEAK_STAGE_M = 18;
/** Water this deep (m) counts as "reached" — about knee height. */
export const WET_THRESHOLD_M = 0.3;

const DAY_MS = 86_400_000;
let rainMmPerDay: (h: number) => number = () => 0;
let rainCumMm: Float32Array = new Float32Array(REPLAY_HOURS + 1);
let maxDailyMm = 1;
let dischargeAt: (h: number) => number = () => 0;
let qMin = 0;
let qMax = 1;

/** Linear interpolation of a daily series (values centred at local noon) at replay hour h. */
function dailyInterp(startIso: string, daily: number[], h: number) {
  const t = REPLAY_START_MS + h * 3600_000;
  const day0 = Date.parse(`${startIso}T12:00:00+08:00`);
  const x = (t - day0) / DAY_MS;
  const i = Math.max(0, Math.min(daily.length - 2, Math.floor(x)));
  const f = Math.max(0, Math.min(1, x - i));
  return daily[i] * (1 - f) + daily[i + 1] * f;
}

export function setRealSeries(d: RealSeries) {
  const pts = d.rain.points;
  rainMmPerDay = (h) => pts.reduce((s, p) => s + dailyInterp(d.rain.start, p.dailyMm, h), 0) / pts.length;
  maxDailyMm = 1;
  rainCumMm = new Float32Array(REPLAY_HOURS + 1);
  for (let h = 1; h <= REPLAY_HOURS; h++) {
    const mm = rainMmPerDay(h - 0.5);
    maxDailyMm = Math.max(maxDailyMm, mm);
    rainCumMm[h] = rainCumMm[h - 1] + mm / 24;
  }
  // Main channel: the cell near Kuala Krai with the largest flow.
  const kk: LngLat = [102.2, 5.53];
  const main = d.discharge.cells
    .filter((c) => Math.max(...c.dailyM3s) > 1000)
    .sort((a, b) => Math.hypot(a.lngLat[0] - kk[0], a.lngLat[1] - kk[1]) - Math.hypot(b.lngLat[0] - kk[0], b.lngLat[1] - kk[1]))[0];
  if (main) {
    // "Normal" = typical (median) flow over the period; the rise is measured from there.
    const sorted = [...main.dailyM3s].sort((a, b) => a - b);
    qMin = sorted[Math.floor(sorted.length / 2)];
    qMax = sorted[sorted.length - 1];
    dischargeAt = (h) => dailyInterp(d.discharge.start, main.dailyM3s, h);
  }
}

const clampH = (h: number) => Math.max(0, Math.min(REPLAY_HOURS, h));

/** Basin-average rainfall rate (mm/day) at hour h. */
export const rainMmDay = (h: number) => rainMmPerDay(clampH(h));
/** Rain intensity 0..1 (relative to the wettest day of the window). */
export const rainIntensity = (h: number) => Math.min(1, rainMmDay(h) / maxDailyMm);
/** Rain fallen since the replay started (mm), basin average. */
export function rainAccumulatedMm(h: number) {
  const x = clampH(h);
  const i = Math.floor(x);
  return i >= REPLAY_HOURS ? rainCumMm[REPLAY_HOURS] : rainCumMm[i] + (rainCumMm[i + 1] - rainCumMm[i]) * (x - i);
}
/** Accumulated rain 0..1 over the window (for shading). */
export const rainAccumulated = (h: number) => rainAccumulatedMm(h) / Math.max(1, rainCumMm[REPLAY_HOURS]);
/** Fraction of the window's total rain that `mm` represents (to compare thresholds in mm). */
export const rainFractionForMm = (mm: number) => mm / Math.max(1, rainCumMm[REPLAY_HOURS]);

/** River discharge (m³/s) on the main channel at hour h — real GloFAS. */
export const dischargeM3s = (h: number) => dischargeAt(clampH(h));

/** Main-river rise above normal (m), "likely": approximate rating curve on real discharge. */
export function stageM(h: number): number {
  const q = dischargeM3s(h);
  const f = Math.max(0, (q - qMin) / Math.max(1, qMax - qMin));
  return PEAK_STAGE_M * f;
}

/** Replay hour of the highest river rise (from the real discharge peak). */
export function peakHour(): number {
  let best = 0;
  for (let h = 0; h <= REPLAY_HOURS; h += 1) if (stageM(h) > stageM(best)) best = h;
  return best;
}

/** "Worst case" rise (m): uncertainty band on the same discharge. */
export function worstStageM(h: number): number {
  return stageM(h) * 1.25 + 1.5 * Math.min(1, stageM(h) / 4);
}

export function replayDate(h: number): Date {
  return new Date(REPLAY_START_MS + h * 3600_000);
}

/** First replay hour at which a point with the given depth function gets WET_THRESHOLD_M of water, or null. */
export function firstWetHour(depthForStage: (stage: number) => number, worst = false): number | null {
  for (let h = 0; h <= REPLAY_HOURS; h += 1) {
    if (depthForStage(worst ? worstStageM(h) : stageM(h)) > WET_THRESHOLD_M) return h;
  }
  return null;
}
