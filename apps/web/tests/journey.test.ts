import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseEvacuationRoute } from '../src/api/evacuationRoute';
import { journeyView } from '../src/ui/journey';

// The shared evacuation-route fixtures (packages/shared/fixtures) are the contract the real endpoint returns.
const fixture = (name: string) => {
  const r = parseEvacuationRoute(JSON.parse(readFileSync(new URL(`../../../packages/shared/fixtures/evacuation-route.${name}.json`, import.meta.url), 'utf8')));
  assert.equal(r.kind, 'route', r.kind === 'invalid' ? r.error : '');
  return (r as Extract<typeof r, { kind: 'route' }>).route;
};

test('ok: centre, time, places, steps and the agreed partial-hazard wording', () => {
  const v = journeyView(fixture('ok'));
  assert.equal(v.ok, true);
  assert.equal(v.headline, 'SK Manik Urai (test)');
  assert.equal(v.meta, '2.4 km · about 5 min by car');
  assert.equal(v.centre?.places, '50 places free (capacity estimated)');
  assert.match(v.centre?.provenance ?? '', /not a confirmed relief centre/);
  assert.equal(v.hazard.text, 'Some sections lack hazard information');
  assert.equal(v.hazard.tone, 'partial');
  assert.ok(v.hazardLines.includes('No official road-closure data'));
  assert.equal(v.steps.length, 3);
  assert.equal(v.steps[2].distance, null); // "Arrive" has no distance
  // Alternatives that can't be reached are listed with why, and can't be chosen.
  assert.deepEqual(v.alternatives.map((a) => [a.canRoute, a.text]), [[false, 'all routes flooded'], [false, 'no road connection']]);
});

test('all routes flooded: the server sentence, no steps, a reachable alternative to choose', () => {
  const v = journeyView(fixture('all-routes-flooded'));
  assert.equal(v.ok, false);
  assert.match(v.headline, /crosses a flooded road/);
  assert.equal(v.meta, null);
  assert.equal(v.steps.length, 0);
  assert.deepEqual(v.alternatives.map((a) => [a.name, a.canRoute, a.text]), [['SK Manik Urai (test)', true, '2.4 km · 50 places']]);
});

test('boat: unsupported, nothing claimed, hazards unknown wording', () => {
  const v = journeyView(fixture('boat-unsupported'));
  assert.equal(v.ok, false);
  assert.equal(v.travel, 'boat');
  assert.match(v.headline, /Boat routing is not available/);
  assert.equal(v.hazard.text, 'Hazard conditions unavailable — not checked for flooding or landslides');
  assert.equal(v.steps.length, 0);
  assert.equal(v.alternatives.length, 0);
});

test('no response ever earns a "safe" label', () => {
  for (const name of ['ok', 'all-routes-flooded', 'boat-unsupported']) {
    assert.doesNotMatch(JSON.stringify(journeyView(fixture(name))), /\bsafe\b/i);
  }
});

test('responses that break the contract are rejected, not shown', () => {
  assert.equal(parseEvacuationRoute({ status: 'ok' }).kind, 'invalid');
});
