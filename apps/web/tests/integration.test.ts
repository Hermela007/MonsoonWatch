import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { Alert, SaintTask } from '@monsoonwatch/shared';
import { buildServer } from '../../api/src/server';
import { defaultStore } from '../../api/src/agent/store';
import { decideAlert, fetchAgentRun, setApiLive, startReplay, stopReplay } from '../src/api/client';

// Exercise the frontend's actual HTTP payloads against B/C's registered routes,
// using an in-memory agent store. No MongoDB, Gemini calls, or external delivery.
// Guard: the in-memory store is only used when MOCK=1 (`pnpm test:web` sets it). Run any other way
// with a real .env, these tests would write fake alerts and Saint tasks into the shared database
// (that happened on 24 Oct: "integration-approve" reached Saint), so they skip instead.
const SKIP = process.env.MOCK === '1' ? false : 'needs MOCK=1 (run with `pnpm test:web`): would write to the real database';
const app = buildServer();
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await app.inject({
    method: (init?.method ?? 'GET') as 'GET' | 'POST',
    url: String(input),
    headers: init?.headers as Record<string, string>,
    payload: init?.body as string,
  });
  return new Response(response.body, { status: response.statusCode });
};
setApiLive(true);
after(async () => { globalThis.fetch = realFetch; setApiLive(false); await app.close(); });

const makeAlert = (id: string): Alert => ({
  _id: id, regionId: 'kelantan', runId: 'integration-run', villageId: 'test-village',
  level: 'warning', hazard: 'flood', evacCentreId: 'test-centre', people: 10,
  route: { type: 'LineString', coordinates: [[102.2, 5.5], [102.21, 5.51]] },
  messages: [{ lang: 'en', text: 'Integration test only' }],
  verification: [{ check: 'route', passed: true, detail: 'Test route' }], status: 'verified',
});

test('frontend approval records the officer and creates a queued handoff', { skip: SKIP }, async () => {
  await defaultStore().saveAlert(makeAlert('integration-approve'));
  const approved = await decideAlert('integration-approve', 'approve', 'Test officer');
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvedBy, 'Test officer');
  assert.ok(approved.approvedAt);
  const tasks = (defaultStore() as ReturnType<typeof defaultStore> & { saintTasks: SaintTask[] }).saintTasks;
  assert.equal(tasks.filter((t) => t.alertId === approved._id && t.status === 'queued').length, 1);
  await assert.rejects(decideAlert(approved._id, 'approve', 'Test officer'), /only alerts that passed every check/);
});

test('frontend rejection and backend validation errors propagate', { skip: SKIP }, async () => {
  await defaultStore().saveAlert(makeAlert('integration-reject'));
  assert.equal((await decideAlert('integration-reject', 'reject', 'Test officer')).status, 'rejected');
  await assert.rejects(decideAlert('integration-reject', 'approve', ''), /approvedBy/);
});

test('frontend can recover persisted run details after missed stream events', { skip: SKIP }, async () => {
  await defaultStore().saveRun({ _id: 'integration-run', regionId: 'kelantan', trigger: { type: 'manual' }, status: 'done', startedAt: new Date().toISOString() });
  const detail = await fetchAgentRun('integration-run');
  assert.equal(detail?.run.status, 'done');
  assert.equal(detail?.alerts.length, 2);
});

test('replay controls use the registered C routes and surface start errors', { skip: SKIP }, async () => {
  // An empty region is rejected by the request schema before opening MongoDB.
  await assert.rejects(startReplay(''), /regionId/);
  assert.equal((await stopReplay()).running, false);
});
