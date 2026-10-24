// Argon's judgement, checked by code. Argon may RAISE the alarm for villages the deterministic
// screen left on an advisory — never lower it — and writes the situation report for officials.
//
// An escalation is accepted only if:
//   - the village is one the screen could not decide on ("watch": river at alert+ nearby but no
//     flooding shown at the village; "unknown": the flood model can't judge it)
//   - a flood claim cites a river station with a reading and thresholds, within MAX_STATION_KM,
//     whose level supports the claim (the same rule the threshold check uses later)
//   - any quote is found VERBATIM in the cited knowledge document (no invented history)
// Accepted villages join the at-risk list and get an individual alert from the rules planner,
// with the same 6 checks. Rejections are logged with the reason. Pure functions.

import type { StationWithLatest, Village } from "@monsoonwatch/shared";
import { haversineKm } from "./geo";
import type { AtRiskVillage, Escalation } from "./schemas";
import type { AlertLevel, RiskScreen, VillageRisk } from "./shortlist";
import type { Situation } from "./situation";
import { levelFromThresholds } from "./verify";

export const ESCALATION = { max: 15, maxStationKm: 60, minQuoteChars: 20 } as const;

const LEVEL_RANK: Record<string, number> = { normal: 0, alert: 1, warning: 2, danger: 3 };
const VULNERABLE = ["bedridden", "disabled", "elderly", "noTransport"] as const;
const norm = (t: string) => t.toLowerCase().replace(/[*_`"“”'‘’]/g, "").replace(/\s+/g, " ").trim();

export interface EscalationVerdict {
  escalation: Escalation;
  village?: Village;
  accepted: boolean;
  detail: string;
}

export function checkEscalation(e: Escalation, s: Situation, screen: Pick<RiskScreen, "watch" | "unknown" | "atRisk">): EscalationVerdict {
  const no = (detail: string, village?: Village): EscalationVerdict => ({ escalation: e, ...(village && { village }), accepted: false, detail });
  const village = s.villages.find((v) => v._id === e.villageId);
  if (!village) return no(`unknown village id "${e.villageId}"`);
  const from = screen.watch.some((w) => w.village._id === village._id) ? "watch" : screen.unknown.some((u) => u.village._id === village._id) ? "unknown" : null;
  if (!from) {
    return no(screen.atRisk.some((r) => r.village._id === village._id) ? `${village.name} is already at risk (has its own alert)` : `${village.name}: the flood model assessed its roads as clear — escalation needs a human check, not an automatic alert`, village);
  }
  let station: StationWithLatest | undefined;
  if (e.hazard === "flood") {
    station = e.stationId ? s.stations.find((st) => st._id === e.stationId) : undefined;
    if (!station?.thresholds || !station.latest) return no(`${village.name}: a flood escalation must cite a river station with a reading and thresholds`, village);
    const km = haversineKm(village.location.coordinates, station.location.coordinates);
    if (km > ESCALATION.maxStationKm) return no(`${village.name}: cited station ${station.name} is ${km.toFixed(0)} km away (max ${ESCALATION.maxStationKm})`, village);
    const actual = levelFromThresholds(station.latest.value, station.thresholds);
    if (LEVEL_RANK[actual]! < LEVEL_RANK.alert!) return no(`${village.name}: ${station.name} is ${actual.toUpperCase()} — no threshold crossed`, village);
    if (LEVEL_RANK[e.level]! > LEVEL_RANK[actual]!) return no(`${village.name}: claims ${e.level.toUpperCase()} but ${station.name} is ${actual.toUpperCase()} — overclaim`, village);
  }
  let cited = "";
  if (e.quote || e.sourceTitle) {
    const doc = s.knowledge.find((k) => norm(k.title) === norm(e.sourceTitle ?? ""));
    if (!doc) return no(`${village.name}: cited document "${e.sourceTitle}" not found`, village);
    if (!e.quote || norm(e.quote).length < ESCALATION.minQuoteChars || !norm(doc.chunk).includes(norm(e.quote))) {
      return no(`${village.name}: quote not found verbatim in "${doc.title}" — rejected (no invented history)`, village);
    }
    cited = `; cites "${doc.title}"`;
  }
  return { escalation: e, village, accepted: true, detail: `${village.name} (${from} → ${e.level.toUpperCase()} ${e.hazard})${station ? ` on ${station.name}` : ""}${cited}` };
}

/** Accepted escalations as at-risk villages (for the rules planner) + Argon's claims for them. */
export function applyEscalations(verdicts: EscalationVerdict[]): { risks: VillageRisk[]; claims: AtRiskVillage[] } {
  const seen = new Set<string>();
  const ok = verdicts.filter((v) => v.accepted && v.village && !seen.has(v.village._id) && seen.add(v.village._id)).slice(0, ESCALATION.max);
  return {
    risks: ok.map(({ escalation: e, village: v }): VillageRisk => ({
      village: v!,
      level: e.level as AlertLevel,
      hazard: e.hazard,
      signals: [{ kind: "argon_escalation", level: e.level as AlertLevel, km: 0, ...(e.stationId && { sourceId: e.stationId, stationId: e.stationId }), text: `escalated by Gemini 4 Argon (checked): ${e.reasoning}`.slice(0, 240) }],
      concrete: 0,
      gaugeKm: Infinity,
      vulnerable: v!.vulnerable ? VULNERABLE.reduce((n, k) => n + (v!.vulnerable![k] ?? 0), 0) : 0,
    })),
    claims: ok.map(({ escalation: e }) => ({ villageId: e.villageId, hazard: e.hazard, level: e.level, etaHours: e.etaHours, stationId: e.stationId, riskEventIds: [], reasoning: e.reasoning })),
  };
}

/** The screen after escalation: escalated villages move from watch/unknown to at risk (accounting stays exact). */
export function escalateScreen(screen: RiskScreen, risks: VillageRisk[]): RiskScreen {
  const ids = new Set(risks.map((r) => r.village._id));
  return {
    atRisk: [...screen.atRisk, ...risks],
    watch: screen.watch.filter((w) => !ids.has(w.village._id)),
    unknown: screen.unknown.filter((u) => !ids.has(u.village._id)),
    noSignal: screen.noSignal,
  };
}

/** Numbers in the sitrep that don't appear in what Argon was given (flagged, never silently trusted). */
export function unsupportedNumbers(sitrep: string, input: string): string[] {
  const nums = sitrep.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const plain = input.replace(/,/g, "");
  return [...new Set(nums)].filter((n) => !plain.includes(n.replace(/,/g, "")));
}
