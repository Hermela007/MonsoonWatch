// Starts agent runs from Stream Processing risk events (C's guidance, 24 Oct):
//   - listens to `risk.event` on the in-process bus, which C's risk_events change stream feeds
//     (a listener, not a second push path — nothing is published from here),
//   - only source "stream_processing", level ≥ warning,
//   - dedupes by risk event _id (deterministic: station:type:level:slot),
//   - only reacts to the FIRST event per station/level or an ESCALATION (replay emits ~160 events),
//   - coalesces events arriving close together into one run; at most one run per region+mode at a
//     time, with one follow-up queued if new escalations arrive meanwhile.
// Replay restarts are detected when the replay clock jumps backwards, which resets the memory.
// Disable with AGENT_AUTO_RUN=0.

import { randomUUID } from "node:crypto";
import type { RiskEvent, RiskLevel } from "@monsoonwatch/shared";
import { subscribe } from "../events/bus";
import { runAgent } from "./orchestrator";
import { loadSituationFromDb } from "./situation-db";
import { emitStep } from "./steps";

type Mode = "live" | "replay";
type StreamRiskEvent = RiskEvent & { mode?: Mode };

const RANK: Record<RiskLevel, number> = { normal: 0, alert: 1, warning: 2, danger: 3 };
const MIN_RANK = RANK.warning;
const COALESCE_MS = 8_000;
const REPLAY_RESTART_JUMP_MS = 2 * 24 * 3600 * 1000;

interface Lane {
  highest: Map<string, number>; // stationId → highest level already acted on
  seen: Set<string>;
  lastTs: number;
  timer: NodeJS.Timeout | null;
  running: boolean;
  queued: boolean;
  trigger: StreamRiskEvent | null; // most severe new event since the last run started
}

export interface AutoTriggerOptions {
  start?: (regionId: string, mode: Mode, trigger: StreamRiskEvent) => Promise<void>;
  coalesceMs?: number;
  log?: (msg: string) => void;
}

/** Pure decision logic, exported for tests. */
export function createAutoTrigger(opts: AutoTriggerOptions = {}) {
  const lanes = new Map<string, Lane>();
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const log = opts.log ?? ((m: string) => console.log(`[agent] ${m}`));
  const start = opts.start ?? defaultStart;

  const lane = (key: string): Lane => {
    let l = lanes.get(key);
    if (!l) {
      l = { highest: new Map(), seen: new Set(), lastTs: 0, timer: null, running: false, queued: false, trigger: null };
      lanes.set(key, l);
    }
    return l;
  };

  async function fire(regionId: string, mode: Mode, l: Lane) {
    l.timer = null;
    if (l.running) { l.queued = true; return; }
    const trigger = l.trigger;
    if (!trigger) return;
    l.trigger = null;
    l.running = true;
    try {
      await start(regionId, mode, trigger);
    } catch (err) {
      log(`auto-run failed: ${(err as Error).message}`);
    } finally {
      l.running = false;
      if (l.queued && l.trigger) {
        l.queued = false;
        l.timer = setTimeout(() => void fire(regionId, mode, l), coalesceMs);
      }
    }
  }

  /** Returns true if this event will (eventually) start a run. */
  function onRiskEvent(e: StreamRiskEvent): boolean {
    if (e.source !== "stream_processing" || RANK[e.level] < MIN_RANK) return false;
    const mode: Mode = e.mode ?? "live";
    const l = lane(`${e.regionId}:${mode}`);
    const ts = Date.parse(e.ts);

    if (mode === "replay" && l.lastTs && ts < l.lastTs - REPLAY_RESTART_JUMP_MS) {
      l.highest.clear(); // replay restarted from Dec 2014: start fresh
      l.seen.clear();
    }
    l.lastTs = Math.max(l.lastTs, ts || 0);

    if (l.seen.has(e._id)) return false;
    l.seen.add(e._id);
    const key = e.stationId ?? e.type;
    if (RANK[e.level] <= (l.highest.get(key) ?? 0)) return false; // not new, not an escalation
    l.highest.set(key, RANK[e.level]);

    if (!l.trigger || RANK[e.level] >= RANK[l.trigger.level]) l.trigger = e;
    if (l.running) l.queued = true;
    else if (!l.timer) l.timer = setTimeout(() => void fire(e.regionId, mode, l), coalesceMs);
    return true;
  }

  function stop() {
    for (const l of lanes.values()) if (l.timer) clearTimeout(l.timer);
  }

  return { onRiskEvent, stop };
}

async function defaultStart(regionId: string, mode: Mode, trigger: StreamRiskEvent): Promise<void> {
  const runId = `run-${randomUUID()}`;
  await emitStep({
    runId, actor: "Agent", kind: "info", status: "ok",
    summary: `Triggered by MongoDB Stream Processing: ${trigger.message}`.slice(0, 220),
  });
  const situation = await loadSituationFromDb(regionId, { mode, at: mode === "replay" ? new Date(trigger.ts) : new Date() });
  await runAgent({ situation, trigger: { type: "risk_event", riskEventId: trigger._id }, runId });
}

let unsubscribe: (() => void) | null = null;

/** Called once when the API starts (real mode only). */
export function startAutoTrigger(): void {
  if (unsubscribe || process.env.AGENT_AUTO_RUN === "0") return;
  const t = createAutoTrigger();
  const off = subscribe((name, data) => {
    if (name === "risk.event") t.onRiskEvent((data as { riskEvent: StreamRiskEvent }).riskEvent);
  });
  unsubscribe = () => { off(); t.stop(); };
}
