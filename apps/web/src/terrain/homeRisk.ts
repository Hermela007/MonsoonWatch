import type { Heightmap } from './heightmap';
import { depthAt, NO_DRAIN_M, type Hydrology } from './hydrology';
import type { SlideSource } from './landslide';
import { REPLAY_HOURS, firstWetHour, rainAccumulated, stageM, worstStageM } from '../data/replay2014';

export type RiskLevel = 'high' | 'medium' | 'low';

export interface HomeRisk {
  level: RiskLevel;
  /** Replay hour the home area first gets wet ("likely"), or null. */
  floodWetHour: number | null;
  /** Same, worst case. */
  worstWetHour: number | null;
  /** Deepest likely water at the home area over the replay (m). */
  peakDepthM: number;
  /** Nearest slope whose runout passes close to home, or null. */
  slide: SlideSource | null;
  slideHour: number | null;
  /** Distance (m) from home to the nearest flagged slope's runout, or Infinity. */
  slideDistM: number;
  floodLevel: RiskLevel;
  slideLevel: RiskLevel;
}

const SLIDE_NEAR_M = 600;

/** Cells within `radius` cells of `cell` (square window). */
export function neighbourhood(hm: Heightmap, cell: number, radius: number): number[] {
  const r0 = Math.floor(cell / hm.cols);
  const c0 = cell - r0 * hm.cols;
  const out: number[] = [];
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r >= 0 && c >= 0 && r < hm.rows && c < hm.cols) out.push(r * hm.cols + c);
    }
  }
  return out;
}

const cellDistM = (hm: Heightmap, a: number, b: number) => {
  const ra = Math.floor(a / hm.cols);
  const rb = Math.floor(b / hm.cols);
  return Math.hypot((a - ra * hm.cols - (b - rb * hm.cols)) * hm.cellXM, (ra - rb) * hm.cellYM);
};

/** Pure: what this replay means for one home. */
export function assessHome(hm: Heightmap, hy: Hydrology, home: number, slides: SlideSource[]): HomeRisk {
  const area = neighbourhood(hm, home, 1).filter((i) => !hy.seaMask[i] && !hy.riverMask[i]);
  const earliest = (worst: boolean) => {
    let best: number | null = null;
    for (const i of area) {
      const h = firstWetHour((s) => depthAt(hm, hy, i, s), worst);
      if (h !== null && (best === null || h < best)) best = h;
    }
    return best;
  };
  const floodWetHour = earliest(false);
  const worstWetHour = earliest(true);
  let peakDepthM = 0;
  for (const i of area) peakDepthM = Math.max(peakDepthM, depthAt(hm, hy, i, stageM(REPLAY_HOURS)));

  let slide: SlideSource | null = null;
  let slideDist = Infinity;
  let nearest: SlideSource | null = null;
  for (const s of slides) {
    for (const c of s.path) {
      const d = cellDistM(hm, c, home);
      if (d < slideDist) {
        slideDist = d;
        nearest = s;
      }
    }
  }
  if (slideDist < SLIDE_NEAR_M) slide = nearest;
  let slideHour: number | null = null;
  if (slide) {
    for (let h = 0; h <= REPLAY_HOURS; h += 0.25) {
      if (rainAccumulated(h) >= slide.triggerRainAcc) {
        slideHour = h;
        break;
      }
    }
  }

  if (nearest && !slide) {
    for (let h = 0; h <= REPLAY_HOURS; h += 0.25) if (rainAccumulated(h) >= nearest.triggerRainAcc) { slideHour = h; break; }
  }
  const floodLevel: RiskLevel = floodWetHour !== null ? 'high' : worstWetHour !== null ? 'medium' : 'low';
  const slideLevel: RiskLevel = slideDist < SLIDE_NEAR_M ? 'high' : slideDist < 1500 ? 'medium' : 'low';
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const level: RiskLevel = rank[floodLevel] >= rank[slideLevel] ? floodLevel : slideLevel;
  return { level, floodWetHour, worstWetHour, peakDepthM, slide, slideHour, slideDistM: slideDist, floodLevel, slideLevel };
}

/** True if a cell stays dry with margin in the worst case — a candidate safe spot. */
export function isSafeGround(hm: Heightmap, hy: Hydrology, i: number, marginM = 3): boolean {
  if (hy.seaMask[i] || hy.riverMask[i] || hy.slopeDeg[i] > 12) return false;
  if (hy.drainElevM[i] === NO_DRAIN_M) return true;
  return depthAt(hm, hy, i, worstStageM(REPLAY_HOURS)) < -marginM;
}
