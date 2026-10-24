import type { Alert, AgentRunStarted, EvacCentre, SearchResponse, Village } from '@monsoonwatch/shared';
import type { Town } from '../geo/region';

let apiLive = false;
/** Set once GET /api/stream connects; until then nothing calls the API (no 502 noise when it's down). */
export const setApiLive = (v: boolean) => (apiLive = v);

/** GET /api/... as JSON. Returns null when the API is down or slow, so callers fall back to local data. */
async function getJson<T>(path: string, timeoutMs = 2500): Promise<T | null> {
  if (!apiLive) return null;
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

async function postJson<T>(path: string, body: unknown, timeoutMs = 8000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /agent/run (Workstream B). */
export const runAgent = (regionId: string) => postJson<AgentRunStarted>('/agent/run', { regionId });
/** POST /alerts/:id/approve | reject (Workstream B). Human-in-the-loop: nothing is sent without this. */
export const decideAlert = (id: string, decision: 'approve' | 'reject', by: string) =>
  postJson<Alert>(`/alerts/${encodeURIComponent(id)}/${decision}`, { by });
