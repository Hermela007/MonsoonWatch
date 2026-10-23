import type { BBox, LngLat } from '../geo/region';

/** Regular lon/lat grid; row 0 is the northern edge. */
export interface Heightmap {
  cols: number;
  rows: number;
  bbox: BBox;
  elevM: Float32Array;
  cellXM: number;
  cellYM: number;
}

export function cellLngLat(hm: Heightmap, col: number, row: number): LngLat {
  const [minLon, minLat, maxLon, maxLat] = hm.bbox;
  return [
    minLon + (col / (hm.cols - 1)) * (maxLon - minLon),
    maxLat - (row / (hm.rows - 1)) * (maxLat - minLat),
  ];
}

/** Fractional grid coordinates for a lon/lat (may be outside the grid). */
export function gridCoords(hm: Heightmap, [lon, lat]: LngLat): { gx: number; gy: number } {
  const [minLon, minLat, maxLon, maxLat] = hm.bbox;
  return {
    gx: ((lon - minLon) / (maxLon - minLon)) * (hm.cols - 1),
    gy: ((maxLat - lat) / (maxLat - minLat)) * (hm.rows - 1),
  };
}

export function nearestCell(hm: Heightmap, lngLat: LngLat): number | null {
  const { gx, gy } = gridCoords(hm, lngLat);
  const c = Math.round(gx);
  const r = Math.round(gy);
  if (c < 0 || r < 0 || c >= hm.cols || r >= hm.rows) return null;
  return r * hm.cols + c;
}

/** Bilinear sample of any per-cell field. Returns NaN outside the grid. */
export function sampleField(hm: Heightmap, field: ArrayLike<number>, gx: number, gy: number): number {
  if (gx < 0 || gy < 0 || gx > hm.cols - 1 || gy > hm.rows - 1) return NaN;
  const c0 = Math.min(Math.floor(gx), hm.cols - 2);
  const r0 = Math.min(Math.floor(gy), hm.rows - 2);
  const fx = gx - c0;
  const fy = gy - r0;
  const i = r0 * hm.cols + c0;
  const a = field[i];
  const b = field[i + 1];
  const c = field[i + hm.cols];
  const d = field[i + hm.cols + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}
