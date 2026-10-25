import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResidentAudio, type RecordingState } from '../src/ui/residentAudio';
import { residentNotice } from '../src/ui/residentNotice';
import type { Alert, AreaWarning } from '@monsoonwatch/shared';

function harness(request: typeof fetch) {
  const states: RecordingState[] = [], revoked: string[] = [];
  let plays = 0, pauses = 0, waits = 0;
  const audio = { src: '', play: async () => { plays++; }, pause: () => { pauses++; }, load() {}, removeAttribute() {}, onended: null, onerror: null } as unknown as HTMLAudioElement;
  const player = createResidentAudio(s => states.push(s), { request, createAudio: () => audio, createUrl: () => 'blob:approved', revokeUrl: url => revoked.push(url), wait: async () => { waits++; } });
  return { player, audio, states, revoked, get plays() { return plays; }, get pauses() { return pauses; }, get waits() { return waits; } };
}
const approved = { id: 'area:run/district', languages: ['en','ms'], status: 'approved' };

test('Malay first, English fallback; uses the encoded approved warning ID', async () => {
  const urls: string[] = [];
  const h = harness((async (url: string) => { urls.push(url); return url.endsWith('/ms') ? new Response('', { status: 404 }) : new Response('recording', { headers: { 'Content-Type': 'audio/wav' } }); }) as typeof fetch);
  h.player.set(approved); await h.player.toggle();
  assert.deepEqual(urls, ['/api/alerts/area%3Arun%2Fdistrict/audio/ms', '/api/alerts/area%3Arun%2Fdistrict/audio/en']);
  assert.equal(h.plays, 1); assert.equal(h.states.at(-1)?.language, 'en');
  h.audio.onended?.(new Event('ended'));
  assert.deepEqual(h.revoked, ['blob:approved']); assert.equal(h.states.at(-1)?.phase, 'idle');
});

test('404 generation delay retries the approved audio, then plays Malay', async () => {
  let requests = 0;
  const h = harness((async () => ++requests < 3 ? new Response('', { status: 404 }) : new Response('recording')) as typeof fetch);
  h.player.set(approved); await h.player.toggle();
  assert.equal(h.waits, 1); assert.equal(h.plays, 1); assert.equal(h.states.at(-1)?.language, 'ms');
});

test('approved district warning uses its own ID and falls back from Malay to English', async () => {
  const urls: string[] = [];
  const h = harness((async (url: string) => {
    urls.push(url);
    return url.endsWith('/ms') ? new Response('', { status: 404 }) : new Response('approved English audio');
  }) as typeof fetch);
  h.player.set({ id: 'area:run/Kuala Krai', status: 'approved', languages: ['en', 'ms'] });
  await h.player.toggle();
  assert.deepEqual(urls, ['/api/alerts/area%3Arun%2FKuala%20Krai/audio/ms', '/api/alerts/area%3Arun%2FKuala%20Krai/audio/en']);
  assert.equal(h.plays, 1);
  assert.equal(h.states.at(-1)?.language, 'en');
});

test('no approved message means no requests or playback, and button stays hidden', async () => {
  const h = harness((async () => { throw new Error('must not request'); }) as typeof fetch);
  h.player.set({ ...approved, status: 'draft' }); await h.player.toggle();
  h.player.set({ ...approved, status: 'needs_approval' }); await h.player.toggle();
  h.player.set({ ...approved, languages: [] }); await h.player.toggle();
  assert.equal(h.plays, 0); assert.ok(h.states.every(s => !s.visible));
});

test('unavailable audio has bounded retries and visible error, with no device speech', async () => {
  const h = harness((async () => new Response('', { status: 404 })) as typeof fetch);
  h.player.set(approved); await h.player.toggle();
  assert.equal(h.waits, 5); assert.equal(h.plays, 0); assert.equal(h.states.at(-1)?.phase, 'error');
  assert.match(h.states.at(-1)!.message, /not ready/);
});

test('changing location while downloading prevents the old recording from playing', async () => {
  let resolve!: (res: Response) => void;
  const h = harness((() => new Promise<Response>(r => { resolve = r; })) as typeof fetch);
  h.player.set(approved); const pending = h.player.toggle(); h.player.set(null);
  resolve(new Response('old audio')); await pending;
  assert.equal(h.plays, 0); assert.equal(h.states.at(-1)?.visible, false);
});

test('changing an approved alert stops playback and releases its blob', async () => {
  const h = harness((async () => new Response('recording')) as typeof fetch);
  h.player.set(approved); await h.player.toggle(); h.player.set({ ...approved, id: 'different' });
  assert.equal(h.pauses, 1); assert.deepEqual(h.revoked, ['blob:approved']); assert.equal(h.states.at(-1)?.phase, 'idle');
});

test('resident notices use explicit district membership and prefer an approved individual plan', () => {
  const warning = { _id: 'district', villageIds: ['v1'], status: 'approved', approvedAt: '2026-10-24' } as AreaWarning;
  const individual = { _id: 'individual', villageId: 'v1', route: { coordinates: [] }, status: 'approved' } as unknown as Alert;
  const origin: [number,number] = [102,5]; const distance = () => 10;
  assert.equal(residentNotice([], [warning], 'v1', 'Village', origin, distance)?._id, 'district');
  assert.equal(residentNotice([], [warning], 'v2', 'Other village', origin, distance), null);
  assert.equal(residentNotice([], [{ ...warning, status: 'needs_approval' }], 'v1', '', origin, distance), null);
  assert.equal(residentNotice([individual], [warning], 'v1', '', origin, distance)?._id, 'individual');
  const neighbour = { ...individual, villageId: 'v2', route: { type: 'LineString' as const, coordinates: [origin] } };
  assert.equal(residentNotice([neighbour], [warning], 'v1', '', origin, () => 0)?._id, 'district', 'a nearby plan for another known village must not replace this village’s approved warning');
});
