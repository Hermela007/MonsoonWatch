import type { EvacCentre, SearchResponse, Village } from '@monsoonwatch/shared';
import type { Town } from '../geo/region';

/** GET /api/... as JSON. Returns null when the API is down or slow, so callers fall back to local data. */
async function getJson<T>(path: string, timeoutMs = 2500): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, { signal: ctl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface Place extends Town {
  kind?: 'village' | 'evac_centre' | 'station' | 'town';
}

export async function fetchVillages(regionId: string): Promise<Place[] | null> {
  const v = await getJson<Village[]>(`/regions/${regionId}/villages`);
  return v && v.length ? v.map((x) => ({ name: x.name, lngLat: x.location.coordinates, kind: 'village' })) : null;
}

export async function fetchEvacCentres(regionId: string): Promise<EvacCentre[] | null> {
  const c = await getJson<EvacCentre[]>(`/regions/${regionId}/evac-centres`);
  return c && c.length ? c : null;
}

/** Atlas Search place lookup (fuzzy, Malay spellings). */
export async function searchPlaces(q: string): Promise<Place[]> {
  const r = await getJson<SearchResponse>(`/search?type=place&q=${encodeURIComponent(q)}`, 1500);
  if (!r) return [];
  return r.hits
    .filter((h) => h.lngLat && (h.kind === 'village' || h.kind === 'evac_centre' || h.kind === 'station'))
    .map((h) => ({ name: h.title, lngLat: h.lngLat!, kind: h.kind as Place['kind'] }));
}
