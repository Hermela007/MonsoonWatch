import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Alert, AreaWarning, SaintTask } from '@monsoonwatch/shared';
import { emptySaintContext, saintText, saintTaskDetail, saintTaskStatus, saintAppliedText, PICKUP_CATEGORY } from '../src/ui/saintPresentation';

const context = emptySaintContext();
const alert = { _id: 'alert:osm-node-123:1', villageId: 'osm-node-123', evacCentreId: 'osm-way-456', level: 'danger', hazard: 'flood', people: 400, pickups: [{}, {}, {}] } as Alert;
context.alerts.set(alert._id, alert);
context.villages.set(alert.villageId, 'Kampung Kual');
context.centres.set(alert.evacCentreId, "SK To' Uban");
const task: SaintTask = { _id: 'task-1', alertId: alert._id, ts: '2026-10-25T09:15:00Z', type: 'send_alert', status: 'queued', detail: 'Fallback approved alert' };

test('Saint alert cards resolve village and centre names and pickup groups', () => {
  assert.equal(saintTaskDetail(task, context), "DANGER flood · Kampung Kual → SK To' Uban · 400 people · 3 pickup groups");
  const late = emptySaintContext();
  assert.equal(saintTaskDetail(task, late), task.detail);
  late.alerts.set(alert._id, alert); late.villages.set(alert.villageId, 'Kampung Kual'); late.centres.set(alert.evacCentreId, "SK To' Uban");
  assert.equal(saintTaskDetail(task, late), saintTaskDetail(task, context));
});

test('district tasks resolve the warning ID independently of individual alerts', () => {
  const warning = { _id: 'area-warning-1', district: 'Kota Bharu', villageIds: Array.from({ length: 42 }, (_, i) => `v${i}`) } as AreaWarning;
  context.warnings.set(warning._id, warning);
  assert.equal(saintTaskDetail({ ...task, target: 'area_warning', alertId: warning._id }, context), 'Kota Bharu district · 42 villages');
});

test('in-progress alerts wait for a leader check-in and show handoff time', () => {
  const sent = { ...task, status: 'in_progress' as const };
  const status = saintTaskStatus(sent, [sent]);
  assert.match(status, /^Waiting for the village head’s check-in · sent \d{2}:\d{2}$/);
  assert.equal(saintTaskStatus(sent, [{ ...task, type: 'log_checkin', status: 'done' }]), 'in progress');
  assert.equal(saintTaskStatus({ ...task, status: 'done' }, []), 'done');
});

test('acknowledgement has no invented headcount; moving and arrived keep counts', () => {
  const item = { alertId: alert._id, taskId: 'checkin', centreId: alert.evacCentreId, centre: alert.evacCentreId, people: null, status: 'acknowledged', raw: '' };
  assert.equal(saintAppliedText(item, context), "Acknowledged → SK To' Uban");
  assert.equal(saintAppliedText({ ...item, people: 40, status: 'moving' }, context), "40 people moving → SK To' Uban");
  assert.equal(saintAppliedText({ ...item, people: 40, status: 'arrived' }, context), "40 people arrived → SK To' Uban");
});

test('fallbacks and report reasons hide identifiers, audio links and contacts', () => {
  // Construct a synthetic phone-shaped token without storing a contact number.
  const contact = '+' + '6'.repeat(11);
  const text = saintText(`Skipped: already applied — MW CHECKIN alert=${alert._id} centre=${alert.evacCentreId} noTransport null ${contact} ms /api/alerts/a/audio/ms en https://example.test/api/alerts/a/audio/en osm-node-999`, context);
  assert.match(text, /Skipped: already applied/);
  assert.match(text, /Kampung Kual/); assert.match(text, /SK To' Uban/);
  assert.match(text, /without transport/); assert.match(text, /contact hidden/);
  assert.doesNotMatch(text, /osm-|\/api\/|noTransport|\bnull\b/);
  assert.ok(!text.includes(contact));
  assert.equal(saintText('Missing approved Malay or English text.', context), 'Missing approved Malay or English text.');
  assert.deepEqual(Object.values(PICKUP_CATEGORY), ['bedridden', 'disabled', 'elderly', 'without transport']);
});
