import type { LngLat } from '../geo/region';
import type { RealSeries } from './replay2014';

/** apps/web/public/data/kelantan.json — built from Workstream C's committed data. */
export interface RealData extends RealSeries {
  source: Record<string, string>;
  villages: { name: string; lngLat: LngLat; kind: 'city' | 'town' | 'village' | 'hamlet' }[];
  centres: { name: string; lngLat: LngLat; kind: string; capacityEstimate: number }[];
  rivers: { name: string; km: number; lines: LngLat[][] }[];
  peak: { m3s: number; date: string };
}

export async function loadRealData(): Promise<RealData> {
  const res = await fetch('/data/kelantan.json');
  if (!res.ok) throw new Error(`Real data missing (HTTP ${res.status}) — run node apps/web/scripts/build-real-data.mjs`);
  return (await res.json()) as RealData;
}

/** State outlines (geoBoundaries ADM1, CC BY 4.0) — used for the Kelantan boundary. */
export interface MalaysiaData {
  source: string;
  states: { name: string; polygons: LngLat[][] }[];
}

export async function loadMalaysia() {
  const res = await fetch('/data/malaysia.json');
  return res.ok ? ((await res.json()) as MalaysiaData) : null;
}
