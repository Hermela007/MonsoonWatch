// B3 — the verification loop's checks (GUIDELINES §6.3, IMPLEMENTATION B3).
// Deterministic code, NO LLM. Pure functions: same input → same result, easy to test and to
// show judges. The orchestrator calls `verifyAlert`; failures feed the replan prompt.

import type {
  Alert,
  EvacCentre,
  Hazards,
  Reading,
  Region,
  RiskEvent,
  RiskLevel,
  Station,
  VerificationResult,
  Village,
} from "@monsoonwatch/shared";
import { firstIntersectingSegment, haversineKm } from "./geo";

export const DEFAULTS = {
  freshnessMaxMinutes: 60,
  maxMessageChars: 500,
  /** Route must start near the village and end near the assigned centre. */
  maxRouteStartKm: 2,
  maxRouteEndKm: 1,
} as const;

const LEVEL_RANK: Record<RiskLevel, number> = { normal: 0, alert: 1, warning: 2, danger: 3 };

export interface VerifyContext {
  region: Pick<Region, "languages">;
  mode: "live" | "replay";
  now: Date;
  village: Village;
  centre: EvacCentre;
  /** What the agent cited for this alert. */
  evidence: {
    station?: Station;
    latestReading?: Reading;
    riskEvents: RiskEvent[];
  };
  hazards: Pick<Hazards, "blockedRoads" | "landslide"> & Partial<Pick<Hazards, "blockedRoadIds">>;
  /**
   * How the route was planned (route.ts). When the road segment ids are known, the flood check
   * uses them exactly (no false alarm where a dry route only touches a flooded road at a junction).
   * A boat route may cross flooded roads; landslide runouts still fail it.
   */
  route?: { mode: "road" | "boat"; segmentIds?: string[] };
  options?: Partial<typeof DEFAULTS>;
}

/** JPS thresholds → level. Value in metres. */
export function levelFromThresholds(levelM: number, t: NonNullable<Station["thresholds"]>): RiskLevel {
  if (levelM >= t.danger) return "danger";
  if (levelM >= t.warning) return "warning";
  if (levelM >= t.alert) return "alert";
  return "normal";
}

// 1. Threshold: the claimed level must be backed by stored data and must not overclaim.
export function checkThreshold(alert: Alert, ctx: VerifyContext): VerificationResult {
  const { station, latestReading, riskEvents } = ctx.evidence;

  if (alert.hazard === "flood") {
    if (!station?.thresholds || !latestReading) {
      return fail("threshold", "No river station reading with JPS thresholds cited");
    }
    const actual = levelFromThresholds(latestReading.value, station.thresholds);
    const t = station.thresholds;
    const detail =
      `${station.name}: ${latestReading.value.toFixed(2)} m → ${actual.toUpperCase()} ` +
      `(alert ${t.alert} / warning ${t.warning} / danger ${t.danger} m); claimed ${alert.level.toUpperCase()}`;
    if (LEVEL_RANK[actual] < LEVEL_RANK.alert) return fail("threshold", `${detail} — no threshold crossed`);
    if (LEVEL_RANK[alert.level] > LEVEL_RANK[actual]) return fail("threshold", `${detail} — overclaims`);
    return pass("threshold", detail);
  }

  // Landslide: backed by a screening / rain-accumulation risk event.
  const support = riskEvents.filter((e) => e.type === "landslide_screen" || e.type === "rain_accumulation");
  if (support.length === 0) return fail("threshold", "No landslide screen or rain-accumulation event cited");
  const best = support.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a));
  const detail = `${best.type}: ${best.value} vs threshold ${best.threshold} → ${best.level.toUpperCase()}; claimed ${alert.level.toUpperCase()}`;
  return LEVEL_RANK[alert.level] > LEVEL_RANK[best.level] ? fail("threshold", `${detail} — overclaims`) : pass("threshold", detail);
}

// 2. Route: must not cross a flooded road or a landslide runout, and must connect village → centre.
export function checkRoute(alert: Alert, ctx: VerifyContext): VerificationResult {
  const opt = { ...DEFAULTS, ...ctx.options };
  const coords = alert.route.coordinates;
  if (coords.length < 2) return fail("route", "Route has fewer than 2 points");

  const startKm = haversineKm(coords[0]!, ctx.village.location.coordinates);
  if (startKm > opt.maxRouteStartKm) {
    return fail("route", `Route starts ${startKm.toFixed(1)} km from ${ctx.village.name} (max ${opt.maxRouteStartKm} km)`);
  }
  const endKm = haversineKm(coords[coords.length - 1]!, ctx.centre.location.coordinates);
  if (endKm > opt.maxRouteEndKm) {
    return fail("route", `Route ends ${endKm.toFixed(1)} km from ${ctx.centre.name} (max ${opt.maxRouteEndKm} km)`);
  }

  const boat = ctx.route?.mode === "boat";
  if (!boat) {
    const ids = ctx.route?.segmentIds;
    const blockedIds = ctx.hazards.blockedRoadIds;
    if (ids && blockedIds) {
      const blocked = new Set(blockedIds);
      const hit = ids.find((id) => blocked.has(id));
      if (hit) return fail("route", `Road route uses flooded road segment ${hit} — needs a boat or another centre`);
    } else {
      for (const blocked of ctx.hazards.blockedRoads.coordinates) {
        const seg = firstIntersectingSegment(coords, blocked);
        if (seg >= 0) return fail("route", `Route segment ${seg + 1} crosses a flooded road`);
      }
    }
  }
  for (const runout of ctx.hazards.landslide.runouts) {
    const seg = firstIntersectingSegment(coords, runout.coordinates);
    if (seg >= 0) {
      return fail("route", `Route segment ${seg + 1} crosses a landslide runout path (risk ${runout.risk.toFixed(2)})`);
    }
  }
  const floods = ctx.hazards.blockedRoadIds?.length ?? ctx.hazards.blockedRoads.coordinates.length;
  return pass(
    "route",
    boat
      ? `Boat route; clear of ${ctx.hazards.landslide.runouts.length} landslide runouts`
      : `Dry road route; clear of ${floods} flooded segments and ${ctx.hazards.landslide.runouts.length} runouts`,
  );
}

// 3. Capacity: the centre must have room for the whole village.
// One alert = one group (`alert.people`) going to one centre (§1.6 decision 5).
export function checkCapacity(alert: Alert, ctx: VerifyContext): VerificationResult {
  const free = ctx.centre.capacity - ctx.centre.headcount;
  const need = alert.people;
  const detail = `${ctx.centre.name}: ${free} free (${ctx.centre.headcount}/${ctx.centre.capacity}); sending ${need} from ${ctx.village.name}`;
  if (need <= 0) return fail("capacity", `${detail} — alert must move at least 1 person`);
  return free >= need ? pass("capacity", detail) : fail("capacity", `${detail} — split across centres`);
}

/**
 * Cross-alert check for a split village: the alerts for one village (same run) must add up to
 * its population, and no centre may be over-filled by the combined groups. Run after verifyAlert.
 */
export function checkVillageSplit(
  alerts: Pick<Alert, "villageId" | "evacCentreId" | "people">[],
  village: Village,
  centres: EvacCentre[],
): VerificationResult {
  const mine = alerts.filter((a) => a.villageId === village._id);
  const total = mine.reduce((sum, a) => sum + a.people, 0);
  if (total !== village.population) {
    return fail("capacity", `${village.name}: alerts move ${total} of ${village.population} people`);
  }
  const perCentre = new Map<string, number>();
  for (const a of mine) perCentre.set(a.evacCentreId, (perCentre.get(a.evacCentreId) ?? 0) + a.people);
  for (const [centreId, people] of perCentre) {
    const c = centres.find((x) => x._id === centreId);
    if (!c) return fail("capacity", `${village.name}: unknown centre ${centreId}`);
    if (c.capacity - c.headcount < people) {
      return fail("capacity", `${c.name}: ${people} assigned but only ${c.capacity - c.headcount} free`);
    }
  }
  return pass("capacity", `${village.name}: all ${total} people assigned across ${perCentre.size} centre(s)`);
}

// 4. Freshness: supporting data must be recent (live mode only — replay data is historical by design).
export function checkFreshness(_alert: Alert, ctx: VerifyContext): VerificationResult {
  if (ctx.mode === "replay") return pass("freshness", "Replay mode (reconstructed Dec 2014 data) — not applicable");
  const maxMin = ctx.options?.freshnessMaxMinutes ?? DEFAULTS.freshnessMaxMinutes;
  const ts = ctx.evidence.latestReading?.ts ?? ctx.evidence.riskEvents[0]?.ts;
  if (!ts) return fail("freshness", "No timestamped evidence cited");
  const ageMin = (ctx.now.getTime() - new Date(ts).getTime()) / 60_000;
  const detail = `Evidence is ${Math.round(ageMin)} min old (max ${maxMin})`;
  return ageMin <= maxMin ? pass("freshness", detail) : fail("freshness", `${detail} — station may be stale`);
}

// 5. Language: every region language present, non-empty, fits SMS/WhatsApp length.
export function checkLanguage(alert: Alert, ctx: VerifyContext): VerificationResult {
  const max = ctx.options?.maxMessageChars ?? DEFAULTS.maxMessageChars;
  const problems: string[] = [];
  for (const lang of ctx.region.languages) {
    const msg = alert.messages.find((m) => m.lang === lang);
    if (!msg || msg.text.trim() === "") problems.push(`missing ${lang}`);
    else if (msg.text.length > max) problems.push(`${lang} is ${msg.text.length} chars (max ${max})`);
  }
  return problems.length === 0
    ? pass("language", `${ctx.region.languages.join(" + ")} present, ≤ ${max} chars`)
    : fail("language", problems.join("; "));
}

/** Run all five checks in a fixed order. */
export function verifyAlert(alert: Alert, ctx: VerifyContext): VerificationResult[] {
  return [checkThreshold, checkRoute, checkCapacity, checkFreshness, checkLanguage].map((check) => check(alert, ctx));
}

export const allPassed = (results: VerificationResult[]): boolean => results.every((r) => r.passed);

/** Bullet list fed back into the replan prompt. */
export function failureReasons(results: VerificationResult[]): string {
  return results.filter((r) => !r.passed).map((r) => `- ${r.check}: ${r.detail}`).join("\n");
}

function pass(check: VerificationResult["check"], detail: string): VerificationResult {
  return { check, passed: true, detail };
}
function fail(check: VerificationResult["check"], detail: string): VerificationResult {
  return { check, passed: false, detail };
}
