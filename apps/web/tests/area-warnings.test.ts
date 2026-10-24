import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { AreaWarning } from '@monsoonwatch/shared';
import { areaWarningView } from '../src/ui/areaWarnings';

// B's shared fixtures for district warnings (packages/shared/fixtures/area-warning.*.json).
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../packages/shared/fixtures/area-warning.${name}.json`, import.meta.url), 'utf8')) as AreaWarning;

test('evacuate: level, district, villages, people, vulnerable by category, pickups not planned', () => {
  const v = areaWarningView(fixture('evacuate'));
  assert.equal(v.level, 'DANGER');
  assert.equal(v.title, 'Flood · Kuala Krai district');
  assert.equal(v.kindLabel, 'Evacuate');
  assert.equal(v.stats, '2 villages · 2,000 people');
  assert.equal(v.vulnerable, '250 vulnerable: 5 bedridden · 20 disabled · 160 elderly · 65 without transport');
  assert.equal(v.pickups, 'Pickups not planned — officials arrange transport.');
  assert.equal(v.decided, false);
  assert.match(v.status, /Nothing is sent until you approve/);
  assert.match(v.message ?? '', /^DANGER/);
});

test('advisory: be ready, no pickups line', () => {
  const v = areaWarningView(fixture('advisory'));
  assert.equal(v.kind, 'advisory');
  assert.equal(v.kindLabel, 'Advisory · be ready');
  assert.equal(v.pickups, null);
});

test('decided warnings say who approved, or that nothing was sent', () => {
  const a = fixture('evacuate');
  assert.match(areaWarningView({ ...a, status: 'approved', approvedBy: 'Duty officer', approvedAt: '2026-10-24T14:02:00Z' }).status, /^Approved by Duty officer/);
  assert.equal(areaWarningView({ ...a, status: 'rejected' }).status, 'Rejected — nothing was sent.');
  assert.equal(areaWarningView({ ...a, status: 'approved' }).decided, true);
});
