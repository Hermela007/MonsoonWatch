import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { EvacuationRoute } from '@monsoonwatch/shared';
import { withRouteCheckpoints } from '../src/ui/routeCheckpoints';

const fixture = () => JSON.parse(readFileSync(new URL('../../../packages/shared/fixtures/evacuation-route.ok.json', import.meta.url), 'utf8')) as EvacuationRoute;

test('progress checkpoints follow real vertices and preserve distance, destination and maneuvers', () => {
  const route = fixture();
  route.distanceM = 670;
  route.geometry = { type: 'LineString', coordinates: Array.from({length: 15}, (_,i) => [102.2, 5.53 + i * .00043]) };
  route.steps = [
    { instruction: 'Drive north on Jalan Taman KTMB', roadName: 'Jalan Taman KTMB', distanceM: 190, startIndex: 0, endIndex: 4 },
    { instruction: 'Turn right onto the secondary road', roadName: null, distanceM: 480, startIndex: 4, endIndex: 14 },
    { instruction: 'Arrive at the centre', roadName: null, distanceM: 0, startIndex: 14, endIndex: 14 },
  ];
  const result = withRouteCheckpoints(route);
  assert.ok(result.steps.length >= 6);
  assert.equal(result.geometry, route.geometry);
  assert.equal(result.centre, route.centre);
  assert.equal(result.distanceM, 670);
  assert.equal(result.steps.reduce((sum, s) => sum + s.distanceM, 0), 670);
  assert.ok(result.steps.some(s => s.instruction === route.steps[1].instruction));
  assert.ok(result.steps.filter(s => s.instruction.startsWith('Continue')).every(s => !/turn/i.test(s.instruction)));
  for (let i=1; i<result.steps.length; i++) assert.equal(result.steps[i].startIndex, result.steps[i-1].endIndex);
  assert.equal(route.steps.length, 3, 'the API response is unchanged');
});

test('short and unavailable routes do not acquire arbitrary waypoints', () => {
  const route = fixture();
  route.geometry = { type: 'LineString', coordinates: [[102.2,5.53],[102.2001,5.5301]] };
  route.steps = [{ instruction:'Drive ahead', roadName:null, distanceM:15, startIndex:0,endIndex:1 }];
  assert.equal(withRouteCheckpoints(route).steps.length, 1);
  route.status = 'no_route'; route.geometry = null;
  assert.equal(withRouteCheckpoints(route), route);
});
