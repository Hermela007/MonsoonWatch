import type { Heightmap } from './heightmap';

/** Drain elevation for cells that leave the grid without reaching a mapped river: never flooded. */
export const NO_DRAIN_M = -9999;

export interface Hydrology {
  /** Depression-filled elevation: the HAND reference surface (DEM pits are mostly artefacts at 150 m). */
  filledM: Float32Array;
  /** Upstream cell count (incl. self). */
  accCells: Float32Array;
  riverMask: Uint8Array;
  /** 0..1 river size for drawing; 0 off-river. */
  riverStrength: Float32Array;
  /** Elevation of the river cell each cell drains to (HAND reference). */
  drainElevM: Float32Array;
  /** How much of the river stage rise reaches this cell's drainage (0..1). */
  stageScale: Float32Array;
  slopeDeg: Float32Array;
  seaMask: Uint8Array;
  cellAreaKm2: number;
}

/** Binary min-heap of cell indices keyed by (elevation, insertion order). */
class CellHeap {
  private idx: Int32Array;
  private size = 0;
  constructor(
    capacity: number,
    private key: Float32Array,
    private seq: Uint32Array,
  ) {
    this.idx = new Int32Array(capacity);
  }
  get length() {
    return this.size;
  }
  private less(a: number, b: number) {
    const ka = this.key[a];
    const kb = this.key[b];
    return ka < kb || (ka === kb && this.seq[a] < this.seq[b]);
  }
  push(cell: number) {
    let i = this.size++;
    const h = this.idx;
    h[i] = cell;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }
  pop(): number {
    const h = this.idx;
    const top = h[0];
    h[0] = h[--this.size];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.size && this.less(h[l], h[m])) m = l;
      if (r < this.size && this.less(h[r], h[m])) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
    return top;
  }
}

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Pure terrain analysis for the flood approximation:
 * priority-flood (Barnes et al. 2014) gives a drainage tree and a topological order,
 * then flow accumulation → river cells → HAND (height above nearest drainage).
 */
export function analyseHydrology(hm: Heightmap, riverThresholdKm2: number): Hydrology {
  const { cols, rows, elevM } = hm;
  const n = cols * rows;
  const cellAreaKm2 = (hm.cellXM * hm.cellYM) / 1e6;

  const filled = new Float32Array(n);
  const seq = new Uint32Array(n);
  const visited = new Uint8Array(n);
  const down = new Int32Array(n).fill(-1);
  const order = new Int32Array(n);
  const seaMask = new Uint8Array(n);
  const heap = new CellHeap(n, filled, seq);
  let counter = 0;

  const seed = (i: number) => {
    visited[i] = 1;
    filled[i] = elevM[i];
    seq[i] = counter++;
    heap.push(i);
  };
  for (let i = 0; i < n; i++) {
    const r = (i / cols) | 0;
    const c = i - r * cols;
    if (elevM[i] <= 0) seaMask[i] = 1;
    if (seaMask[i] || r === 0 || c === 0 || r === rows - 1 || c === cols - 1) seed(i);
  }

  let k = 0;
  while (heap.length) {
    const cur = heap.pop();
    order[k++] = cur;
    const r = (cur / cols) | 0;
    const c = cur - r * cols;
    for (let dr = -1; dr <= 1; dr++) {
      const rr = r + dr;
      if (rr < 0 || rr >= rows) continue;
      for (let dc = -1; dc <= 1; dc++) {
        const cc = c + dc;
        if ((dr === 0 && dc === 0) || cc < 0 || cc >= cols) continue;
        const nb = rr * cols + cc;
        if (visited[nb]) continue;
        visited[nb] = 1;
        filled[nb] = Math.max(elevM[nb], filled[cur]);
        down[nb] = cur;
        seq[nb] = counter++;
        heap.push(nb);
      }
    }
  }

  // Upstream first (reverse pop order) → accumulation.
  const accCells = new Float32Array(n).fill(1);
  for (let j = n - 1; j >= 0; j--) {
    const i = order[j];
    if (down[i] >= 0) accCells[down[i]] += accCells[i];
  }

  const threshold = riverThresholdKm2 / cellAreaKm2;
  const riverMask = new Uint8Array(n);
  let maxAcc = threshold;
  for (let i = 0; i < n; i++) {
    if (!seaMask[i] && accCells[i] >= threshold) {
      riverMask[i] = 1;
      if (accCells[i] > maxAcc) maxAcc = accCells[i];
    }
  }
  const logT = Math.log(threshold);
  const logSpan = Math.max(1e-6, Math.log(maxAcc) - logT);
  const riverStrength = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (riverMask[i]) riverStrength[i] = 0.3 + 0.7 * smooth01((Math.log(accCells[i]) - logT) / logSpan);
  }

  // Downstream first (pop order) → each cell inherits its drainage reference.
  const drainElevM = new Float32Array(n);
  const drainAcc = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const i = order[j];
    if (seaMask[i]) {
      drainElevM[i] = 0;
      drainAcc[i] = 0;
    } else if (riverMask[i]) {
      drainElevM[i] = filled[i];
      drainAcc[i] = accCells[i];
    } else if (down[i] < 0) {
      drainElevM[i] = NO_DRAIN_M;
      drainAcc[i] = 0;
    } else {
      drainElevM[i] = drainElevM[down[i]];
      drainAcc[i] = drainAcc[down[i]];
    }
  }

  // Bigger rivers rise more; the rise tapers towards the sea (tidal outlet).
  const stageScale = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (drainAcc[i] <= 0) continue;
    const size = 0.35 + 0.65 * smooth01((Math.log(drainAcc[i]) - logT) / logSpan);
    const coast = 0.5 + 0.5 * smooth01(drainElevM[i] / 10);
    stageScale[i] = size * coast;
  }

  const slopeDeg = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    const r0 = Math.max(0, r - 1);
    const r1 = Math.min(rows - 1, r + 1);
    for (let c = 0; c < cols; c++) {
      const c0 = Math.max(0, c - 1);
      const c1 = Math.min(cols - 1, c + 1);
      const dzdx = (elevM[r * cols + c1] - elevM[r * cols + c0]) / ((c1 - c0) * hm.cellXM);
      const dzdy = (elevM[r1 * cols + c] - elevM[r0 * cols + c]) / ((r1 - r0) * hm.cellYM);
      slopeDeg[r * cols + c] = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
    }
  }

  return { filledM: filled, accCells, riverMask, riverStrength, drainElevM, stageScale, slopeDeg, seaMask, cellAreaKm2 };
}

/** Water depth (m) at a cell for a given main-river stage rise. Mirrors the valley shader. */
export function depthAt(_hm: Heightmap, hy: Hydrology, i: number, stageM: number): number {
  return hy.drainElevM[i] + stageM * hy.stageScale[i] - hy.filledM[i];
}

/** Landslide screening score 0..1 (slope × accumulated rain). Mirrors the valley shader. */
export function landslideRisk(slopeDeg: number, elevM: number, rainAcc: number): number {
  if (elevM < 40) return 0;
  const s = Math.min(1, Math.max(0, (slopeDeg - 18) / 17));
  const r = Math.min(1, Math.max(0, (rainAcc - 0.15) / 0.75));
  return s * s * (3 - 2 * s) * (r * r * (3 - 2 * r));
}
