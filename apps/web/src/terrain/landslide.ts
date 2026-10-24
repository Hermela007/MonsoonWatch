import type { Heightmap } from './heightmap';
import type { Hydrology } from './hydrology';
import { rainFractionForMm } from '../data/replay2014';

export interface SlideSource {
  cell: number;
  slopeDeg: number;
  elevM: number;
  /** Accumulated rain (0..1 of the event) at which this slope is flagged. Steeper → earlier. */
  triggerRainAcc: number;
  /** Steepest-descent runout, source first. */
  path: number[];
  lengthKm: number;
  reachesRiver: boolean;
}

/**
 * Screening threshold (mm of basin-average rain accumulated since 15 Dec) at which a slope fails.
 * Steeper slopes need less rain: ≥38° ≈ 190 mm (≈20 Dec 2014), 30° ≈ 270 mm (≈22 Dec),
 * gentler ≈ 310 mm (≈23 Dec) — i.e. during the real heavy-rain days, before the 24 Dec river peak.
 * Illustrative values applied to REAL 2014 rainfall.
 */
export function triggerRainMm(slopeDeg: number): number {
  return Math.min(310, Math.max(180, 330 - (slopeDeg - 24) * 10));
}

/** The same threshold as a fraction of the replay window's total rain. */
export function triggerRainAcc(slopeDeg: number): number {
  return rainFractionForMm(triggerRainMm(slopeDeg));
}

/** Steepest descent from `start` until the slope flattens, a river is reached, or it pits. */
export function runoutPath(hm: Heightmap, hy: Hydrology, start: number, maxSteps = 200) {
  const { cols, rows, elevM } = hm;
  const path = [start];
  let i = start;
  let lengthM = 0;
  let reachesRiver = false;
  for (let s = 0; s < maxSteps; s++) {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    let best = -1;
    let bestDrop = 0;
    let bestDist = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const nb = rr * cols + cc;
        const dist = Math.hypot(dc * hm.cellXM, dr * hm.cellYM);
        const drop = (elevM[i] - elevM[nb]) / dist;
        if (drop > bestDrop) {
          bestDrop = drop;
          best = nb;
          bestDist = dist;
        }
      }
    }
    if (best < 0) break;
    lengthM += bestDist;
    i = best;
    path.push(i);
    if (hy.riverMask[i]) {
      reachesRiver = true;
      break;
    }
    const slopeDeg = (Math.atan(bestDrop) * 180) / Math.PI;
    if (slopeDeg < 4 && lengthM > 1000) break;
  }
  return { path, lengthKm: lengthM / 1000, reachesRiver };
}

/** Pick well-spaced steep source cells and trace their runouts. */
export function findSlideSources(
  hm: Heightmap,
  hy: Hydrology,
  opts: { minSlopeDeg: number; minElevM: number; spacingKm: number; max: number; near?: { cell: number; radiusKm: number } },
): SlideSource[] {
  const { cols, rows, elevM } = hm;
  let rMin = 2, rMax = rows - 3, cMin = 2, cMax = cols - 3;
  if (opts.near) {
    const nr = Math.floor(opts.near.cell / cols);
    const nc = opts.near.cell - nr * cols;
    const dr = Math.ceil((opts.near.radiusKm * 1000) / hm.cellYM);
    const dc = Math.ceil((opts.near.radiusKm * 1000) / hm.cellXM);
    rMin = Math.max(rMin, nr - dr);
    rMax = Math.min(rMax, nr + dr);
    cMin = Math.max(cMin, nc - dc);
    cMax = Math.min(cMax, nc + dc);
  }
  const candidates: number[] = [];
  for (let r = rMin; r <= rMax; r++) {
    for (let c = cMin; c <= cMax; c++) {
      const i = r * cols + c;
      if (hy.slopeDeg[i] >= opts.minSlopeDeg && elevM[i] >= opts.minElevM) candidates.push(i);
    }
  }
  candidates.sort((a, b) => hy.slopeDeg[b] - hy.slopeDeg[a]);

  const picked: SlideSource[] = [];
  const spacing2 = (opts.spacingKm * 1000) ** 2;
  for (const i of candidates) {
    if (picked.length >= opts.max) break;
    const r = (i / cols) | 0;
    const c = i - r * cols;
    const tooClose = picked.some((p) => {
      const pr = (p.cell / cols) | 0;
      const pc = p.cell - pr * cols;
      return ((pc - c) * hm.cellXM) ** 2 + ((pr - r) * hm.cellYM) ** 2 < spacing2;
    });
    if (tooClose) continue;
    const run = runoutPath(hm, hy, i);
    if (run.path.length < 4) continue;
    picked.push({
      cell: i,
      slopeDeg: hy.slopeDeg[i],
      elevM: elevM[i],
      triggerRainAcc: triggerRainAcc(hy.slopeDeg[i]),
      ...run,
    });
  }
  return picked;
}
