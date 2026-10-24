import { EvacuationRouteSchema, type EvacuationRoute, type TravelMode } from '@monsoonwatch/shared';
import type { LngLat } from '../geo/region';
import { getJson } from './client';

export interface RouteQuery {
  lngLat: LngLat;
  travel: TravelMode;
  mode: 'live' | 'replay';
  /** Scenario time (ISO). */
  ts: string;
  centreId?: string | null;
  people?: number;
}

export type RouteResult =
  | { kind: 'route'; route: EvacuationRoute }
  /** Endpoint not available (not deployed yet, API down or slow): callers keep their own estimate. */
  | { kind: 'unavailable' }
  /** The response didn't match the shared contract. */
  | { kind: 'invalid'; error: string };

/** Validate a response against the shared contract (also used for the bundled sample responses). */
export function parseEvacuationRoute(json: unknown): RouteResult {
  const parsed = EvacuationRouteSchema.safeParse(json);
  return parsed.success ? { kind: 'route', route: parsed.data } : { kind: 'invalid', error: parsed.error.message };
}

/** GET /api/regions/:id/evacuation-route — a road journey to a centre with space (B's routing, C's hazards). */
export async function fetchEvacuationRoute(regionId: string, q: RouteQuery): Promise<RouteResult> {
  const params = new URLSearchParams({
    lng: String(q.lngLat[0]),
    lat: String(q.lngLat[1]),
    travel: q.travel,
    mode: q.mode,
    ts: q.ts,
    people: String(q.people ?? 1),
  });
  if (q.centreId) params.set('centreId', q.centreId);
  const json = await getJson<unknown>(`/regions/${encodeURIComponent(regionId)}/evacuation-route?${params}`, 20000);
  if (json === null) return { kind: 'unavailable' };
  return parseEvacuationRoute(json);
}
