import type { EvacuationRoute } from '@monsoonwatch/shared';

/** Break long instructions into selectable progress checkpoints on the existing road geometry. */
export function withRouteCheckpoints(route: EvacuationRoute): EvacuationRoute {
  if (route.status !== 'ok' || !route.geometry || route.geometry.coordinates.length < 2) return route;
  const coordinates = route.geometry.coordinates;
  const cumulative = [0];
  for (let i = 1; i < coordinates.length; i++) {
    const [x, y] = coordinates[i - 1], [nx, ny] = coordinates[i];
    const metres = Math.hypot((nx - x) * 111320 * Math.cos((y + ny) * Math.PI / 360), (ny - y) * 110570);
    cumulative.push(cumulative[i - 1] + metres);
  }
  const spacing = Math.max(100, (route.distanceM ?? cumulative.at(-1)!) / 14);
  const steps: EvacuationRoute['steps'] = [];
  for (const step of route.steps) {
    const start = step.startIndex, end = step.endIndex;
    const length = cumulative[end] - cumulative[start];
    if (step.distanceM <= 0 || length < spacing * 1.5) { steps.push(step); continue; }
    const cuts = [start];
    for (let i = start + 1; i < end; i++) {
      if (cumulative[i] - cumulative[cuts.at(-1)!] >= spacing * .8 && cumulative[end] - cumulative[i] >= spacing * .5) cuts.push(i);
    }
    cuts.push(end);
    let allocated = 0;
    for (let i = 0; i < cuts.length - 1; i++) {
      const distanceM = i === cuts.length - 2 ? step.distanceM - allocated : Math.round(step.distanceM * (cumulative[cuts[i + 1]] - cumulative[cuts[i]]) / length);
      allocated += distanceM;
      steps.push({ ...step, startIndex: cuts[i], endIndex: cuts[i + 1], distanceM,
        instruction: i === 0 ? step.instruction : `Continue along ${step.roadName ?? 'this road'}` });
    }
  }
  return { ...route, steps };
}
