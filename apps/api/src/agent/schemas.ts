// Structured outputs from Gemini, validated with zod (CLAUDE.md). The JSON Schema sent to Gemini
// is generated from these (gemini.ts → z.toJSONSchema), so there is one source of truth.

import { z } from "zod";

// Lead orchestrator (Gemini 4 Argon): which villages are at risk, from what, how soon.
export const AtRiskVillageSchema = z.object({
  villageId: z.string().describe("Exact id from the villages list"),
  hazard: z.enum(["flood", "landslide"]),
  level: z.enum(["alert", "warning", "danger"]),
  etaHours: z.number().nullable().describe("Hours until the hazard reaches the village; null if already there or unknown"),
  stationId: z.string().nullable().describe("River station whose reading supports a flood claim; null for landslide"),
  riskEventIds: z.array(z.string()).describe("Ids of the risk events this claim relies on"),
  reasoning: z.string().describe("One or two sentences for the official, citing readings or documents"),
});
export type AtRiskVillage = z.infer<typeof AtRiskVillageSchema>;

export const OrchestratorPlanSchema = z.object({
  summary: z.string().describe("One-line situation summary for the Tech HUD"),
  villages: z.array(AtRiskVillageSchema),
});
export type OrchestratorPlan = z.infer<typeof OrchestratorPlanSchema>;

// Per-village subagent (Gemini 3.8 Flash): who goes where, how, and the alert text.
export const PickupSchema = z.object({
  category: z.enum(["bedridden", "disabled", "elderly", "noTransport"]),
  people: z.number().int().min(1),
  vehicle: z.enum(["boat", "4x4", "ambulance", "bus"]),
  order: z.number().int().min(1).describe("1-based pickup order across ALL groups of this village"),
});

export const VillageGroupSchema = z.object({
  evacCentreId: z.string().describe("Exact id from list_evac_centres"),
  people: z.number().int().min(1).describe("How many residents this group sends to the centre"),
  routeMode: z.enum(["road", "boat"]).describe("Use plan_route to choose; boat if the road route crosses floodwater"),
  pickups: z.array(PickupSchema).describe("Vulnerable-people pickups carried by this group"),
  messages: z.array(z.object({ lang: z.string(), text: z.string() })).describe("Alert text, one per region language"),
});

export const VillagePlanSchema = z.object({
  groups: z.array(VillageGroupSchema).min(1),
  reasoning: z.string().describe("One or two sentences: why these centres, modes and pickup order"),
});
export type VillagePlan = z.infer<typeof VillagePlanSchema>;
export type VillageGroup = z.infer<typeof VillageGroupSchema>;
