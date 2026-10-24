import { STREAM_EVENT_NAMES, type StreamEventName, type StreamEvents } from '@monsoonwatch/shared';

type Handler<K extends StreamEventName> = (data: StreamEvents[K]) => void;

/**
 * One place the UI gets live events from. Live: GET /api/stream (SSE). If the API isn't reachable
 * (or ?mock=1), the scripted mock in src/mock/ publishes the same typed events instead.
 */
export function createEventHub(opts: { forceMock: boolean; onMode: (mode: 'live' | 'mock') => void }) {
  const handlers = new Map<StreamEventName, Set<(data: unknown) => void>>();
  let mode: 'live' | 'mock' | 'connecting' = 'connecting';

  const emit = <K extends StreamEventName>(name: K, data: StreamEvents[K]) => {
    handlers.get(name)?.forEach((h) => h(data));
  };
  const setMode = (m: 'live' | 'mock') => {
    if (mode === m) return;
    mode = m;
    opts.onMode(m);
  };

  if (opts.forceMock) setMode('mock');
  else {
    const es = new EventSource('/api/stream');
    const fallback = window.setTimeout(() => {
      if (mode !== 'live') {
        es.close();
        setMode('mock');
      }
    }, 2500);
    es.onopen = () => {
      window.clearTimeout(fallback);
      setMode('live');
    };
    es.onerror = () => {
      if (mode === 'connecting') return; // fallback timer decides
    };
    for (const name of STREAM_EVENT_NAMES) {
      es.addEventListener(name, (e) => emit(name, JSON.parse((e as MessageEvent<string>).data)));
    }
  }

  return {
    get mode() {
      return mode;
    },
    on<K extends StreamEventName>(name: K, h: Handler<K>) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(h as (data: unknown) => void);
    },
    /** Used by the mock source to publish exactly as the server would. */
    emit,
  };
}
