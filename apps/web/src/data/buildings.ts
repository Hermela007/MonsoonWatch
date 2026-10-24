import type { LngLat } from '../geo/region';

/** A building footprint in local metres around the home (x east, z south). */
export interface House {
  x: number;
  z: number;
  /** Long side (m) along `angle`. */
  w: number;
  d: number;
  /** Radians, rotation of the long side from east. */
  angle: number;
  storeys: 1 | 2;
  source: 'osm' | 'illustrative';
  /** Detached bungalow, a row of terrace houses (w = whole row), or a traditional timber house. */
  kind: 'modern' | 'terrace' | 'kampung';
  /** Terrace rows: number of units. */
  units?: number;
}

/** A street (polyline), local metres. */
export type Lane = { x: number; z: number }[];

/** Distance (m) from a point to a polyline. */
export function distToLane(lane: Lane, x: number, z: number) {
  let best = Infinity;
  for (let k = 0; k < lane.length - 1; k++) {
    const a = lane[k];
    const b = lane[k + 1];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, Math.hypot(a.x + t * dx - x, a.z + t * dz - z));
  }
  return best;
}

/** Local metres ↔ lon/lat around an origin. */
export function localFrame([lon0, lat0]: LngLat) {
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = 110570;
  return {
    toLocal: ([lon, lat]: LngLat) => ({ x: (lon - lon0) * mPerLon, z: -(lat - lat0) * mPerLat }),
    toLngLat: (x: number, z: number): LngLat => [lon0 + x / mPerLon, lat0 - z / mPerLat],
  };
}

