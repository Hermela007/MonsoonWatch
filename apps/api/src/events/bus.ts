// In-process event bus feeding GET /api/stream.
// Real mode: MongoDB change streams publish here. Mock mode: the scripted sequence publishes here.
// Nothing else should push to the browser.
import { EventEmitter } from "node:events";
import type { StreamEventName, StreamEvents } from "@monsoonwatch/shared";

type Listener = <K extends StreamEventName>(name: K, data: StreamEvents[K]) => void;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function publish<K extends StreamEventName>(name: K, data: StreamEvents[K]): void {
  emitter.emit("event", name, data);
}

export function subscribe(listener: Listener): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}
