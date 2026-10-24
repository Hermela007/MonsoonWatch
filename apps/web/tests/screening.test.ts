import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRunoutTimeline, levelFromRisk, screenPlace } from '../src/terrain/screening';

// Same rule as the agent's landslide_screen (apps/api/src/agent/landslide.ts): within 1 km of a runout.
const runout = (risk: number, start: [number, number]) => ({ type: 'LineString' as const, risk, coordinates: [start, [start[0] + 0.01, start[1] - 0.01] as [number, number]] });

test('risk bands map to the agent levels', () => {
  assert.equal(levelFromRisk(0.3), 'alert');
  assert.equal(levelFromRisk(0.6), 'warning');
  assert.equal(levelFromRisk(0.9), 'danger');
});

test('a runout is tracked over time: first seen, first at warning+, worst level', () => {
  const r = buildRunoutTimeline([
    { hour: 72, landslide: { cells: [], runouts: [runout(0.3, [102, 5.4])] } },
    { hour: 24, landslide: { cells: [], runouts: [] } },
    { hour: 168, landslide: { cells: [], runouts: [runout(0.85, [102, 5.4])] } },
  ]);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].firstHour, r[0].highHour, r[0].maxLevel], [72, 168, 'danger']);
});

test('a place within 1 km is HIGH at warning+, BE READY at alert, LOW beyond 1 km', () => {
  const timeline = buildRunoutTimeline([{ hour: 120, landslide: { cells: [], runouts: [runout(0.9, [102, 5.4]), runout(0.3, [102.2, 5.6])] } }]);
  const near = screenPlace([102.003, 5.4], timeline); // ~330 m from the danger runout
  assert.equal(near.level, 'high');
  assert.equal(near.hour, 120);
  assert.equal(screenPlace([102.203, 5.6], timeline).level, 'medium');
  const far = screenPlace([101.8, 5.2], timeline);
  assert.equal(far.level, 'low');
  assert.ok(far.nearestDistM > 1000);
});
