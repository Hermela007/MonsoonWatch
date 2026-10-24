import type { Heightmap } from './heightmap';
import { CellHeap, depthAt, type Hydrology } from './hydrology';
import { isSafeGround } from './homeRisk';
import { worstStageM, REPLAY_HOURS } from '../data/replay2014';

export interface SafeRoute {
  /** Cells from home to safe ground. Length 1 if home is already safe. */
  cells: number[];
  distanceKm: number;
  /** Name of the evacuation centre reached, when centres were supplied. */
  targetName?: string;
}

/**
 * Pure: cheapest walk from `home` to the nearest safe ground (Dijkstra on the grid).
 * Penalises steep ground, worst-case flooded cells and landslide runouts.
 * No road network yet — this is "which way is higher ground", not turn-by-turn directions.
 */
export function routeToSafeGround(
  hm: Heightmap,
  hy: Hydrology,
  home: number,
  avoid: Uint8Array,
  maxKm = 25,
  /** If given, only these cells (evacuation centres) count as destinations. */
  named?: Map<number, string>,
): SafeRoute | null {
  const { cols, rows } = hm;
  const n = cols * rows;
  const cost = new Float32Array(n).fill(Infinity);
  const seq = new Uint32Array(n);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new CellHeap(n, cost, seq);
  const worstPeak = worstStageM(REPLAY_HOURS);
  let counter = 0;
  cost[home] = 0;
  heap.push(home);

  const isTarget = named
    ? (i: number) => named.has(i) && !avoid[i] && depthAt(hm, hy, i, worstPeak) < 0
    : (i: number) => !avoid[i] && isSafeGround(hm, hy, i);
  let target = -1;
  while (heap.length) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (isTarget(cur)) {
      target = cur;
      break;
    }
    if (cost[cur] > maxKm * 1000 * 4) break;
    const r = (cur / cols) | 0;
    const c = cur - r * cols;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        const nb = rr * cols + cc;
        if (done[nb] || hy.seaMask[nb]) continue;
        const dist = Math.hypot(dc * hm.cellXM, dr * hm.cellYM);
        let f = 1 + Math.max(0, hy.slopeDeg[nb] - 10) / 6;
        if (depthAt(hm, hy, nb, worstPeak) > 0) f *= 6;
        if (avoid[nb]) f *= 20;
        const nc = cost[cur] + dist * f;
        if (nc < cost[nb]) {
          cost[nb] = nc;
          prev[nb] = cur;
          seq[nb] = counter++;
          heap.push(nb);
        }
      }
    }
  }
  if (target < 0) return null;
  const cells: number[] = [];
  for (let i = target; i >= 0; i = prev[i]) cells.push(i);
  cells.reverse();
  let distanceM = 0;
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1];
    const b = cells[k];
    const ra = Math.floor(a / cols);
    const rb = Math.floor(b / cols);
    distanceM += Math.hypot((a - ra * cols - (b - rb * cols)) * hm.cellXM, (ra - rb) * hm.cellYM);
  }
  return { cells, distanceKm: distanceM / 1000, targetName: named?.get(target) };
}
