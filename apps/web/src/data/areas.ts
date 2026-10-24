import type { LngLat } from '../geo/region';

/** apps/web/public/data/areas/<slug>.json — real buildings and roads (scripts/fetch-areas.py). */
export interface AreaData {
  name: string;
  center: LngLat;
  bbox: [number, number, number, number];
  source: { buildings: string; roads: string };
  buildings: { id: string; ring: LngLat[]; height: number | null; floors: number | null; class: string | null }[];
  roads: { id: number; kind: string; name: string | null; line: LngLat[] }[];
}
export interface AreaIndexEntry {
  name: string;
  slug: string;
  center: LngLat;
  buildings: number;
  roads: number;
}

let index: AreaIndexEntry[] | null = null;
export async function loadAreaIndex(): Promise<AreaIndexEntry[]> {
  if (index) return index;
  const res = await fetch('/data/areas/index.json');
  index = res.ok ? ((await res.json()) as AreaIndexEntry[]) : [];
  return index;
}

/** The real-data area covering this point (within ~700 m of its centre), or null. */
export async function loadAreaFor(lngLat: LngLat): Promise<AreaData | null> {
  const idx = await loadAreaIndex();
  const mPerLon = 111320 * Math.cos((lngLat[1] * Math.PI) / 180);
  const best = idx
    .map((a) => ({ a, d: Math.hypot((a.center[0] - lngLat[0]) * mPerLon, (a.center[1] - lngLat[1]) * 110570) }))
    .sort((x, y) => x.d - y.d)[0];
  if (!best || best.d > 700) return null;
  const res = await fetch(`/data/areas/${best.a.slug}.json`);
  return res.ok ? ((await res.json()) as AreaData) : null;
}
