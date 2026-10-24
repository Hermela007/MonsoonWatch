// The two Gemini planners behind the orchestrator. Kept behind a small interface (AgentAI) so the
// plan → verify → replan loop can be tested without network calls (orchestrator.test.ts).
//
//   planSituation: Gemini 4 Argon, thinking "high" — whole region in one context.
//   planVillage:   Gemini 3.8 Flash, one per village, in parallel — tools: list_evac_centres,
//                  plan_route, suggest_pickups. Replans continue the same interaction with the
//                  failure reasons (previous_interaction_id), tools re-specified each turn.

import { readFileSync } from "node:fs";
import type { Village } from "@monsoonwatch/shared";
import { interactJson } from "./gemini";
import { haversineKm } from "./geo";
import { MODELS } from "./models";
import { planRoute, type RoadGraph, type RouteMode } from "./route";
import { OrchestratorPlanSchema, VillagePlanSchema, type AtRiskVillage, type OrchestratorPlan, type VillagePlan } from "./schemas";
import { situationForPrompt, type Situation } from "./situation";
import { runWithTools, type AgentTool } from "./tool-loop";
import { suggestPickups } from "./vulnerable";

const prompt = (name: string) => readFileSync(new URL(`./prompts/${name}.md`, import.meta.url), "utf8");

export interface VillageTask {
  runId: string;
  situation: Situation;
  graph: RoadGraph;
  village: Village;
  atRisk: AtRiskVillage;
}

export interface AgentAI {
  planSituation(runId: string, situation: Situation): Promise<OrchestratorPlan>;
  /** `feedback` = failure reasons from the checks (replan); `continueFrom` = previous interaction id. */
  planVillage(task: VillageTask, feedback?: { reasons: string; continueFrom?: string }): Promise<{ plan: VillagePlan; interactionId?: string }>;
}

const tag = (s: Situation) => (s.isTestData ? " [TEST DATA]" : "");

function villageTools(task: VillageTask): AgentTool[] {
  const { situation: s, graph, village } = task;
  return [
    {
      actor: "Evac centre lookup",
      decl: {
        type: "function",
        name: "list_evac_centres",
        description: "Evacuation centres with free places and straight-line distance from the village, nearest first.",
        parameters: { type: "object", properties: {}, required: [] },
      },
      run: () =>
        s.centres
          .map((c) => ({
            id: c._id, name: c.name, capacity: c.capacity, headcount: c.headcount,
            freePlaces: c.capacity - c.headcount, elevationM: c.elevationM,
            distanceKm: Math.round(haversineKm(village.location.coordinates, c.location.coordinates) * 10) / 10,
          }))
          .sort((a, b) => a.distanceKm - b.distanceKm),
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
  ];
}

export const geminiAI: AgentAI = {
  async planSituation(runId, situation) {
    const { data } = await interactJson({
      runId,
      model: MODELS.argon,
      thinkingLevel: "high",
      kind: "plan",
      summary: `Orchestrating ${situation.villages.length} villages, ${situation.riskEvents.length} risk events${tag(situation)}`,
      systemInstruction: prompt("orchestrator"),
      input: JSON.stringify(situationForPrompt(situation)),
      schema: OrchestratorPlanSchema,
    });
    return data;
  },

  async planVillage(task, feedback) {
    const { runId, situation: s, village, atRisk } = task;
    const input = feedback
      ? `Verification FAILED. Fix exactly these problems and return the whole corrected plan:\n${feedback.reasons}`
      : JSON.stringify({
          village: { id: village._id, name: village.name, population: village.population, vulnerable: village.vulnerable ?? null },
          hazard: atRisk.hazard, level: atRisk.level, etaHours: atRisk.etaHours, leadPlannerReasoning: atRisk.reasoning,
          languages: s.region.languages, maxMessageChars: 500, testData: s.isTestData,
        });
    const result = await runWithTools({
      runId,
      model: MODELS.flash,
      thinkingLevel: "medium",
      kind: feedback ? "replan" : "subagent",
      summary: `${feedback ? "Replanning" : "Planning"} ${village.name}${tag(s)}`,
      systemInstruction: prompt("village-subagent"),
      input,
      // No response_format here: combining it with function tools is not confirmed in the docs we
      // checked. The prompt asks for JSON; if the answer isn't valid, we ask once more below with
      // the schema enforced (no tools).
      previousInteractionId: feedback?.continueFrom,
      agentTools: villageTools(task),
    });
    // Final answer must be JSON; if it isn't, ask once more in the same interaction with the schema.
    const parsed = tryParse(result.text);
    if (parsed) return { plan: parsed, interactionId: result.id };
    const { data, result: fixed } = await interactJson({
      runId,
      model: MODELS.flash,
      thinkingLevel: "low",
      kind: "subagent",
      summary: `${village.name}: final plan as JSON`,
      systemInstruction: prompt("village-subagent"),
      input: "Return your final plan now, as JSON matching the schema.",
      previousInteractionId: result.id,
      schema: VillagePlanSchema,
    });
    return { plan: data, interactionId: fixed.id };
  },
};

function tryParse(text: string | null): VillagePlan | null {
  if (!text) return null;
  const json = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    const r = VillagePlanSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
