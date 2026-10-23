// AgentStep logging — every sponsor-feature call becomes one line in the Tech HUD.
//
// One push path (IMPLEMENTATION §1.4): in real mode the sink writes AgentSteps to MongoDB
// and C's change stream relays them over SSE as `agent.step`. In mock mode (or before the DB
// is wired) they are kept in memory so the hello-world call can still be inspected.
//
// The sink must UPSERT by `_id`: a step is written once as "running" and again when it
// finishes ("ok" / "fail") so the HUD can show it live.

import { randomUUID } from "node:crypto";
import type { AgentStep } from "@monsoonwatch/shared";

export type StepSink = (step: AgentStep) => Promise<void> | void;

const memorySteps = new Map<string, AgentStep>();

const memorySink: StepSink = (step) => {
  memorySteps.set(step._id, step);
};

let sink: StepSink = memorySink;

/** Called once at API start-up with a MongoDB-backed sink (see TODO below). */
export function setStepSink(next: StepSink): void {
  sink = next;
}

// TODO(B, after C's db client merges): add `mongoStepSink` that does
// `agentSteps.replaceOne({ _id: step._id }, step, { upsert: true })` and register it in
// the API bootstrap when MOCK !== "1". Collection name to be confirmed with C.

/** Steps recorded by the in-memory sink, oldest first. Useful in mock mode and scripts. */
export function getMemorySteps(runId?: string): AgentStep[] {
  const all = [...memorySteps.values()];
  return runId ? all.filter((s) => s.runId === runId) : all;
}

export type StepInit = Pick<AgentStep, "runId" | "actor" | "kind" | "summary">;
export type StepFinish = Partial<Pick<AgentStep, "summary" | "tokens">>;

export interface StepHandle {
  readonly id: string;
  ok(finish?: StepFinish): Promise<AgentStep>;
  fail(finish?: StepFinish): Promise<AgentStep>;
}

/** Write a "running" step now; call `.ok()` or `.fail()` when the work finishes (adds latency). */
export async function startStep(init: StepInit): Promise<StepHandle> {
  const startedAt = Date.now();
  const base: AgentStep = {
    _id: randomUUID(),
    ts: new Date(startedAt).toISOString(),
    status: "running",
    ...init,
  };
  await sink(base);

  const finish = async (status: "ok" | "fail", extra: StepFinish = {}): Promise<AgentStep> => {
    const step: AgentStep = { ...base, ...extra, status, latencyMs: Date.now() - startedAt };
    await sink(step);
    return step;
  };

  return {
    id: base._id,
    ok: (extra) => finish("ok", extra),
    fail: (extra) => finish("fail", extra),
  };
}

/** Write a single, already-finished step (e.g. "info" lines or a verification result). */
export async function emitStep(
  step: StepInit & Partial<Pick<AgentStep, "status" | "latencyMs" | "tokens">>,
): Promise<AgentStep> {
  const full: AgentStep = {
    _id: randomUUID(),
    ts: new Date().toISOString(),
    status: "ok",
    ...step,
  };
  await sink(full);
  return full;
}
