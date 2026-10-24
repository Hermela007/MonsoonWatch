import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fetchSaintHandoff, markSaintHandedOff, submitSaintReport } from '../src/api/client';
const original = globalThis.fetch;
after(() => { globalThis.fetch = original; });

test('handoff fetch encodes the task id and preserves the manual-copy fallback', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(input, '/api/saint/tasks/task%2F123/handoff');
    assert.equal(init?.method ?? 'GET', 'GET');
    return Response.json({ taskId: 'task/123', alertId: 'a', brief: 'Approved brief', whatsappUrl: null });
  };
  const result = await fetchSaintHandoff('task/123');
  assert.equal(result.whatsappUrl, null);
  assert.equal(result.brief, 'Approved brief');
});

test('handoff acknowledgement and reports send the operator and preserve every result group', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.by, 'Test officer');
    if (String(input).endsWith('/handed-off')) {
      assert.equal(input, '/api/saint/tasks/task-1/handed-off');
      return Response.json({ _id: 'task-1', status: 'in_progress' });
    }
    assert.equal(input, '/api/saint/updates');
    assert.equal(body.text, 'MW CHECKIN alert=a centre=SK Dabong people=30 status=arrived');
    return Response.json({ applied: [{ people: 30, centre: 'SK Dabong', status: 'arrived' }], skipped: [{ line: 'duplicate', reason: 'already applied' }], errors: [{ line: 'bad', reason: 'unknown centre' }] });
  };
  assert.equal((await markSaintHandedOff('task-1', 'Test officer')).status, 'in_progress');
  const result = await submitSaintReport('MW CHECKIN alert=a centre=SK Dabong people=30 status=arrived', 'Test officer');
  assert.equal(result.applied[0].people, 30);
  assert.equal(result.skipped[0].reason, 'already applied');
  assert.equal(result.errors[0].reason, 'unknown centre');
});

test('backend handoff and report failures are surfaced without claiming success', async () => {
  globalThis.fetch = async () => Response.json({ error: { message: 'Only approved alerts are handed to Saint' } }, { status: 409 });
  await assert.rejects(fetchSaintHandoff('draft-task'), /Only approved/);
  globalThis.fetch = async () => Response.json({ error: { message: 'No MW CHECKIN line found' } }, { status: 400 });
  await assert.rejects(submitSaintReport('hello', 'Test officer'), /No MW CHECKIN/);
});
