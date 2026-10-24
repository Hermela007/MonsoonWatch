import { STREAM_EVENT_NAMES, type StreamEventName, type StreamEvents } from '@monsoonwatch/shared';

type Handler<K extends StreamEventName> = (data: StreamEvents[K]) => void;
export type ConnectionMode = 'live' | 'mock' | 'connecting' | 'offline';

/** Only explicit ?mock=1 or a MOCK=1 API enables scripted events. Outages stay visible. */
export function createEventHub(opts: { forceMock: boolean; onMode: (mode: ConnectionMode) => void; onReadOnly?: (value: boolean) => void }) {
  const handlers = new Map<StreamEventName, Set<(data: unknown) => void>>();
  let mode: ConnectionMode = 'connecting';
  let es: EventSource | null = null;
  let retry: number | undefined;
  let opening: number | undefined;
  let closed = false;
  const emit = <K extends StreamEventName>(name: K, data: StreamEvents[K]) => {
    handlers.get(name)?.forEach((h) => h(data));
  };
  const setMode = (m: ConnectionMode) => {
    if (mode === m || closed) return;
    mode = m;
    opts.onMode(m);
  };
  const connect = async () => {
    try {
      const res = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('API unavailable');
      const health = await res.json() as { ok: boolean; mock: boolean; readOnly?: boolean };
      if (!health.ok) throw new Error('API unavailable');
      if (closed) return;
      if (health.mock) { setMode('mock'); return; }
      opts.onReadOnly?.(health.readOnly === true);
      es = new EventSource('/api/stream');
      opening = window.setTimeout(() => setMode('offline'), 5000);
      es.onopen = () => { window.clearTimeout(opening); setMode('live'); };
      es.onerror = () => { window.clearTimeout(opening); setMode('offline'); };
      // EventSource reconnects itself after interruption. Never replace live data with a demo.
      for (const name of STREAM_EVENT_NAMES) {
        es.addEventListener(name, (e) => {
          try { emit(name, JSON.parse((e as MessageEvent<string>).data)); }
          catch (err) { console.warn(`Invalid ${name} event`, err); }
        });
      }
    } catch {
      setMode('offline');
      if (!closed) retry = window.setTimeout(() => void connect(), 5000);
    }
  };
  if (opts.forceMock) setMode('mock');
  else void connect();

  return {
    get mode() { return mode; },
    on<K extends StreamEventName>(name: K, h: Handler<K>) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(h as (data: unknown) => void);
    },
    emit,
    close() {
      closed = true;
      window.clearTimeout(retry);
      window.clearTimeout(opening);
      es?.close();
      handlers.clear();
    },
  };
}
