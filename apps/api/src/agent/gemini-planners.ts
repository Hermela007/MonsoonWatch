// The Gemini planners behind the orchestrator, behind a small interface (AgentAI) so the
// draft → verify → refine loop can be tested without network calls (orchestrator.test.ts).
//
//   planSituation: Gemini 4 Argon, thinking "high" — whole region in one context.
//   draftVillage:  Gemini 3.5 Flash-Lite, no tools — a fast first plan per village. It has no
//                  road/flood information, so the checks genuinely catch its mistakes.
//   planVillage:   Gemini 3.8 Flash, thinking "low", tools list_evac_centres, plan_route,
//                  suggest_pickups, and submit_plan (the plan arrives as a validated tool call).
//                  A replan answers that submit_plan call with the verification failures, in the
//                  same interaction (previous_interaction_id), so Flash fixes its own plan.

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Village } from "@monsoonwatch/shared";
import { interactJson } from "./gemini";
import { haversineKm } from "./geo";
import { MODELS } from "./models";
import { GEMINI_CENTRES_SHOWN } from "./rules-planner";
import { planRoute, type RoadGraph, type RouteMode } from "./route";
import { OrchestratorPlanSchema, VillagePlanSchema, type AtRiskVillage, type OrchestratorPlan, type VillagePlan } from "./schemas";
import type { Shortlist } from "./shortlist";
import { situationForPrompt, type Situation } from "./situation";
import { runWithTools, submitResult, type AgentTool, type ToolLoopResult } from "./tool-loop";
import { suggestPickups } from "./vulnerable";

const prompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");

export interface VillageTask {
  runId: string;
  situation: Situation;
  graph: RoadGraph;
  village: Village;
  atRisk: AtRiskVillage;
}

/** Opaque handle to continue a Flash interaction (its open submit_plan call). */
export interface VillageContinuation {
  interactionId: string;
  submitted: NonNullable<ToolLoopResult["submitted"]>;
}

export interface RefineFeedback {
  /** Bullet list of failed checks. */
  reasons: string;
  /** The plan that failed (the draft, on the first refine). */
  failedPlan?: VillagePlan;
  continuation?: VillageContinuation;
}

export interface AgentAI {
  /** Argon sees the deterministic shortlist; the checks still use the full Situation. */
  planSituation(runId: string, situation: Situation, shortlist: Shortlist): Promise<OrchestratorPlan>;
  draftVillage(task: VillageTask): Promise<VillagePlan>;
  planVillage(task: VillageTask, feedback?: RefineFeedback): Promise<{ plan: VillagePlan; continuation?: VillageContinuation }>;
}

const tag = (s: Situation) => (s.isTestData ? " [TEST DATA]" : "");

/** Nearest centres only (the real region has hundreds): keeps prompts and tool output small. */
export const MAX_CENTRES_SHOWN = GEMINI_CENTRES_SHOWN;

function centresFor(s: Situation, village: Village) {
  return s.centres
    .map((c) => ({
      id: c._id, name: c.name, capacity: c.capacity, headcount: c.headcount,
      freePlaces: c.capacity - c.headcount, elevationM: c.elevationM,
      distanceKm: Math.round(haversineKm(village.location.coordinates, c.location.coordinates) * 10) / 10,
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, MAX_CENTRES_SHOWN);
}

function villageBrief(task: VillageTask) {
  const { situation: s, village, atRisk } = task;
  return {
    village: { id: village._id, name: village.name, population: village.population, vulnerable: village.vulnerable ?? null },
    hazard: atRisk.hazard, level: atRisk.level, etaHours: atRisk.etaHours, leadPlannerReasoning: atRisk.reasoning,
    languages: s.region.languages, maxMessageChars: 500, testData: s.isTestData,
  };
}

// JSON Schema for submit_plan's parameters, generated from the same zod schema we validate with.
const { $schema: _drop, ...PLAN_PARAMS } = z.toJSONSchema(VillagePlanSchema) as Record<string, unknown>;

function villageTools(task: VillageTask): AgentTool[] {
  const { situation: s, graph, village } = task;
  return [
    {
      actor: "Evac centre lookup",
      decl: {
        type: "function",
        name: "list_evac_centres",
        description: `The ${MAX_CENTRES_SHOWN} nearest evacuation centres with free places and straight-line distance from the village, nearest first.`,
        parameters: { type: "object", properties: {}, required: [] },
      },
      run: () => centresFor(s, village),
      describe: (_a, r) => `${village.name}: ${(r as unknown[]).length} centres listed`,
    },
    {
      actor: "Route planner",
      decl: {
        type: "function",
        name: "plan_route",
        description: "Deterministic route from the village to a centre. mode 'road' avoids flooded segments; 'boat' may cross them.",
        parameters: {
          type: "object",
          properties: {
            evacCentreId: { type: "string", description: "Centre id from list_evac_centres" },
            mode: { type: "string", enum: ["road", "boat"] },
          },
          required: ["evacCentreId", "mode"],
        },
      },
      run: (args) => {
        const centre = s.centres.find((c) => c._id === args.evacCentreId);
        if (!centre) return { error: `Unknown centre id ${String(args.evacCentreId)}` };
        const r = planRoute(graph, s.hazards.blockedRoadIds, village.location.coordinates, centre.location.coordinates, args.mode as RouteMode);
        return { found: r.found, mode: r.mode, lengthKm: r.lengthKm, crossesFlood: r.crossesFlood, note: r.note };
      },
      describe: (args, r) => {
        const res = r as { found?: boolean; lengthKm?: number; note?: string };
        return `${village.name} → ${String(args.evacCentreId)} by ${String(args.mode)}: ${res.found ? `${res.lengthKm} km` : "no route"} · ${res.note ?? ""}`;
      },
    },
    {
      actor: "Vulnerable-people planner",
      decl: {
        type: "function",
        name: "suggest_pickups",
        description: "Baseline pickup order for the village's vulnerable residents (counts only).",
        parameters: {
          type: "object",
          properties: { routeCrossesFlood: { type: "boolean", description: "True if the route used crosses floodwater (boats only)" } },
          required: ["routeCrossesFlood"],
        },
      },
      run: (args) => suggestPickups(village, Boolean(args.routeCrossesFlood)),
      describe: (_a, r) => `${village.name}: ${(r as unknown[]).length} pickup groups suggested`,
    },
    {
      actor: "Gemini 3.8 Flash",
      submit: true,
      decl: {
        type: "function",
        name: "submit_plan",
        description: "Submit your final evacuation plan for this village. It is checked by code; you will get the verdict back.",
        parameters: PLAN_PARAMS,
      },
      run: (args) => {
        const r = VillagePlanSchema.safeParse(args);
        if (!r.success) throw new Error(`Plan does not match the schema: ${z.prettifyError(r.error).slice(0, 600)}`);
        return r.data;
      },
      describe: (_a, r) => `${village.name}: plan submitted (${(r as VillagePlan).groups.length} group(s)) → verifying`,
    },
  ];
}

export const geminiAI: AgentAI = {
  async planSituation(runId, situation, shortlist) {
    const { data } = await interactJson({
      runId,
      model: MODELS.argon,
      thinkingLevel: "high",
      kind: "plan",
      summary: `Orchestrating ${shortlist.villages.length} shortlisted villages (of ${situation.villages.length}), ${situation.riskEvents.length} risk events${tag(situation)}`,
      systemInstruction: prompt("orchestrator"),
      input: JSON.stringify(situationForPrompt(situation, { shortlist })),
      schema: OrchestratorPlanSchema,
    });
    return data;
  },

  async draftVillage(task) {
    const { data } = await interactJson({
      runId: task.runId,
      model: MODELS.flashLite,
      thinkingLevel: "low",
      kind: "subagent",
      summary: `Quick draft for ${task.village.name}${tag(task.situation)}`,
      systemInstruction: prompt("village-draft"),
      input: JSON.stringify({ ...villageBrief(task), evacCentres: centresFor(task.situation, task.village) }),
      schema: VillagePlanSchema,
    });
    return data;
  },

  async planVillage(task, feedback) {
    const { runId, situation: s, village } = task;
    const tools = villageTools(task);
    const base = {
      runId,
      model: MODELS.flash,
      thinkingLevel: "low" as const,
      systemInstruction: prompt("village-subagent"),
      agentTools: tools,
    };
    const verdict = feedback
      ? `VERIFICATION FAILED. Fix exactly these problems, use the tools to check, then call submit_plan again with the whole corrected plan:\n${feedback.reasons}`
      : "";

    let result: ToolLoopResult | undefined;
    if (feedback?.continuation) {
      // Answer our own open submit_plan call with the verdict (documented function_result pattern).
      try {
        result = await runWithTools({
          ...base, kind: "replan", summary: `Replanning ${village.name}${tag(s)}`,
          input: submitResult(feedback.continuation.submitted, verdict),
          previousInteractionId: feedback.continuation.interactionId,
        });
      } catch {
        result = undefined; // fall back to a fresh interaction below
      }
    }
    if (!result) {
      const intro = { ...villageBrief(task), ...(feedback?.failedPlan ? { previousPlanThatFailed: feedback.failedPlan } : {}) };
      result = await runWithTools({
        ...base,
        kind: feedback ? "replan" : "subagent",
        summary: `${feedback ? "Refining" : "Planning"} ${village.name}${tag(s)}`,
        input: `${JSON.stringify(intro)}${feedback ? `\n\n${verdict}` : ""}`,
      });
    }
    if (!result.submitted) {
      // Answered in text instead of calling the tool: ask once to submit.
      result = await runWithTools({
        ...base, kind: "subagent", summary: `${village.name}: asking for submit_plan`,
        input: "Call submit_plan now with your final plan.",
        previousInteractionId: result.id,
      });
    }
    if (!result.submitted) throw new Error(`${village.name}: Flash did not submit a plan`);
    return {
      plan: result.submitted.value as VillagePlan,
      continuation: { interactionId: result.id, submitted: result.submitted },
    };
  },
};
