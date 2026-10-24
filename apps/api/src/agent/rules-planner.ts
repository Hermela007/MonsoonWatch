// Deterministic village planner — no Gemini. Gives EVERY at-risk village its own alert, most
// urgent first, through the same checks as Gemini's plans (build-alerts.ts → verify.ts):
//   1. usable centres only (not at risk; see centreStatus), nearest by DRY road first
//      (one Dijkstra per village, route.ts routesToNearestTargets — roads only, never a straight line)
//   2. capacity allocated across villages with a running ledger (no double-booking); a village
//      is split across up to 4 centres if one has no room
//   3. vulnerable pickups from vulnerable.ts (dry route → ambulance / bus), split with the groups
//   4. template message (ms + en) naming the centre, the roads and the distance
// Villages it can't plan go to Gemini with the reason (no dry route, no centre with space,
// conflicting signals, a failed check) or straight to the area-wide fallback (off the road
// network, no population) where Gemini can't help either.

import type { EvacCentre, Pickup, Village } from "@monsoonwatch/shared";
import { buildAndVerifyVillage, type BuiltVillage } from "./build-alerts";
import { EXCLUDE, MAX_SNAP_KM } from "./evacuate";
import { haversineKm } from "./geo";
import { routesToNearestTargets, type RoadGraph, type RouteResult } from "./route";
import type { AtRiskVillage, VillageGroup, VillagePlan } from "./schemas";
import { LineIndex, type AlertLevel, type VillageRisk } from "./shortlist";
import type { Situation } from "./situation";
import { suggestPickups } from "./vulnerable";

export const RULES = {
  maxRouteKm: 40,
  maxGroups: 4,
  /** Centre status (B's proxy until C's lands, see centreStatus). */
  centreNearFloodKm: 0.5,
  centreFloodKm: 0.2,
  centreRunoutKm: 1,
};

export type GeminiReason = "no_dry_route" | "no_centre_with_space" | "conflicting_signals" | "check_failed";
export type FallbackReason = "off_network" | "no_population";

export type RulesResult =
  | { ok: true; risk: VillageRisk; claim: AtRiskVillage; built: BuiltVillage; alloc: Map<string, number> }
  | { ok: false; risk: VillageRisk; claim: AtRiskVillage; to: "gemini"; reason: GeminiReason; detail: string }
  | { ok: false; risk: VillageRisk; claim: AtRiskVillage; to: "fallback"; reason: FallbackReason; detail: string };

/** Running headcount for this run: what earlier villages already booked at each centre. */
export class CapacityLedger {
  private readonly booked = new Map<string, number>();
  constructor(private readonly centres: EvacCentre[]) {}

  /** Free places, optionally giving back a village's own earlier booking (`own`). */
  free(c: EvacCentre, own?: Map<string, number>): number {
    return c.capacity - c.headcount - (this.booked.get(c._id) ?? 0) + (own?.get(c._id) ?? 0);
  }
  fits(alloc: Map<string, number>, own?: Map<string, number>): boolean {
    return [...alloc].every(([id, n]) => {
      const c = this.centres.find((x) => x._id === id);
      return !!c && this.free(c, own) >= n;
    });
  }
  book(alloc: Map<string, number>): void {
    for (const [id, n] of alloc) this.booked.set(id, (this.booked.get(id) ?? 0) + n);
  }
  release(alloc: Map<string, number>): void {
    for (const [id, n] of alloc) this.booked.set(id, (this.booked.get(id) ?? 0) - n);
  }
  /** Centres with this run's bookings added to headcount — what the capacity checks see. */
  view(own?: Map<string, number>): EvacCentre[] {
    return this.centres.map((c) => ({ ...c, headcount: c.capacity - this.free(c, own) }));
  }
}

/**
 * B-side centre status until C's lands (VERIFY against C's centre status when on main):
 *   "at_risk" — within centreRunoutKm of a landslide runout, or a flooded road within
 *   centreNearFloodKm whose flooding gauge's water level (m) reaches the centre's elevation
 *   (C's flood model floods ground below its gauge's water surface — same idea, approximate);
 *   if that gauge is unknown, a flooded road within centreFloodKm. Else "usable". Reaching the
 *   centre through water is the router's job (dry roads only), not this status.
 */
export function centreStatus(s: Situation): Map<string, "usable" | "at_risk"> {
  const blocked = new Set(s.hazards.blockedRoadIds);
  const floodedRoads = s.roads.filter((r) => blocked.has(String(r.id)));
  const flooded = LineIndex.of(floodedRoads.length
    ? floodedRoads.map((r) => ({ coords: r.geometry.coordinates, id: String(r.id) }))
    : s.hazards.blockedRoads.coordinates.map((coords) => ({ coords })));
  const runouts = LineIndex.of(s.hazards.landslide.runouts.map((r) => ({ coords: r.coordinates })));
  const waterM = new Map(s.stations.flatMap((st) => (st.thresholds && st.latest ? [[st._id, st.latest.value] as [string, number]] : [])));
  return new Map(s.centres.map((c) => {
    const p = c.location.coordinates;
    if (runouts.nearest(p, RULES.centreRunoutKm)) return [c._id, "at_risk"];
    const road = flooded.nearest(p, RULES.centreNearFloodKm);
    if (!road) return [c._id, "usable"];
    const level = road.id ? waterM.get(s.floodGaugeByRoadId?.get(road.id) ?? "") : undefined;
    if (level !== undefined) return [c._id, level >= c.elevationM ? "at_risk" : "usable"];
    return [c._id, road.km <= RULES.centreFloodKm ? "at_risk" : "usable"];
  }));
}

/** The claim the checks verify, from the screen's own evidence (Argon's claim is used when it has one). */
export function claimFromScreen(r: VillageRisk, s: Situation): AtRiskVillage {
  const gauge = r.signals.find((x) => x.kind === "gauge");
  const events = r.signals.filter((x) => x.kind === "river_event");
  const base = { villageId: r.village._id, etaHours: null, reasoning: `Rules screen: ${r.signals.map((x) => x.text).join("; ")}` };
  if (r.hazard === "landslide") {
    const ls = s.riskEvents.filter((e) => e.type === "landslide_screen" && e._id.startsWith(`ls:${r.village._id}:`)).map((e) => e._id);
    return { ...base, hazard: "landslide", level: r.level, stationId: null, riskEventIds: ls };
  }
  return {
    ...base, hazard: "flood",
    level: gauge?.level ?? events[0]?.level ?? r.level, // the checker reads the cited gauge: never claim above it
    stationId: gauge?.sourceId ?? null,
    riskEventIds: events.map((x) => x.sourceId!).filter(Boolean),
  };
}

/** Evidence the rules shouldn't settle alone (→ Gemini looks at it). */
export function conflictingSignals(r: VillageRisk): string | null {
  if (r.hazard !== "flood") return null;
  const gauge = r.signals.find((x) => x.kind === "gauge");
  const event = r.signals.find((x) => x.kind === "river_event");
  if (!gauge && !event) return "flood model shows flooding but no river gauge or river event backs it";
  if (gauge && event && event.stationId === gauge.stationId && gauge.level !== event.level) {
    return `${gauge.text} disagrees with ${event.text} (calibrated level vs GloFAS discharge threshold, both approximate)`;
  }
  return null;
}

// ---- template messages (ms + en), one per alert (= per group / centre) ----

const LEVEL_TEXT: Record<"ms" | "en", Record<AlertLevel, string>> = {
  ms: { alert: "WASPADA", warning: "AMARAN", danger: "BAHAYA" },
  en: { alert: "ALERT", warning: "WARNING", danger: "DANGER" },
};
const HAZARD_TEXT = { ms: { flood: "banjir", landslide: "tanah runtuh" }, en: { flood: "flood", landslide: "landslide" } } as const;
const CATEGORY_TEXT = {
  ms: { bedridden: "terlantar", disabled: "OKU", elderly: "warga emas", noTransport: "tiada kenderaan" },
  en: { bedridden: "bedridden", disabled: "disabled", elderly: "elderly", noTransport: "no-transport" },
} as const;
const VEHICLE_TEXT = {
  ms: { ambulance: "ambulans", boat: "bot", bus: "bas", "4x4": "kenderaan 4x4" },
  en: { ambulance: "ambulance", boat: "boat", bus: "bus", "4x4": "4x4" },
} as const;

/** Named roads along the route, in order (max 3); null if none are named in OSM. */
export function routeRoads(route: RouteResult): string[] {
  const names: string[] = [];
  for (const seg of route.segments ?? []) if (seg.name && !names.includes(seg.name)) names.push(seg.name);
  return names.slice(0, 3);
}

export function templateMessages(args: {
  languages: string[];
  village: Village;
  claim: Pick<AtRiskVillage, "level" | "hazard">;
  centre: EvacCentre;
  route: RouteResult;
  people: number;
  pickups: Pickup[];
  maxChars?: number;
}): { lang: string; text: string }[] {
  const { village, claim, centre, route, people, pickups } = args;
  const max = args.maxChars ?? 500;
  const roads = routeRoads(route);
  const km = route.lengthKm.toFixed(1);
  const split = people < village.population;
  const first = pickups[0];
  const make = (lang: "ms" | "en", withRoads: boolean) => {
    const L = LEVEL_TEXT[lang][claim.level as AlertLevel], H = HAZARD_TEXT[lang][claim.hazard];
    if (lang === "ms") {
      return [
        `${L} ${H} untuk ${village.name}.`,
        `${split ? `${people} penduduk: pergi` : "Pergi"} ke ${centre.name} (${km} km${withRoads && roads.length ? ` melalui ${roads.join(", ")}` : " ikut jalan yang kering"}).`,
        first ? `Penduduk rentan akan dijemput (${CATEGORY_TEXT.ms[first.category]} dahulu, dengan ${VEHICLE_TEXT.ms[first.vehicle]}).` : "",
        "Ikut arahan pihak berkuasa.",
      ].filter(Boolean).join(" ");
    }
    return [
      `${L}: ${H} risk for ${village.name}.`,
      `${split ? `${people} residents: go` : "Go"} to ${centre.name} (${km} km${withRoads && roads.length ? ` via ${roads.join(", ")}` : " by dry roads"}).`,
      first ? `Vulnerable residents will be picked up (${CATEGORY_TEXT.en[first.category]} first, by ${VEHICLE_TEXT.en[first.vehicle]}).` : "",
      "Follow official instructions.",
    ].filter(Boolean).join(" ");
  };
  const langs = args.languages.filter((l): l is "ms" | "en" => l === "ms" || l === "en");
  return (langs.length ? langs : (["en"] as const)).map((lang) => {
    const full = make(lang, true);
    return { lang, text: full.length <= max ? full : make(lang, false).slice(0, max) };
  });
}

/** Split the village's pickups over its groups, keeping one priority order across the village. */
export function splitPickups(pickups: Pickup[], groupPeople: number[]): Pickup[][] {
  const out: Pickup[][] = groupPeople.map(() => []);
  const room = [...groupPeople];
  let g = 0;
  let order = 1;
  for (const p of pickups) {
    let left = p.people;
    while (left > 0) {
      while (g < room.length - 1 && room[g]! <= 0) g++;
      const take = g === room.length - 1 ? left : Math.min(left, room[g]!); // last group takes any excess
      out[g]!.push({ ...p, people: take, order: order++ });
      room[g]! -= take;
      left -= take;
    }
  }
  return out;
}

export interface RulesContext {
  runId: string;
  situation: Situation;
  graph: RoadGraph;
  ledger: CapacityLedger;
  usable: ReadonlySet<string>;
  blocked: ReadonlySet<string>;
}

/** Plan one village by rules; on success its capacity is booked in the ledger. */
export function planVillageByRules(ctx: RulesContext, risk: VillageRisk, claim: AtRiskVillage = claimFromScreen(risk, ctx.situation)): RulesResult {
  const { situation: s, graph, ledger } = ctx;
  const v = risk.village;
  const no = <T extends "gemini" | "fallback">(to: T, reason: T extends "gemini" ? GeminiReason : FallbackReason, detail: string) =>
    ({ ok: false, risk, claim, to, reason, detail }) as RulesResult;

  if (v.population <= 0) return no("fallback", "no_population", `${v.name}: population unknown (0) — area-wide warning only`);
  const conflict = conflictingSignals(risk);
  if (conflict) return no("gemini", "conflicting_signals", `${v.name}: ${conflict}`);

  const candidates = s.centres.filter((c) => ctx.usable.has(c._id) && ledger.free(c) > 0);
  const byId = new Map(candidates.map((c) => [c._id, c]));
  const { startSnapKm, reached } = routesToNearestTargets(graph, ctx.blocked, v.location.coordinates,
    candidates.map((c) => ({ id: c._id, lngLat: c.location.coordinates })), {
      maxKm: RULES.maxRouteKm,
      maxSnapKm: MAX_SNAP_KM.car,
      excludeHighways: EXCLUDE.car,
      enough: (r) => r.length >= RULES.maxGroups * 2 || r.reduce((n, x) => n + ledger.free(byId.get(x.id)!), 0) >= v.population,
    });
  if (startSnapKm === null || startSnapKm > MAX_SNAP_KM.car) {
    return no("fallback", "off_network", `${v.name}: ${startSnapKm === null ? "no road data" : `${startSnapKm} km from the nearest mapped road`}`);
  }
  if (reached.length === 0) {
    const anyNear = candidates.some((c) => haversineKm(v.location.coordinates, c.location.coordinates) <= RULES.maxRouteKm);
    return anyNear
      ? no("gemini", "no_dry_route", `${v.name}: no dry road to any usable centre with space within ${RULES.maxRouteKm} km (boat?)`)
      : no("gemini", "no_centre_with_space", `${v.name}: no usable centre with free places within ${RULES.maxRouteKm} km`);
  }

  // Allocate nearest-by-road first, up to maxGroups centres.
  const alloc = new Map<string, number>();
  const groups: { centre: EvacCentre; route: RouteResult; people: number }[] = [];
  let left = v.population;
  for (const r of reached) {
    if (left === 0 || groups.length === RULES.maxGroups) break;
    const c = byId.get(r.id)!;
    const take = Math.min(left, ledger.free(c));
    if (take <= 0) continue;
    groups.push({ centre: c, route: r.route, people: take });
    alloc.set(c._id, take);
    left -= take;
  }
  if (left > 0) {
    return no("gemini", "no_centre_with_space", `${v.name}: only ${v.population - left} of ${v.population} places free at the ${groups.length} nearest dry-road centres`);
  }

  const pickups = splitPickups(suggestPickups(v, false), groups.map((g) => g.people));
  const plan: VillagePlan = {
    reasoning: "Rules planner (no AI): nearest usable centres by dry road, capacity booked across villages, vulnerable pickups by priority.",
    groups: groups.map((g, i): VillageGroup => ({
      evacCentreId: g.centre._id, people: g.people, routeMode: "road", pickups: pickups[i]!,
      messages: templateMessages({ languages: s.region.languages, village: v, claim, centre: g.centre, route: g.route, people: g.people, pickups: pickups[i]! }),
    })),
  };
  // The same checks as Gemini's plans, against centres with this run's bookings counted.
  const built = buildAndVerifyVillage({
    runId: ctx.runId, situation: { ...s, centres: ledger.view() }, graph, village: v, atRisk: claim, plan,
    routes: groups.map((g) => g.route), idTag: "rules",
  });
  if (!built.passed) {
    const why = [...built.planErrors, ...built.results.filter((r) => !r.passed).map((r) => `${r.check}: ${r.detail}`)].join("; ");
    return no("gemini", "check_failed", `${v.name}: ${why}`.slice(0, 300));
  }
  ledger.book(alloc);
  return { ok: true, risk, claim, built, alloc };
}

/** Plan every at-risk village in urgency order (deterministic, synchronous). */
export function planAllByRules(ctx: Omit<RulesContext, "usable" | "blocked" | "ledger"> & { ledger?: CapacityLedger }, atRisk: VillageRisk[], claims = new Map<string, AtRiskVillage>()) {
  const status = centreStatus(ctx.situation);
  const full: RulesContext = {
    ...ctx,
    ledger: ctx.ledger ?? new CapacityLedger(ctx.situation.centres),
    usable: new Set([...status].filter(([, st]) => st === "usable").map(([id]) => id)),
    blocked: new Set(ctx.situation.hazards.blockedRoadIds),
  };
  const results = atRisk.map((r) => planVillageByRules(full, r, claims.get(r.village._id)));
  return { results, ledger: full.ledger, centresAtRisk: [...status.values()].filter((st) => st === "at_risk").length };
}
