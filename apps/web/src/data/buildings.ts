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

const OVERPASS = 'https://overpass-api.de/api/interpreter';

/** Local metres ↔ lon/lat around an origin. */
export function localFrame([lon0, lat0]: LngLat) {
  const mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const mPerLat = 110570;
  return {
    toLocal: ([lon, lat]: LngLat) => ({ x: (lon - lon0) * mPerLon, z: -(lat - lat0) * mPerLat }),
    toLngLat: (x: number, z: number): LngLat => [lon0 + x / mPerLon, lat0 - z / mPerLat],
  };
}

/**
 * OSM building footprints within `radiusM`. Live Overpass query for tonight;
 * Workstream C's GET /regions/:id/geo (cached in MongoDB) should replace it.
 */
export async function fetchOsmHouses(home: LngLat, radiusM = 500, timeoutMs = 8000): Promise<House[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const q = `[out:json][timeout:${Math.ceil(timeoutMs / 1000)}];way["building"](around:${radiusM},${home[1]},${home[0]});out geom 400;`;
    const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }), signal: ctl.signal });
    if (!res.ok) return [];
    const json = (await res.json()) as { elements: { type: string; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string> }[] };
    const { toLocal } = localFrame(home);
    return json.elements.flatMap((el) => {
      const g = el.geometry;
      if (el.type !== 'way' || !g || g.length < 4) return [];
      const pts = g.map((p) => toLocal([p.lon, p.lat]));
      // Orientation from the longest edge; extent by projecting onto it.
      let best = 0;
      let angle = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dz = pts[i].z - pts[i - 1].z;
        const len = Math.hypot(dx, dz);
        if (len > best) {
          best = len;
          angle = Math.atan2(-dz, dx);
        }
      }
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of pts) {
        const u = p.x * ca - p.z * sa;
        const v = p.x * sa + p.z * ca;
        minU = Math.min(minU, u); maxU = Math.max(maxU, u);
        minV = Math.min(minV, v); maxV = Math.max(maxV, v);
      }
      const w = maxU - minU;
      const d = maxV - minV;
      if (w < 3 || d < 3 || w > 80) return [];
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      const levels = Number(el.tags?.['building:levels']);
      return [
        {
          x: cu * ca + cv * sa,
          z: -cu * sa + cv * ca,
          w,
          d,
          angle,
          storeys: levels >= 2 ? 2 : 1,
          source: 'osm' as const,
          kind: (w > 22 ? 'terrace' : 'modern') as House['kind'],
          units: w > 22 ? Math.max(2, Math.round(w / 6.5)) : undefined,
        },
      ];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** Deterministic PRNG so the same home always gets the same street. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Illustrative town neighbourhood where OSM has no buildings: a street grid with rows of
 * single-storey terrace houses and detached bungalows on walled plots — an ordinary Malaysian
 * taman. Always places a house at the origin (the resident's home).
 */
export function illustrativeTown(seed: number, existing: House[], radiusM = 360): { houses: House[]; lanes: Lane[] } {
  const rand = rng(seed);
  const out: House[] = [];
  const lanes: Lane[] = [];
  const angle = rand() * Math.PI;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  // Grid frame: u along the streets, v across. Origin sits in the middle of a plot.
  const toXZ = (u: number, v: number) => ({ x: u * ca + v * sa, z: -u * sa + v * ca });
  const BLOCK_V = 62; // road to road across the block (two back-to-back plot rows)
  const ROAD = 9;
  const v0 = -(ROAD / 2 + 14); // origin = centre of a plot on the +v side of road 0
  const clear = (x: number, z: number, r: number) =>
    [...existing, ...out].every((h) => Math.hypot(h.x - x, h.z - z) > r + Math.max(h.w, h.d) * 0.5);

  // Streets along u, and a few cross streets along v.
  for (let k = -6; k <= 6; k++) {
    const v = v0 + k * BLOCK_V;
    lanes.push([toXZ(-radiusM - 30, v), toXZ(radiusM + 30, v)]);
  }
  const crossEvery = 150;
  const crossOff = rand() * crossEvery;
  for (let k = -5; k <= 5; k++) {
    const u = crossOff + k * crossEvery;
    lanes.push([toXZ(u, -radiusM - 30), toXZ(u, radiusM + 30)]);
  }
  const nearCross = (u: number, half: number) => {
    const m = ((u - crossOff) % crossEvery + crossEvery) % crossEvery;
    return m < half + ROAD / 2 + 2 || m > crossEvery - half - ROAD / 2 - 2;
  };

  // Home: a bungalow facing road 0.
  out.push({ x: 0, z: 0, w: 13, d: 9.5, angle: angle + Math.PI, storeys: 1, source: 'illustrative', kind: 'modern' });

  for (let k = -7; k <= 7; k++) {
    const roadV = v0 + k * BLOCK_V;
    for (const side of [-1, 1]) {
      // Each side of each street is either terrace rows or bungalows, decided per stretch.
      let u = -radiusM - rand() * 20;
      while (u < radiusM) {
        const terrace = rand() < 0.45;
        if (terrace) {
          const units = 4 + Math.floor(rand() * 5);
          const w = units * 6.5;
          const uc = u + w / 2;
          const vc = roadV + side * (ROAD / 2 + 4 + 6);
          const { x, z } = toXZ(uc, vc);
          if (!nearCross(uc, w / 2) && Math.hypot(x, z) < radiusM && clear(x, z, 4)) {
            out.push({ x, z, w, d: 12, angle: side > 0 ? angle + Math.PI : angle, storeys: 1, source: 'illustrative', kind: 'terrace', units });
          }
          u += w + 4;
        } else {
          const w = 12 + rand() * 3;
          const uc = u + 9;
          const vc = roadV + side * (ROAD / 2 + 6 + 5);
          const { x, z } = toXZ(uc, vc);
          if (!nearCross(uc, 9) && Math.hypot(x, z) < radiusM && clear(x, z, 3)) {
            out.push({ x, z, w, d: 9 + rand() * 1.5, angle: side > 0 ? angle + Math.PI : angle, storeys: 1, source: 'illustrative', kind: 'modern' });
          }
          u += 19;
        }
      }
    }
  }
  return { houses: out, lanes };
}
