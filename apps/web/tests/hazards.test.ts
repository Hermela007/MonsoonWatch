import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScenarioLoader, type HazardScenario } from '../src/api/hazards';
import { createApiHazards } from '../src/layers/apiHazards';
import { GeoFrame } from '../src/geo/region';
import type { Heightmap } from '../src/terrain/heightmap';

const scenario = (mode: 'live' | 'replay' = 'replay'): HazardScenario => ({
  regionId: 'test', mode, ts: '2014-12-24T00:00:00Z', assessedAt: '2014-12-24T00:00:00Z', version: 'test', approximate: true,
  water: { likelyLevelM: 15, worstLevelM: 17 }, landslide: { cells: [], runouts: [] }, blockedRoadIds: [], blockedRoads: { type: 'MultiLineString', coordinates: [] },
  gauges: [{ id: 'g', name: 'Gauge', lngLat: [102,5], levelM: 15, level: 'danger', stale: false, thresholds: { alert: 12 } }], gaugesWithoutReading: [],
  roadStatusCounts: { flooded: 1, clear: 0, unknown: 1, outsideFloodplain: 0 }, coverage: { bbox: [101.99,4.99,102.01,5.01] }, limitations: [], landslideLabel: 'Screening tool',
});

test('hazard loader preserves scenario parameters and rejects an older response', async () => {
  const pending: ((response: Response) => void)[] = [], urls: string[] = [], shown: (HazardScenario | null)[] = [];
  const request = ((url: string) => { urls.push(url); return new Promise<Response>(resolve => pending.push(resolve)); }) as typeof fetch;
  const loader = createScenarioLoader(data => shown.push(data), request);
  const first = loader.load('test', 'live');
  const second = loader.load('test', 'replay', '2014-12-24T00:00:00Z');
  pending[1](Response.json(scenario())); await second;
  pending[0](Response.json(scenario('live'))); await first;
  assert.equal(shown.filter(Boolean).length, 1);
  assert.equal(shown.at(-1)?.mode, 'replay');
  assert.match(urls[1], /mode=replay&ts=2014-12-24T00%3A00%3A00Z/);
});

test('disconnect invalidates pending responses; errors stay visible', async () => {
  let resolve!: (res: Response) => void;
  const shown: (HazardScenario | null)[] = [];
  const loader = createScenarioLoader(data => shown.push(data), (() => new Promise<Response>(r => { resolve = r; })) as typeof fetch);
  const pending = loader.load('test', 'replay'); loader.clear(); resolve(Response.json(scenario())); await pending;
  assert.equal(shown.filter(Boolean).length, 0);
  let error: string | undefined;
  await createScenarioLoader((_, e) => { error = e; }, (async () => new Response('', { status: 503 })) as typeof fetch).load('test', 'live');
  assert.match(error!, /503/);
});

test('water display excludes stale, in-bank, missing and out-of-coverage gauges', () => {
  const bbox: [number,number,number,number] = [101.99,4.99,102.01,5.01];
  const hm: Heightmap = { bbox, cols: 3, rows: 3, elevM: new Float32Array(9).fill(10), cellXM: 1000, cellYM: 1000 };
  const layer = createApiHazards(hm, new GeoFrame(bbox, 3), [{ lines: [[[102,4.99],[102,5.01]]] }], () => true);
  const vertices = () => (layer.group.children[1] as any).geometry.attributes.position.count;
  const data = scenario(); layer.set(data); assert.ok(vertices() > 0);
  data.gauges[0].stale = true; layer.set(data); assert.equal(vertices(), 0);
  data.gauges[0].stale = false; data.gauges[0].levelM = 11; layer.set(data); assert.equal(vertices(), 0);
  data.gauges = []; layer.set(data); assert.equal(vertices(), 0);
  data.gauges = scenario().gauges; data.gauges[0].lngLat = [102.1, 5];
  data.gaugesWithoutReading = [{ id: 'missing', lngLat: [102, 5] }]; layer.set(data); assert.equal(vertices(), 0);
  data.gaugesWithoutReading = [];
  data.gauges = scenario().gauges; data.coverage.bbox = [100,3,100.01,3.01]; layer.set(data); assert.equal(vertices(), 0);
  layer.clear(); assert.equal(layer.group.children.length, 0);
});
