// B2 + B3 — the agent run (GUIDELINES §6.3):
//
//   Argon reads the whole situation → at-risk villages
//     → per village, in parallel:
//         attempt 1: Flash-Lite quick draft (no tools, no flood info)  → 6 checks
//         attempts 2–4: Flash with tools refines, using the failure reasons → 6 checks
//     → "verified" alert, waiting for a human to approve (nothing is sent here).
//
// Every step is an AgentStep (Tech HUD). Alerts are saved after each attempt so the UI can show
// the red ticks turning green.

import { randomUUID } from "node:crypto";
import type { AgentRun, Alert } from "@monsoonwatch/shared";
import { buildAndVerifyVillage, replanFeedback } from "./build-alerts";
import { geminiAI, type AgentAI, type RefineFeedback } from "./gemini-planners";
import type { VillagePlan } from "./schemas";
import { buildRoadGraph } from "./route";
import type { Situation } from "./situation";
import { emitStep } from "./steps";
import { defaultStore, type AgentStore } from "./store";
import { logVerification } from "./verify-log";

/** Flash refinements after the draft (the brief's "up to 3 tries"). */
export const MAX_REFINES = 3;
export const MAX_ATTEMPTS = 1 + MAX_REFINES;
/** Villages planned per run (most urgent first) — bounds cost, rate limits and HUD noise. */
export const MAX_VILLAGES_PER_RUN = 6;

const URGENCY: Record<string, number> = { danger: 3, warning: 2, alert: 1 };

export interface RunOptions {
  situation: Situation;
  trigger: AgentRun["trigger"];
  runId?: string;
  ai?: AgentAI;
  store?: AgentStore;
}

export interface VillageOutcome {
  villageId: string;
  villageName: string;
  attempts: number;
  passed: boolean;
  alerts: Alert[];
}

/** Starts a run and returns its id immediately; the work continues in the background. */
export function startAgentRun(opts: RunOptions): string {
  const runId = opts.runId ?? `run-${randomUUID()}`;
  void runAgent({ ...opts, runId }).catch((err) => console.error(`[agent] run ${runId} failed:`, (err as Error).message));
  return runId;
}

export async function runAgent(opts: RunOptions): Promise<{ run: AgentRun; outcomes: VillageOutcome[] }> {
  const { situation: s, trigger, ai = geminiAI, store = defaultStore() } = opts;
  const runId = opts.runId ?? `run-${randomUUID()}`;
  const run: AgentRun = { _id: runId, regionId: s.region._id, trigger, status: "running", startedAt: new Date().toISOString() };
  await store.saveRun(run);
  const test = s.isTestData ? " [TEST DATA]" : "";

  try {
    // 1. Lead orchestrator
    const plan = await ai.planSituation(runId, s);
    const known = new Map(s.villages.map((v) => [v._id, v]));
    const flagged = plan.villages.filter((v) => known.has(v.villageId));
    const atRisk = [...flagged]
      .sort((a, b) => (URGENCY[b.level] ?? 0) - (URGENCY[a.level] ?? 0) || (a.etaHours ?? 999) - (b.etaHours ?? 999))
      .slice(0, MAX_VILLAGES_PER_RUN);
    if (flagged.length > atRisk.length) {
      await emitStep({
        runId, actor: "Agent", kind: "info", status: "ok",
        summary: `Argon flagged ${flagged.length} villages; planning the ${atRisk.length} most urgent now (highest level, soonest first)`,
      });
    }
    for (const bad of plan.villages.filter((v) => !known.has(v.villageId))) {
      await emitStep({ runId, actor: "Verification", kind: "verify", status: "fail", summary: `Argon named unknown village id "${bad.villageId}" — ignored` });
    }
    await emitStep({
      runId, actor: "Agent", kind: "info", status: "ok",
      summary: `Argon's assessment: ${plan.summary} → ${atRisk.length} village(s) at risk: ${atRisk.map((v) => known.get(v.villageId)!.name).join(", ") || "none"}${test}`,
    });

    // 2–3. Subagents in parallel, each with its own verify → replan loop
    const graph = buildRoadGraph(s.roads);
    const outcomes = await Promise.all(
      atRisk.map(async (a): Promise<VillageOutcome> => {
        const village = known.get(a.villageId)!;
        const task = { runId, situation: s, graph, village, atRisk: a };
        let feedback: RefineFeedback | undefined;
        let last: ReturnType<typeof buildAndVerifyVillage> | null = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          let plan: VillagePlan;
          let continuation: RefineFeedback["continuation"];
          try {
            if (attempt === 1) {
              plan = await ai.draftVillage(task);
            } else {
              ({ plan, continuation } = await ai.planVillage(task, feedback));
            }
          } catch (err) {
            const who = attempt === 1 ? "Gemini 3.5 Flash-Lite" : "Gemini 3.8 Flash";
            await emitStep({ runId, actor: who, kind: "subagent", status: "fail", summary: `${village.name}: ${attempt === 1 ? "draft" : "planning"} failed — ${(err as Error).message}`.slice(0, 200) });
            if (attempt === 1) {
              feedback = undefined; // no draft: Flash plans from scratch
              continue;
            }
            break;
          }
          last = buildAndVerifyVillage({ runId, situation: s, graph, village, atRisk: a, plan });
          for (const alert of last.alerts) await store.saveAlert(alert);
          await logVerification(runId, { villageId: village._id }, village.name, [
            ...last.planErrors.map((e) => ({ check: "route" as const, passed: false, detail: e })),
            ...last.results,
          ], attempt);

          if (last.passed) {
            await emitStep({ runId, actor: "Verification", kind: "verify", status: "ok", summary: `${village.name}: all checks passed on attempt ${attempt} → ready for approval` });
            return { villageId: village._id, villageName: village.name, attempts: attempt, passed: true, alerts: last.alerts };
          }
          feedback = { reasons: replanFeedback(last), failedPlan: plan, continuation };
        }

        await emitStep({ runId, actor: "Verification", kind: "verify", status: "fail", summary: `${village.name}: still failing after ${MAX_ATTEMPTS} attempts — needs human review (not approvable)` });
        return { villageId: village._id, villageName: village.name, attempts: MAX_ATTEMPTS, passed: false, alerts: last?.alerts ?? [] };
      }),
    );

    const ok = outcomes.filter((o) => o.passed).length;
    await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `Run finished: ${ok}/${outcomes.length} villages verified and waiting for approval${test}` });
    run.status = "done";
    run.finishedAt = new Date().toISOString();
    await store.saveRun(run);
    return { run, outcomes };
  } catch (err) {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    run.error = (err as Error).message.slice(0, 500);
    await store.saveRun(run);
    await emitStep({ runId, actor: "Agent", kind: "info", status: "fail", summary: `Run failed: ${run.error}`.slice(0, 200) });
    throw err;
  }
}
