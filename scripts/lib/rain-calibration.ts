// Dec 2014 replay rain calibration (scripts/data/replay-2014/rain-calibration-2014.json): ERA5 daily rain at a
// district centre scaled so its window total matches the published station mean for that district.
// A scaling to published totals — NOT observed station data. Pure functions + the file loader.
import { readFileSync } from "node:fs";

export interface RainCalibration {
  label: string;
  window: { start: string; end: string };
  sources: { id: string; url: string; used: boolean; stations?: { station: string; district: string; dailyMm: Record<string, number>; totalMm: number }[] }[];
  districts: { district: string; gridLat: number; gridLon: number; stations: string[]; publishedMeanMm: number; era5WindowMm: number; factor: number }[];
  uncalibrated: { district: string; reason: string }[];
}

export const CALIBRATION_FILE = new URL("../data/replay-2014/rain-calibration-2014.json", import.meta.url);
export const loadRainCalibration = (): RainCalibration => JSON.parse(readFileSync(CALIBRATION_FILE, "utf8"));

/** ISO dates compare as strings. */
export const inWindow = (date: string, w: { start: string; end: string }) => date >= w.start && date <= w.end;

/** Sum of a daily series over the window (null = 0). */
export function windowTotal(times: string[], mm: (number | null)[], w: { start: string; end: string }): number {
  return times.reduce((s, t, i) => s + (inWindow(t, w) ? (mm[i] ?? 0) : 0), 0);
}

/** factor = published station mean / ERA5 window total. */
export function computeFactor(stationTotalsMm: number[], era5WindowMm: number): number {
  if (stationTotalsMm.length === 0 || !(era5WindowMm > 0)) throw new Error("factor needs ≥ 1 station total and a positive ERA5 total");
  return stationTotalsMm.reduce((a, b) => a + b, 0) / stationTotalsMm.length / era5WindowMm;
}

/** Scale the days inside the window; days outside (and nulls) unchanged. Rounded to 0.1 mm. */
export function calibrateSeries(times: string[], mm: (number | null)[], factor: number, w: { start: string; end: string }): (number | null)[] {
  return mm.map((v, i) => (v === null || !inWindow(times[i]!, w) ? v : Math.round(v * factor * 10) / 10));
}

/** Day j's 6 previous daily values, oldest first (null before the series starts) — from the SAME series as
 *  `value`, so a calibrated value and its rain6d are always scaled consistently. */
export const rain6dAt = (mm: (number | null)[], j: number): (number | null)[] =>
  Array.from({ length: 6 }, (_, k) => (j - 6 + k >= 0 ? (mm[j - 6 + k] ?? null) : null));
