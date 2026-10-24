// Replay engine (C3): plays the reconstructed Dec 2014 flood through the live pipeline.
// Each tick = one 2014 day: that day's replay readings (GloFAS discharge + rain) are COPIED from
// raw_readings into reading_events (meta.mode "replay", original 2014 ts). From there they follow the
// normal path: change stream → SSE `reading.new`, and Atlas Stream Processing → risk_events →
// `risk.event` + HUD step. raw_readings is only read, never written.
//
// `replay.tick` is the one event published directly (not via a change stream): it is the replay
// clock, not data, so there is nothing to store and relay.
//
// Every start resets the previous replay: replay risk_events (mode "replay"), their `sp-*` HUD steps
// and replay docs in reading_events are deleted, so the processors fire again. Live data is never touched.
import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { COLLECTIONS, type Region } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import type { ReadingDoc } from "../db/readings";
import { publish } from "../events/bus";

export interface ReplayStatus {
  running: boolean;
  replayId?: string;
  regionId?: string;
  ts?: string; // replay clock: the 2014 day last played (end of day, MYT)
  secondsPerDay?: number;
  from?: string;
  to?: string;
  day?: number; // 1-based index of the day last played
  days?: number;
}

interface Run {
  replayId: string;
  regionId: string;
  days: Date[];
  index: number; // next day to play
  secondsPerDay: number;
  startedAt: number;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
  lastTs?: Date;
}

let run: Run | null = null;
let starting = false;
let log: FastifyBaseLogger | undefined;

export function status(): ReplayStatus {
  if (!run) return { running: false };
  return {
    running: !run.stopped,
    replayId: run.replayId,
    regionId: run.regionId,
    ...(run.lastTs ? { ts: run.lastTs.toISOString(), day: run.index } : {}),
    secondsPerDay: run.secondsPerDay,
    from: run.days[0]?.toISOString(),
    to: run.days.at(-1)?.toISOString(),
    days: run.days.length,
  };
}

export const isRunning = () => starting || (run !== null && !run.stopped);

/** Delete everything a previous replay produced. Only docs marked replay are touched. */
async function reset(regionId: string): Promise<{ riskEvents: number; steps: number; readings: number }> {
  const db = await getDb();
  const risk = db.collection<{ _id: string }>(COLLECTIONS.riskEvents);
  const ids = (await risk.find({ regionId, mode: "replay" }, { projection: { _id: 1 } }).toArray()).map((d) => d._id);
  const steps = ids.length
    ? (await db.collection<{ _id: string }>(COLLECTIONS.agentSteps).deleteMany({ _id: { $in: ids.map((id) => `sp-${id}`) } })).deletedCount
    : 0;
  const riskEvents = ids.length ? (await risk.deleteMany({ _id: { $in: ids }, mode: "replay" })).deletedCount : 0;
  const readings = (await db.collection(COLLECTIONS.readingEvents).deleteMany({ "meta.mode": "replay" })).deletedCount;
  return { riskEvents, steps, readings };
}

export class ReplayError extends Error {
  constructor(readonly kind: "not_found" | "conflict" | "bad_request", message: string) {
    super(message);
  }
}

export async function start(opts: { regionId: string; secondsPerDay: number; from?: string }, logger: FastifyBaseLogger): Promise<ReplayStatus> {
  if (isRunning()) throw new ReplayError("conflict", `Replay ${run?.replayId ?? ""} is already running — POST /api/replay/stop first`);
  starting = true;
  log = logger;
  try {
    const db = await getDb();
    const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: opts.regionId });
    if (!region) throw new ReplayError("not_found", `Region "${opts.regionId}" not found`);
    if (!region.replay) throw new ReplayError("not_found", `Region "${opts.regionId}" has no replay configured`);
    const from = new Date(opts.from ?? region.replay.start);
    const end = new Date(region.replay.end);
    if (Number.isNaN(from.getTime())) throw new ReplayError("bad_request", `"from" is not a valid date: ${opts.from}`);
    if (from > end || from < new Date(new Date(region.replay.start).getTime() - 86_400_000)) {
      throw new ReplayError("bad_request", `"from" must be within the replay (${region.replay.start} – ${region.replay.end})`);
    }

    // One tick per distinct replay timestamp (readings are end-of-day MYT, so one per day).
    const days = (
      await db
        .collection<ReadingDoc>(COLLECTIONS.rawReadings)
        .aggregate<{ _id: Date }>([
          { $match: { "meta.mode": "replay", ts: { $gte: from, $lte: end } } },
          { $group: { _id: "$ts" } },
          { $sort: { _id: 1 } },
        ])
        .toArray()
    ).map((d) => d._id);
    if (days.length === 0) throw new ReplayError("not_found", "No replay readings in raw_readings for that range — run `pnpm load:replay`");

    const cleared = await reset(opts.regionId);
    run = { replayId: randomUUID(), regionId: opts.regionId, days, index: 0, secondsPerDay: opts.secondsPerDay, startedAt: Date.now(), timer: null, stopped: false };
    log.info({ replayId: run.replayId, days: days.length, secondsPerDay: opts.secondsPerDay, cleared }, "replay: started");
    void tick(run);
    return status();
  } finally {
    starting = false;
  }
}

async function tick(r: Run): Promise<void> {
  if (r.stopped || run !== r) return;
  const ts = r.days[r.index]!;
  try {
    const docs = await (await getDb())
      .collection<ReadingDoc & { _id?: unknown }>(COLLECTIONS.rawReadings)
      .find({ "meta.mode": "replay", ts }, { projection: { _id: 0 } })
      .toArray();
    if (r.stopped) return; // stopped while reading: don't insert
    const copies = docs.map((d) => ({ ...d, meta: { ...d.meta, mode: "replay" as const } }));
    if (copies.length) await (await getDb()).collection(COLLECTIONS.readingEvents).insertMany(copies, { ordered: false });
    r.lastTs = ts;
    r.index++;
    publish("replay.tick", { ts: ts.toISOString() });
    log?.info({ replayId: r.replayId, ts: ts.toISOString(), readings: copies.length, day: `${r.index}/${r.days.length}` }, "replay: tick");
  } catch (err) {
    // Skip the day rather than stall the demo clock; the next tick tries the next day.
    log?.warn({ err, ts: ts.toISOString() }, "replay: tick failed — skipping day");
    r.lastTs = ts;
    r.index++;
  }
  if (r.index >= r.days.length) {
    r.stopped = true;
    log?.info({ replayId: r.replayId }, "replay: finished");
    return;
  }
  if (r.stopped) return;
  // Schedule against the start time so slow inserts don't make the clock drift.
  const due = r.startedAt + r.index * r.secondsPerDay * 1000;
  r.timer = setTimeout(() => void tick(r), Math.max(0, due - Date.now()));
}

/** Stop the current replay (no-op if none). The in-flight tick, if any, won't schedule another. */
export function stop(): ReplayStatus {
  if (run && !run.stopped) {
    run.stopped = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = null;
    log?.info({ replayId: run.replayId, ts: run.lastTs?.toISOString() }, "replay: stopped");
  }
  return status();
}
