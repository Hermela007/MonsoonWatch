import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createEventHub, type ConnectionMode } from '../src/api/stream';

const realFetch = globalThis.fetch;
const timers = new Map<number, () => void>();
let timerId = 0;
Object.assign(globalThis, { window: {
  setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
  clearTimeout: (id: number) => timers.delete(id),
} });
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen?: () => void;
  onerror?: () => void;
  closed = false;
  listeners = new Map<string, (e: { data: string }) => void>();
  constructor(readonly url: string) { FakeEventSource.instances.push(this); }
  addEventListener(name: string, fn: (e: { data: string }) => void) { this.listeners.set(name, fn); }
  close() { this.closed = true; }
}
Object.assign(globalThis, { EventSource: FakeEventSource });
after(() => { globalThis.fetch = realFetch; });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test('explicit demo never contacts API', () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected fetch'); };
  const modes: ConnectionMode[] = [];
  const hub = createEventHub({ forceMock: true, onMode: (m) => modes.push(m) });
  assert.equal(hub.mode, 'mock');
  assert.deepEqual(modes, ['mock']);
  assert.equal(calls, 0);
  hub.close();
});

test('MOCK=1 health response is labelled demo rather than live', async () => {
  globalThis.fetch = async () => Response.json({ ok: true, mock: true });
  const hub = createEventHub({ forceMock: false, onMode: () => {} });
  await settle();
  assert.equal(hub.mode, 'mock');
  assert.equal(FakeEventSource.instances.length, 0);
  hub.close();
});

test('outage retries, SSE reconnect restores live, and typed events still arrive', async () => {
  const modes: ConnectionMode[] = [];
  globalThis.fetch = async () => { throw new Error('offline'); };
  const hub = createEventHub({ forceMock: false, onMode: (m) => modes.push(m) });
  await settle();
  assert.equal(hub.mode, 'offline');
  assert.ok(!modes.includes('mock'));
  globalThis.fetch = async () => Response.json({ ok: true, mock: false });
  const retry = [...timers.values()].at(-1)!;
  timers.clear();
  retry();
  await settle();
  const es = FakeEventSource.instances.at(-1)!;
  assert.equal(es.url, '/api/stream');
  es.onopen!();
  assert.equal(hub.mode, 'live');
  es.onerror!();
  assert.equal(hub.mode, 'offline');
  assert.equal(es.closed, false); // Native EventSource owns reconnection.
  es.onopen!();
  assert.equal(hub.mode, 'live');
  let tick = '';
  hub.on('replay.tick', ({ ts }) => { tick = ts; });
  es.listeners.get('replay.tick')!({ data: '{"ts":"2014-12-24T16:00:00Z"}' });
  assert.equal(tick, '2014-12-24T16:00:00Z');
  hub.close();
  assert.equal(es.closed, true);
  assert.equal(timers.size, 0);
});
