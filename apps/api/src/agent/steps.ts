// AgentStep logging — every sponsor-feature call becomes one line in the Tech HUD.
//
// One push path (IMPLEMENTATION §1.4): in real mode the sink writes AgentSteps to MongoDB
// (`agent_steps`) and C's change stream relays them over SSE as `agent.step`. Every step is
// also kept in memory so scripts like hello-argon can print them.
//
// The sink must UPSERT by `_id`: a step is written once as "running" and again when it
// finishes ("ok" / "fail") so the HUD can show it live.

import { randomUUID } from "node:crypto";
import { COLLECTIONS, type AgentStep } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { env } from "../env";

export type StepSink = (step: AgentStep) => Promise<void> | void;

const memorySteps = new Map<string, AgentStep>();

const memorySink: StepSink = (step) => {
  memorySteps.set(step._id, step);
};

let warnedDbFailure = false;

/**
 * Real mode: upsert into `agent_steps`. C's change stream (events/change-streams.ts) watches
 * insert/update/replace there and relays each as SSE `agent.step` → Tech HUD.
 * A DB failure never breaks an agent run: it is logged once and the in-memory copy is kept.
 */
export const mongoStepSink: StepSink = async (step) => {
  memorySink(step);
  try {
    const db = await getDb();
    await db.collection<AgentStep>(COLLECTIONS.agentSteps).replaceOne({ _id: step._id }, step, { upsert: true });
  } catch (err) {
    if (!warnedDbFailure) {
      warnedDbFailure = true;
      console.warn(`[agent] could not save AgentStep to MongoDB (kept in memory): ${(err as Error).message}`);
    }
  }
};

/** MongoDB when MOCK !== "1" and MONGODB_URI is set; otherwise in memory only. */
let sink: StepSink = !env.mock && env.mongodbUri ? mongoStepSink : memorySink;

/** Override the sink (tests, or a mock-mode relay). */
export function setStepSink(next: StepSink): void {
  sink = next;
}

/** Steps recorded in memory this process, oldest first. Useful in mock mode and scripts. */
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
