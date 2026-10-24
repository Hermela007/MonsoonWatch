// B2 + B3 — the agent run (GUIDELINES §6.3):
//
//   deterministic risk screen (shortlist.ts) → Argon reads the shortlist → at-risk villages
//     → coverage (coverage.ts): batches of 6 Argon-confirmed villages, planned one batch after
//       another until done or stopped; every other at-risk village → area-wide district warning
//     → per village in a batch, in parallel:
//         attempt 1: Flash-Lite quick draft (no tools, no flood info)  → 6 checks
//         attempts 2–4: Flash with tools refines, using the failure reasons → 6 checks
//     → "verified" alert, waiting for a human to approve (nothing is sent here).
//
// Every step is an AgentStep (Tech HUD). Alerts are saved after each attempt so the UI can show
// the red ticks turning green.

import { randomUUID } from "node:crypto";
import type { AgentRun, Alert, Village } from "@monsoonwatch/shared";
import { buildAndVerifyVillage, replanFeedback } from "./build-alerts";
import { assignCoverage, buildAreaWarnings, coverageSummary, stopAt, type AreaWarning, type Coverage } from "./coverage";
import { geminiAI, type AgentAI, type RefineFeedback } from "./gemini-planners";
import type { AtRiskVillage, VillagePlan } from "./schemas";
import { buildRoadGraph, type RoadGraph } from "./route";
import { shortlistForArgon, shortlistSummary } from "./shortlist";
import type { Situation } from "./situation";
import { emitStep } from "./steps";
import { defaultStore, type AgentStore } from "./store";
import { logVerification } from "./verify-log";

/** Flash refinements after the draft (the brief's "up to 3 tries"). */
export const MAX_REFINES = 3;
export const MAX_ATTEMPTS = 1 + MAX_REFINES;
/** Villages planned per batch (most urgent first) — bounds rate limits and HUD noise. */
export const MAX_VILLAGES_PER_RUN = 6;

const URGENCY: Record<string, number> = { danger: 3, warning: 2, alert: 1 };

const stopRequested = new Set<string>();

/** Ask a running run to stop before its next batch; the rest moves to area-wide warnings. */
export function stopAgentRun(runId: string): void {
  stopRequested.add(runId);
}

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

export interface RunResult {
  run: AgentRun;
  outcomes: VillageOutcome[];
  coverage: Coverage;
  /** Drafts needing approval; not saved yet (shared contract pending, see coverage.ts). */
  areaWarnings: AreaWarning[];
}

/** Starts a run and returns its id immediately; the work continues in the background. */
export function startAgentRun(opts: RunOptions): string {
  const runId = opts.runId ?? `run-${randomUUID()}`;
  void runAgent({ ...opts, runId }).catch((err) => console.error(`[agent] run ${runId} failed:`, (err as Error).message));
  return runId;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { situation: s, trigger, ai = geminiAI, store = defaultStore() } = opts;
  const runId = opts.runId ?? `run-${randomUUID()}`;
  const run: AgentRun = { _id: runId, regionId: s.region._id, trigger, status: "running", startedAt: new Date().toISOString() };
  await store.saveRun(run);
  const test = s.isTestData ? " [TEST DATA]" : "";

  try {
    // 1. Deterministic risk screen → lead orchestrator on the shortlist
    const shortlist = shortlistForArgon(s);
    await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `${shortlistSummary(shortlist)}${test}`.slice(0, 300) });
    const plan = await ai.planSituation(runId, s, shortlist);
    const known = new Map(s.villages.map((v) => [v._id, v]));
    const confirmed = plan.villages
      .filter((v) => known.has(v.villageId))
      .sort((a, b) => (URGENCY[b.level] ?? 0) - (URGENCY[a.level] ?? 0) || (a.etaHours ?? 999) - (b.etaHours ?? 999));
    const claims = new Map(confirmed.map((v) => [v.villageId, v]));
    for (const bad of plan.villages.filter((v) => !known.has(v.villageId))) {
      await emitStep({ runId, actor: "Verification", kind: "verify", status: "fail", summary: `Argon named unknown village id "${bad.villageId}" — ignored` });
    }
    await emitStep({
      runId, actor: "Agent", kind: "info", status: "ok",
      summary: `Argon's assessment: ${plan.summary} → ${claims.size} village(s) at risk: ${[...claims.keys()].map((id) => known.get(id)!.name).join(", ") || "none"}${test}`,
    });

    // 2. Coverage: batches of Argon-confirmed villages; every other at-risk village → area-wide warning
    let coverage = assignCoverage(shortlist.screen.atRisk, [...claims.keys()], MAX_VILLAGES_PER_RUN);
    await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `${coverageSummary(coverage, shortlist.screen.atRisk.length)}${test}` });

    // 3. Subagents, one batch after another; within a batch in parallel, each with its own verify → replan loop
    const graph = buildRoadGraph(s.roads);
    const outcomes: VillageOutcome[] = [];
    for (let b = 0; b < coverage.batches.length; b++) {
      if (stopRequested.has(runId)) {
        const moved = coverage.batches.slice(b).flat().length;
        coverage = stopAt(coverage, b, shortlist.screen.atRisk);
        await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `Stopped before batch ${b + 1}: ${moved} queued village(s) moved to area-wide warnings` });
        break;
      }
      const batch = coverage.batches[b]!;
      if (b > 0) await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `Batch ${b + 1}/${coverage.batches.length}: planning ${batch.length} queued village(s)` });
      outcomes.push(...(await Promise.all(batch.map((id) => planOneVillage({ runId, s, graph, ai, store, village: known.get(id)!, atRisk: claims.get(id)! })))));
    }

    // 4. Area-wide warnings (template, no AI) — drafts for a human to approve
    const areaWarnings = buildAreaWarnings(coverage.areaWide, { regionId: s.region._id, runId, languages: s.region.languages });
    for (const w of areaWarnings) {
      await emitStep({
        runId, actor: "Agent", kind: "info", status: "ok",
        summary: `Area-wide ${w.level.toUpperCase()} ${w.hazard} warning drafted for ${w.district}: ${w.villageIds.length} villages, ${w.people.toLocaleString()} people (template, no AI; needs approval)${test}`,
      });
    }

    const ok = outcomes.filter((o) => o.passed).length;
    await emitStep({
      runId, actor: "Agent", kind: "info", status: "ok",
      summary: `Run finished: ${ok}/${outcomes.length} villages verified and waiting for approval; ${areaWarnings.length} area-wide warning(s) drafted${test}`,
    });
    run.status = "done";
    run.finishedAt = new Date().toISOString();
    await store.saveRun(run);
    return { run, outcomes, coverage, areaWarnings };
  } catch (err) {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    run.error = (err as Error).message.slice(0, 500);
    await store.saveRun(run);
    await emitStep({ runId, actor: "Agent", kind: "info", status: "fail", summary: `Run failed: ${run.error}`.slice(0, 200) });
    throw err;
  } finally {
    stopRequested.delete(runId);
  }
}

interface VillageJob {
  runId: string;
  s: Situation;
  graph: RoadGraph;
  ai: AgentAI;
  store: AgentStore;
  village: Village;
  atRisk: AtRiskVillage;
}

/** Draft (Flash-Lite) → checks → up to MAX_REFINES Flash refinements for one village. */
async function planOneVillage({ runId, s, graph, ai, store, village, atRisk: a }: VillageJob): Promise<VillageOutcome> {
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
}
