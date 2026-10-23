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
      return [{ x: cu * ca + cv * sa, z: -cu * sa + cv * ca, w, d, angle, storeys: levels >= 2 ? 2 : 1, source: 'osm' as const }];
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
 * Illustrative kampung-style houses along a few streets, used where OSM has no buildings.
 * Always places a house at the origin (the resident's home).
 */
export function illustrativeHouses(seed: number, existing: House[], radiusM = 320): House[] {
  const rand = rng(seed);
  const base = rand() * Math.PI;
  const out: House[] = [];
  const clear = (x: number, z: number, r: number) =>
    [...existing, ...out].every((h) => Math.hypot(h.x - x, h.z - z) > r + Math.max(h.w, h.d) / 2);
  const add = (x: number, z: number, angle: number) => {
    const w = 9 + rand() * 6;
    const d = 7 + rand() * 3;
    if (Math.hypot(x, z) > radiusM || !clear(x, z, Math.max(w, d) / 2 + 3)) return;
    out.push({ x, z, w, d, angle, storeys: rand() < 0.2 ? 2 : 1, source: 'illustrative' });
  };
  if (!existing.some((h) => Math.hypot(h.x, h.z) < 15)) add(0, 0, base);
  const ca = Math.cos(base);
  const sa = Math.sin(base);
  for (let street = -4; street <= 4; street++) {
    const off = street * 48 + (rand() - 0.5) * 6;
    for (let s = -radiusM; s <= radiusM; s += 17 + rand() * 9) {
      if (rand() < 0.18) continue; // gaps: gardens, plots
      for (const side of [-1, 1]) {
        const v = off + side * (11 + rand() * 4);
        const u = s + (rand() - 0.5) * 4;
        add(u * ca + v * sa, -u * sa + v * ca, base + (rand() - 0.5) * 0.25);
      }
    }
  }
  return out;
}
