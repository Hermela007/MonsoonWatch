// MongoDB change streams → events/bus publish() → GET /api/stream (SSE). The ONE live push path.
// Started from index.ts only when MOCK !== "1".
//
// raw_readings is a time series collection, which change streams can't watch, so readings are
// relayed from `reading_events` (same docs, new readings only, 7-day TTL — written by ingest).
//
// Resilience: each stream keeps its latest resume token. On error/close it logs a warning and
// reopens with `resumeAfter`, backing off 1 s, 2 s, 4 s … 30 s. Failures never throw out of here.
import type { ChangeStream, ChangeStreamDocument, Document, ResumeToken } from "mongodb";
import { ObjectId } from "mongodb";
import type { FastifyBaseLogger } from "fastify";
import { COLLECTIONS, type AgentStep, type StreamEventName, type StreamEvents } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { toReading, type ReadingDoc } from "../db/readings";
import { publish } from "./bus";

type Op = "insert" | "update" | "replace";

interface StreamSpec<K extends StreamEventName = StreamEventName> {
  collection: string;
  ops: Op[];
  event: K;
  payload: (doc: Document) => StreamEvents[K];
  /** Optional side effect after relaying (errors are logged, never thrown). */
  after?: (doc: Document, change: ChangeStreamDocument) => Promise<void>;
}

/** BSON → JSON-contract values: Date → ISO string, ObjectId → hex string, recursively. */
export function serialize<T>(value: unknown): T {
  if (value instanceof Date) return value.toISOString() as T;
  if (value instanceof ObjectId) return value.toHexString() as T;
  if (Array.isArray(value)) return value.map((v) => serialize(v)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)])) as T;
  }
  return value as T;
}

/**
 * Tech HUD line for a risk event written by Atlas Stream Processing (C4). The processor itself can only
 * $merge into one collection, so the API adds the AgentStep here. Fixed _id → if two API instances run,
 * the second insert is a duplicate-key no-op and the HUD still gets exactly one line.
 */
/** Which Stream Processing risk events get a Tech HUD line. All river crossings do. Rain only at warning or
 *  danger: the alert level (47.66 mm / 3 days, national threshold) is reached often in the monsoon (B's
 *  research caveat), so alert-level rain events are stored and sent as `risk.event` but not shown in the HUD. */
export function wantsHudStep(riskEvent: { source?: unknown; type?: unknown; level?: unknown }): boolean {
  if (riskEvent.source !== "stream_processing") return false;
  if (riskEvent.type === "rain_accumulation") return riskEvent.level === "warning" || riskEvent.level === "danger";
  return true;
}

async function stepForStreamProcessing(riskEvent: Document, change: ChangeStreamDocument): Promise<void> {
  if (!wantsHudStep(riskEvent)) return;
  // wallTime = when the processor's $merge wrote the event; windowEnd = when its window closed.
  const writtenAt = "wallTime" in change && change.wallTime instanceof Date ? change.wallTime : new Date();
  const windowEnd = riskEvent.windowEnd instanceof Date ? riskEvent.windowEnd : null;
  const step: AgentStep = {
    _id: `sp-${riskEvent._id}`,
    runId: `sp-${riskEvent._id}`,
    ts: writtenAt.toISOString(),
    actor: "MongoDB Stream Processing",
    kind: "db",
    summary: String(riskEvent.message ?? `${riskEvent.type} ${riskEvent.level}`),
    status: "ok",
    // Window close → risk event written: the processor's own latency.
    ...(windowEnd ? { latencyMs: Math.max(0, writtenAt.getTime() - windowEnd.getTime()) } : {}),
  };
  try {
    await (await getDb()).collection<AgentStep>(COLLECTIONS.agentSteps).insertOne(step);
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

const spec = <K extends StreamEventName>(s: StreamSpec<K>): StreamSpec => s as unknown as StreamSpec;

const SPECS: StreamSpec[] = [
  spec({ collection: COLLECTIONS.readingEvents, ops: ["insert"], event: "reading.new", payload: (d) => ({ reading: toReading(d as ReadingDoc) }) }),
  spec({ collection: COLLECTIONS.riskEvents, ops: ["insert"], event: "risk.event", payload: (d) => ({ riskEvent: serialize(d) }), after: stepForStreamProcessing }),
  // Steps are upserted running → ok/fail, so updates and replaces matter too.
  spec({ collection: COLLECTIONS.agentSteps, ops: ["insert", "update", "replace"], event: "agent.step", payload: (d) => ({ step: serialize(d) }) }),
  spec({ collection: COLLECTIONS.alerts, ops: ["insert", "update", "replace"], event: "alert.updated", payload: (d) => ({ alert: serialize(d) }) }),
  spec({ collection: COLLECTIONS.areaWarnings, ops: ["insert", "update", "replace"], event: "area_warning.updated", payload: (d) => ({ areaWarning: serialize(d) }) }),
  spec({ collection: COLLECTIONS.evacCentres, ops: ["insert", "update", "replace"], event: "evac.updated", payload: (d) => ({ evacCentre: serialize(d) }) }),
  spec({ collection: COLLECTIONS.saintTasks, ops: ["insert", "update", "replace"], event: "saint.task", payload: (d) => ({ task: serialize(d) }) }),
];

const MAX_BACKOFF_MS = 30_000;
// Resume token no longer in the oplog (ChangeStreamHistoryLost) / invalid — start fresh instead of looping.
const HISTORY_LOST_CODES = new Set([280, 286]);

class Watcher {
  private stream: ChangeStream | null = null;
  private token: ResumeToken | undefined;
  private backoffMs = 1_000;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly spec: StreamSpec, private readonly log: FastifyBaseLogger) {}

  async open(): Promise<void> {
    if (this.stopped) return;
    try {
      const coll = (await getDb()).collection(this.spec.collection);
      const stream = coll.watch([{ $match: { operationType: { $in: this.spec.ops } } }], {
        fullDocument: "updateLookup",
        ...(this.token ? { resumeAfter: this.token } : {}),
      });
      this.stream = stream;
      stream.on("change", (change: ChangeStreamDocument) => this.onChange(change));
      // Fires after every getMore, even with no changes: the stream is healthy and the token is fresh.
      stream.on("resumeTokenChanged", (token: ResumeToken) => {
        this.token = token;
        this.backoffMs = 1_000;
      });
      stream.on("error", (err) => this.reopen(stream, err));
      stream.on("close", () => this.reopen(stream));
      this.log.info(`change stream: watching ${this.spec.collection} → ${this.spec.event}${this.token ? " (resumed with token)" : ""}`);
    } catch (err) {
      this.reopen(null, err);
    }
  }

  private onChange(change: ChangeStreamDocument) {
    this.token = change._id;
    if (!("fullDocument" in change) || !change.fullDocument) return; // e.g. updated then deleted before lookup
    const doc = change.fullDocument;
    try {
      publish(this.spec.event, this.spec.payload(doc));
    } catch (err) {
      this.log.warn({ err }, `change stream: could not relay ${this.spec.collection} change`);
    }
    this.spec.after?.(doc, change).catch((err) => this.log.warn({ err }, `change stream: ${this.spec.collection} follow-up failed`));
  }

  /** Called on error or close; reopens once per failed stream instance, with backoff. */
  private reopen(failed: ChangeStream | null, err?: unknown) {
    if (this.stopped || (failed && failed !== this.stream) || this.timer) return;
    this.stream = null;
    if (failed && !failed.closed) failed.close().catch(() => {});
    const code = (err as { code?: number } | undefined)?.code;
    if (code !== undefined && HISTORY_LOST_CODES.has(code)) {
      this.log.warn(`change stream: ${this.spec.collection} resume token unusable (code ${code}) — restarting without it; changes in the gap are missed`);
      this.token = undefined;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.log.warn(
      { err: err instanceof Error ? err.message : err },
      `change stream: ${this.spec.collection} ${err ? "errored" : "closed"} — reopening in ${delay / 1000} s ${this.token ? "with resumeAfter token" : "without a resume token"}`,
    );
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, delay);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const stream = this.stream;
    this.stream = null;
    await stream?.close().catch(() => {});
  }

  /** Test hook: close the cursor as if the server dropped it. */
  async forceClose(): Promise<void> {
    await this.stream?.close();
  }
}

let watchers: Watcher[] = [];

export async function startChangeStreams(log: FastifyBaseLogger): Promise<void> {
  if (watchers.length) return;
  watchers = SPECS.map((s) => new Watcher(s, log.child({ module: "change-streams" })));
  await Promise.all(watchers.map((w) => w.open()));
}

export async function stopChangeStreams(): Promise<void> {
  const current = watchers;
  watchers = [];
  await Promise.all(current.map((w) => w.stop()));
}

/** For testing resume: close one collection's cursor (it should reopen with its resume token). */
export async function forceCloseChangeStream(collection: string): Promise<boolean> {
  const i = SPECS.findIndex((s) => s.collection === collection);
  if (i < 0 || !watchers[i]) return false;
  await watchers[i].forceClose();
  return true;
}
