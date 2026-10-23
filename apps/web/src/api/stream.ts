import { STREAM_EVENT_NAMES } from '@monsoonwatch/shared';

/**
 * Live events from GET /api/stream (SSE). For now they are logged; the resident view
 * keeps working on local replay data when the API is down.
 */
export function connectStream(onEvent: (name: string, data: unknown) => void = (n, d) => console.debug('[stream]', n, d)) {
  const stream = new EventSource('/api/stream');
  stream.onopen = () => console.info('[stream] connected');
  stream.onerror = () => console.info('[stream] disconnected (is the API running?)');
  for (const name of STREAM_EVENT_NAMES) {
    stream.addEventListener(name, (e) => onEvent(name, JSON.parse((e as MessageEvent<string>).data)));
  }
  return stream;
}
