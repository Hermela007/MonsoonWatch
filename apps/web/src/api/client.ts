import type { Alert, AgentRunDetail, AgentRunStarted, EvacCentre, SearchResponse, StationWithLatest, Village } from '@monsoonwatch/shared';
import type { Town } from '../geo/region';

let apiLive = false;
/** REST data requests are enabled while the live event stream is connected. */
export const setApiLive = (v: boolean) => (apiLive = v);

/** GET /api/... as JSON. Returns null when the API is down or slow, so callers fall back to local data. */
export async function getJson<T>(path: string, timeoutMs = 2500): Promise<T | null> {
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
export const runAgent = (regionId: string, opts: { mode?: 'live' | 'replay'; at?: string } = {}) =>
  postJson<AgentRunStarted>('/agent/run', { regionId, ...opts }, 30000);
export const fetchAgentRun = (id: string) => getJson<AgentRunDetail>(`/agent/runs/${encodeURIComponent(id)}`, 6000);

// C's replay status is kept local to the web client; shared contracts are unchanged.
export interface ReplayStatus {
  running: boolean;
  regionId?: string;
  ts?: string;
  from?: string;
  secondsPerDay?: number;
}
export const fetchReplayStatus = () => getJson<ReplayStatus>('/replay/status');
export const startReplay = (regionId: string) => postJson<ReplayStatus>('/replay/start', { regionId, from: '2014-12-18', secondsPerDay: 30 }, 30000);
export const stopReplay = () => postJson<ReplayStatus>('/replay/stop', {});
/** POST /alerts/:id/approve | reject (Workstream B). Human-in-the-loop: nothing is sent without this. */
export const decideAlert = (id: string, decision: 'approve' | 'reject', by: string) =>
  postJson<Alert>(`/alerts/${encodeURIComponent(id)}/${decision}`, decision === 'approve' ? { approvedBy: by } : { rejectedBy: by });

/** Live JPS stations with their latest reading (C's API). */
export const fetchStations = (regionId: string) => getJson<StationWithLatest[]>(`/regions/${regionId}/stations`, 6000);
