// Turns a subagent's VillagePlan into Alert drafts and verifies them. Deterministic, no LLM:
// routes come from planRoute (never from the model), and every check result is attached.

import type { Alert, EvacCentre, VerificationResult, Village } from "@monsoonwatch/shared";
import { planRoute, type RoadGraph, type RouteResult } from "./route";
import type { AtRiskVillage, VillagePlan } from "./schemas";
import type { Situation } from "./situation";
import { checkVillageSplit, verifyAlert, type VerifyContext } from "./verify";
import { checkVulnerable } from "./vulnerable";

export interface BuiltVillage {
  alerts: Alert[];
  routes: RouteResult[];
  /** Problems found before the checks could even run (e.g. an unknown centre id). */
  planErrors: string[];
  /** All results for this village (per-alert checks, then the village-level ones). */
  results: VerificationResult[];
  passed: boolean;
}

export function buildAndVerifyVillage(args: {
  runId: string;
  situation: Situation;
  graph: RoadGraph;
  village: Village;
  atRisk: AtRiskVillage;
  plan: VillagePlan;
  /** Rules planner: routes it already found (same planner, same graph) — reused, not re-planned. */
  routes?: (RouteResult | undefined)[];
  /** Alert id tag, e.g. "rules" → `${runId}:${villageId}:rules:1` (planned by code, not Gemini). */
  idTag?: string;
}): BuiltVillage {
  const { runId, situation: s, graph, village, atRisk, plan } = args;
  const planErrors: string[] = [];
  const alerts: Alert[] = [];
  const routes: RouteResult[] = [];
  const results: VerificationResult[] = [];
  const centresUsed: EvacCentre[] = [];

  const station = atRisk.stationId ? s.stations.find((st) => st._id === atRisk.stationId) : undefined;
  const cited = s.riskEvents.filter((e) => atRisk.riskEventIds.includes(e._id));
  const riskEvents = cited.length ? cited : s.riskEvents.filter((e) => station && e.stationId === station._id);

  plan.groups.forEach((g, i) => {
    const centre = s.centres.find((c) => c._id === g.evacCentreId);
    if (!centre) {
      planErrors.push(`group ${i + 1}: unknown evacuation centre id "${g.evacCentreId}" — use an id from list_evac_centres`);
      return;
    }
    centresUsed.push(centre);
    const route = args.routes?.[i] ?? planRoute(graph, s.hazards.blockedRoadIds, village.location.coordinates, centre.location.coordinates, g.routeMode);
    routes.push(route);

    const alert: Alert = {
      _id: `${runId}:${village._id}:${args.idTag ? `${args.idTag}:` : ""}${i + 1}`,
      regionId: s.region._id,
      runId,
      villageId: village._id,
      level: atRisk.level,
      hazard: atRisk.hazard,
      ...(atRisk.etaHours !== null ? { etaHours: atRisk.etaHours } : {}),
      evacCentreId: centre._id,
      people: g.people,
      pickups: g.pickups,
      route: { type: "LineString", coordinates: route.coordinates },
      // Boat: `route` follows roads as a stand-in, NOT a boat path — the UI draws no line (no navigable-water data).
      routeMode: route.mode === "boat" ? "boat" : "road",
      plannedBy: args.idTag === "rules" ? "rules" : "gemini",
      messages: g.messages,
      verification: [],
      status: "draft",
    };

    const ctx: VerifyContext = {
      region: s.region,
      mode: s.mode,
      now: s.now,
      village,
      centre,
      evidence: { station, latestReading: station?.latest ?? undefined, riskEvents },
      hazards: s.hazards,
      route: { mode: route.mode, segmentIds: route.segmentIds },
    };
    const perAlert = verifyAlert(alert, ctx);
    if (!route.found) {
      perAlert.push({ check: "route", passed: false, detail: `${centre.name}: ${route.note}` });
    }
    // Never send people into a centre C's flood model marks at risk at this time.
    if (s.centreStatusById?.get(centre._id) === "at_risk") {
      perAlert.push({ check: "capacity", passed: false, detail: `${centre.name} is at risk of flooding at this time (flood model) — choose another centre` });
    }
    alert.verification = perAlert;
    alerts.push(alert);
    results.push(...perAlert.map((r) => ({ ...r, detail: `[${centre.name}] ${r.detail}` })));
  });

  if (alerts.length) {
    const split = checkVillageSplit(alerts, village, centresUsed);
    const vulnerable = checkVulnerable(
      alerts.map((a, i) => ({ ...a, routeCrossesFlood: routes[i]!.crossesFlood })),
      village,
      { routeCrossesFlood: false },
    );
    for (const a of alerts) a.verification.push(split, vulnerable);
    results.push(split, vulnerable);
  }

  const passed = planErrors.length === 0 && alerts.length > 0 && results.every((r) => r.passed);
  for (const a of alerts) a.status = passed ? "verified" : "draft";
  return { alerts, routes, planErrors, results, passed };
}

/** Bullet list for the replan prompt. */
export function replanFeedback(b: BuiltVillage): string {
  const lines = [...b.planErrors.map((e) => `- plan: ${e}`), ...b.results.filter((r) => !r.passed).map((r) => `- ${r.check}: ${r.detail}`)];
  return lines.join("\n");
}
