import type { Hazards, LngLat } from '@monsoonwatch/shared';

// The agent's landslide SCREENING model (B, apps/api/src/agent/landslide.ts), read through
// GET /regions/:id/hazards so the resident page and the agent agree:
//   a slope ≥ 25° whose rain crosses a cited threshold (Deep Research option A) has a runout;
//   a place within 1 km of a runout is screened at that runout's level.
// Risk bands encode the level: alert 0.20–0.40 · warning 0.50–0.70 · danger 0.80–1.00.

export type ScreenLevel = 'alert' | 'warning' | 'danger';
export const SCREEN_NEAR_KM = 1.0; // same as the agent's landslide_screen events

export const levelFromRisk = (risk: number): ScreenLevel => (risk >= 0.8 ? 'danger' : risk >= 0.5 ? 'warning' : 'alert');

/** One runout across the replay: when it first appears, when it reaches warning+, its worst level. */
export interface ScreenRunout {
  key: string;
  coords: LngLat[];
  firstHour: number;
  highHour: number | null;
  maxRisk: number;
  maxLevel: ScreenLevel;
}

/** Merge hazards snapshots (in time order) into one list of runouts, matched by where they start. */
export function buildRunoutTimeline(snaps: { hour: number; landslide: Hazards['landslide'] }[]): ScreenRunout[] {
  const byKey = new Map<string, ScreenRunout>();
  for (const s of [...snaps].sort((a, b) => a.hour - b.hour)) {
    for (const r of s.landslide.runouts) {
      const start = r.coordinates[0];
      if (!start) continue;
      const key = `${start[0].toFixed(3)},${start[1].toFixed(3)}`;
      const level = levelFromRisk(r.risk);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { key, coords: r.coordinates, firstHour: s.hour, highHour: level !== 'alert' ? s.hour : null, maxRisk: r.risk, maxLevel: level });
        continue;
      }
      if (prev.highHour === null && level !== 'alert') prev.highHour = s.hour;
      if (r.risk > prev.maxRisk) {
        prev.maxRisk = r.risk;
        prev.maxLevel = level;
        prev.coords = r.coordinates;
      }
    }
  }
  return [...byKey.values()];
}

export function haversineM(a: LngLat, b: LngLat) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * toRad;
  const dLon = (b[0] - a[0]) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const distanceToRunoutM = (p: LngLat, r: ScreenRunout) => Math.min(...r.coords.map((c) => haversineM(p, c)));

/**
 * Screen one place, the way the agent screens a village: among runouts within 1 km, the highest-risk one.
 * HIGH for warning/danger, BE READY (medium) for alert, otherwise LOW — with the nearest runout for context.
 */
export function screenPlace(p: LngLat, runouts: ScreenRunout[]) {
  let hit: { r: ScreenRunout; m: number } | null = null;
  let nearest: { r: ScreenRunout; m: number } | null = null;
  for (const r of runouts) {
    const m = distanceToRunoutM(p, r);
    if (!nearest || m < nearest.m) nearest = { r, m };
    if (m <= SCREEN_NEAR_KM * 1000 && (!hit || r.maxRisk > hit.r.maxRisk)) hit = { r, m };
  }
  const level: 'high' | 'medium' | 'low' = !hit ? 'low' : hit.r.maxLevel === 'alert' ? 'medium' : 'high';
  return {
    level,
    runout: hit?.r ?? null,
    distM: hit?.m ?? nearest?.m ?? Infinity,
    /** Replay hour the slope reaches the level shown (warning+ for HIGH, first appearance for BE READY). */
    hour: hit ? (level === 'high' ? hit.r.highHour ?? hit.r.firstHour : hit.r.firstHour) : null,
    nearestDistM: nearest?.m ?? Infinity,
  };
}
