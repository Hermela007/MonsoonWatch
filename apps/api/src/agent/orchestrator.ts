// B2 + B3 — the agent run (GUIDELINES §6.3). EVERY at-risk village ends with an alert:
//
//   deterministic risk screen (shortlist.ts) → Argon reads the shortlist (assessment, ETAs, order)
//     → rules planner (rules-planner.ts, no Gemini): every at-risk village, most urgent first —
//       nearest usable centre by dry road (else by boat), capacity booked across villages, pickups,
//       template message, the same 6 checks → "verified" alerts (ids tagged ":rules:")
//     → Gemini, capped (coverage.ts selectForGemini): villages the rules couldn't plan (no road or
//       boat route, no centre with space, conflicting signals, a failed check) + the top 5 for tailored
//       messages, in batches of 6 until done or stopped. Per village:
//         attempt 1: Flash-Lite quick draft (no tools, no flood info)  → 6 checks
//         attempts 2–4: Flash with tools refines, using the failure reasons → 6 checks
//       A tailored village keeps its rules alert if Gemini's plan fails.
//     → area-wide district warning (template, no Gemini) only for anything still unplanned.
//   Nothing is sent here: every alert waits for a human to approve it.
//
// Every step is an AgentStep (Tech HUD). Alerts are saved after each attempt so the UI can show
// the red ticks turning green.

import { randomUUID } from "node:crypto";
import type { AgentRun, Alert, Village } from "@monsoonwatch/shared";
import { buildAndVerifyVillage, replanFeedback } from "./build-alerts";
import { GEMINI_DEFAULTS, buildAreaWarnings, countBy, coverageSummary, rulesSummary, selectForGemini, type AreaWarning, type PlannedBy } from "./coverage";
import { geminiAI, type AgentAI, type RefineFeedback } from "./gemini-planners";
import { planAllByRules, type GeminiReason } from "./rules-planner";
import type { AtRiskVillage, VillagePlan } from "./schemas";
import { buildRoadGraph, type RoadGraph } from "./route";
import { shortlistForArgon, shortlistSummary, type VillageRisk } from "./shortlist";
import type { Situation } from "./situation";
import { emitStep } from "./steps";
import { defaultStore, type AgentStore } from "./store";
import { logVerification } from "./verify-log";

/** Flash refinements after the draft (the brief's "up to 3 tries"). */
export const MAX_REFINES = 3;
export const MAX_ATTEMPTS = 1 + MAX_REFINES;
/** Villages planned by Gemini in parallel per batch — bounds rate limits and HUD noise. */
export const MAX_VILLAGES_PER_RUN = 6;

const URGENCY: Record<string, number> = { danger: 3, warning: 2, alert: 1 };

const stopRequested = new Set<string>();

/** Ask a running run to stop before its next Gemini batch; unplanned villages fall back to area-wide warnings. */
export function stopAgentRun(runId: string): void {
  stopRequested.add(runId);
}

export interface RunOptions {
  situation: Situation;
  trigger: AgentRun["trigger"];
  runId?: string;
  ai?: AgentAI;
  store?: AgentStore;
  /** Most villages sent to Gemini (default GEMINI_DEFAULTS.cap / AGENT_GEMINI_MAX_VILLAGES). */
  geminiCap?: number;
  /** Top villages by urgency that get a Gemini-tailored message (default 5). */
  tailorTop?: number;
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
  /** Gemini-planned villages (fixes + tailored), verified or not. */
  outcomes: VillageOutcome[];
  /** Verified alerts planned by code (ids tagged ":rules:"). */
  rulesAlerts: Alert[];
  /** Who ended up covering each at-risk village. */
  plannedBy: Map<string, PlannedBy>;
  /** Fallback drafts needing approval; not saved yet (shared contract pending, see coverage.ts). */
  areaWarnings: AreaWarning[];
  atRisk: number;
}

/** Starts a run and returns its id immediately; the work continues in the background. */
export function startAgentRun(opts: RunOptions): string {
  const runId = opts.runId ?? `run-${randomUUID()}`;
  void runAgent({ ...opts, runId }).catch((err) => console.error(`[agent] run ${runId} failed:`, (err as Error).message));
  return runId;
}

const allocOf = (alerts: Alert[]) => {
  const m = new Map<string, number>();
  for (const a of alerts) m.set(a.evacCentreId, (m.get(a.evacCentreId) ?? 0) + a.people);
  return m;
};

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { situation: s, trigger, ai = geminiAI, store = defaultStore() } = opts;
  const cap = opts.geminiCap ?? GEMINI_DEFAULTS.cap;
  const tailorTop = opts.tailorTop ?? GEMINI_DEFAULTS.tailorTop;
  const runId = opts.runId ?? `run-${randomUUID()}`;
  const run: AgentRun = { _id: runId, regionId: s.region._id, trigger, status: "running", startedAt: new Date().toISOString() };
  await store.saveRun(run);
  const test = s.isTestData ? " [TEST DATA]" : "";

  try {
    // 1. Deterministic risk screen → lead orchestrator on the shortlist
    const shortlist = shortlistForArgon(s);
    const atRisk = shortlist.screen.atRisk;
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
      summary: `Argon's assessment: ${plan.summary} → ${claims.size} village(s) prioritised: ${[...claims.keys()].map((id) => known.get(id)!.name).join(", ") || "none"}${test}`,
    });
    const screened = new Set(atRisk.map((r) => r.village._id));
    const outside = [...claims.keys()].filter((id) => !screened.has(id));
    if (outside.length) {
      await emitStep({
        runId, actor: "Agent", kind: "info", status: "ok",
        summary: `Argon named ${outside.length} village(s) without deterministic evidence (${outside.map((id) => known.get(id)!.name).join(", ")}) — not alerted; check manually`.slice(0, 300),
      });
    }

    // 2. Rules planner: every at-risk village, no Gemini
    const graph = buildRoadGraph(s.roads);
    const t0 = Date.now();
    const { results, ledger } = planAllByRules({ runId, situation: s, graph }, atRisk, claims);
    await emitStep({ runId, actor: "Rules planner", kind: "verify", status: "ok", latencyMs: Date.now() - t0, summary: `${rulesSummary(results)}${test}` });

    const plannedBy = new Map<string, PlannedBy>();
    const rulesAlerts: Alert[] = [];
    const fallback: VillageRisk[] = [];
    const byVillage = new Map(results.map((r) => [r.risk.village._id, r]));
    const { picks, overCap } = selectForGemini(results, { cap, tailorTop, preferred: [...claims.keys()] });
    const tailored = new Set(picks.filter((p) => p.why === "tailor").map((p) => p.risk.village._id));
    const keepRules = async (id: string): Promise<boolean> => {
      const r = byVillage.get(id);
      if (!r?.ok) return false;
      for (const a of r.built.alerts) await store.saveAlert(a);
      rulesAlerts.push(...r.built.alerts);
      plannedBy.set(id, "rules");
      return true;
    };
    for (const r of results) {
      if (r.ok && !tailored.has(r.risk.village._id)) await keepRules(r.risk.village._id);
      else if (!r.ok && r.to === "fallback") fallback.push(r.risk);
    }
    fallback.push(...overCap.map((f) => f.risk));
    const fixes = picks.filter((p) => p.why === "fix");
    const reasons = Object.entries(countBy<GeminiReason>(fixes.map((f) => f.reason!))).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ");
    await emitStep({
      runId, actor: "Agent", kind: "info", status: "ok",
      summary: `To Gemini (cap ${cap}): ${fixes.length} village(s) the rules couldn't plan${reasons ? ` (${reasons})` : ""} + ` +
        `${tailored.size} top village(s) for tailored messages; ${overCap.length} over the cap → area-wide fallback${test}`,
    });

    // 3. Gemini, one batch after another; within a batch in parallel, each with its own verify → replan loop
    const outcomes: VillageOutcome[] = [];
    const ownOf = (id: string) => {
      const r = byVillage.get(id);
      return r?.ok && tailored.has(id) ? r.alloc : undefined; // a tailored village may reuse its own rules booking
    };
    const batches = Math.ceil(picks.length / MAX_VILLAGES_PER_RUN);
    for (let b = 0; b < batches; b++) {
      const batch = picks.slice(b * MAX_VILLAGES_PER_RUN, (b + 1) * MAX_VILLAGES_PER_RUN);
      if (stopRequested.has(runId)) {
        const rest = picks.slice(b * MAX_VILLAGES_PER_RUN);
        for (const p of rest) if (!(p.why === "tailor" && (await keepRules(p.risk.village._id)))) fallback.push(p.risk);
        await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `Stopped before Gemini batch ${b + 1}: ${rest.length} village(s) keep their rules alert or fall back to area-wide warnings` });
        break;
      }
      if (b > 0) await emitStep({ runId, actor: "Agent", kind: "info", status: "ok", summary: `Gemini batch ${b + 1}/${batches}: ${batch.length} village(s)` });
      const outs = await Promise.all(batch.map((p) => planOneVillage({
        runId, s: { ...s, centres: ledger.view(ownOf(p.risk.village._id)) }, graph, ai, store,
        village: p.risk.village, atRisk: claims.get(p.risk.village._id) ?? p.claim,
      })));
      // Commit in urgency order against the live ledger: parallel plans must not double-book a centre.
      for (const [i, p] of batch.entries()) {
        const o = outs[i]!;
        const id = p.risk.village._id;
        const own = ownOf(id);
        const alloc = allocOf(o.alerts);
        if (o.passed && ledger.fits(alloc, own)) {
          if (own) ledger.release(own);
          ledger.book(alloc);
          plannedBy.set(id, "gemini");
        } else {
          if (o.passed) {
            o.passed = false;
            for (const a of o.alerts) {
              a.status = "draft";
              a.verification.push({ check: "capacity", passed: false, detail: "A centre in this plan was filled by other villages in the same run — not approvable" });
              await store.saveAlert(a);
            }
            await emitStep({ runId, actor: "Verification", kind: "verify", status: "fail", summary: `${o.villageName}: Gemini plan double-books a centre already allocated this run — rejected` });
          }
          if (!(p.why === "tailor" && (await keepRules(id)))) fallback.push(p.risk);
        }
        outcomes.push(o);
      }
    }

    // 4. Fallback: area-wide district warnings (template, no AI) for anything still unplanned
    for (const f of fallback) plannedBy.set(f.village._id, "area-wide");
    const areaWarnings = buildAreaWarnings(fallback, { regionId: s.region._id, runId, languages: s.region.languages });
    for (const w of areaWarnings) {
      await emitStep({
        runId, actor: "Agent", kind: "info", status: "ok",
        summary: `Fallback: area-wide ${w.level.toUpperCase()} ${w.hazard} warning drafted for ${w.district}: ${w.villageIds.length} villages, ${w.people.toLocaleString()} people (template, no AI; needs approval)${test}`,
      });
    }
    await emitStep({ runId, actor: "Agent", kind: "info", status: plannedBy.size === atRisk.length ? "ok" : "fail", summary: `${coverageSummary(plannedBy, atRisk.length)}${test}` });

    const geminiVerified = outcomes.filter((o) => o.passed).reduce((n, o) => n + o.alerts.length, 0);
    await emitStep({
      runId, actor: "Agent", kind: "info", status: "ok",
      summary: `Run finished: ${rulesAlerts.length + geminiVerified} verified alert(s) waiting for approval (${rulesAlerts.length} by rules, ${geminiVerified} by Gemini); ${areaWarnings.length} area-wide warning(s) drafted${test}`,
    });
    run.status = "done";
    run.finishedAt = new Date().toISOString();
    await store.saveRun(run);
    return { run, outcomes, rulesAlerts, plannedBy, areaWarnings, atRisk: atRisk.length };
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
