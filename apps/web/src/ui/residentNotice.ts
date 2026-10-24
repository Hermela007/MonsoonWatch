import type { Alert, AreaWarning, LngLat } from '@monsoonwatch/shared';

/** District membership is explicit; never substitute a neighbouring district's recording. */
export function residentNotice(alerts: Alert[], warnings: AreaWarning[], villageId: string | undefined, place: string, origin: LngLat, distance: (a: LngLat, b: LngLat) => number): Alert | AreaWarning | null {
  const approved = (a: Alert | AreaWarning) => a.status === 'approved' || a.status === 'sent';
  const latest = <T extends Alert | AreaWarning>(items: T[]) => items.sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''))[0] ?? null;
  const individual = latest(alerts.filter(a => approved(a) && (a.villageId === villageId || a.villageId === place || (!villageId && a.route.coordinates.length > 0 && distance(a.route.coordinates[0], origin) < 3))));
  if (individual) return individual;
  return latest(warnings.filter(w => approved(w) && w.villageIds.includes(villageId ?? place)));
}
