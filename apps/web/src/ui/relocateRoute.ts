import type { EvacuationRoute } from '@monsoonwatch/shared';
import type { LngLat } from '../geo/region';

/**
 * Move a sample route so it starts at `home` (demo only: the shared fixtures are TEST DATA near Manik
 * Urai). Every coordinate shifts by the same offset, so the shape, distances and steps stay as given.
 */
export function relocateRoute(r: EvacuationRoute, home: LngLat): EvacuationRoute {
  const from = r.origin.snapped ?? r.origin.requested;
  const dx = home[0] - from[0];
  const dy = home[1] - from[1];
  const mv = (ll: [number, number]): [number, number] => [ll[0] + dx, ll[1] + dy];
  return {
    ...r,
    origin: { ...r.origin, requested: home, snapped: r.origin.snapped ? mv(r.origin.snapped) : null },
    centre: r.centre ? { ...r.centre, lngLat: mv(r.centre.lngLat) } : null,
    geometry: r.geometry ? { ...r.geometry, coordinates: r.geometry.coordinates.map(mv) } : null,
  };
}
