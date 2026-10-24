import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvacCentre, LngLat, Pickup, Region, RoadFeature, StationWithLatest, Village } from "@monsoonwatch/shared";
import { buildRoadGraph, nearestNode, type RoadGraph } from "./route";
import { buildAndVerifyVillage } from "./build-alerts";
import { CapacityLedger, centreStatus, claimFromScreen, conflictingSignals, planAllByRules, splitPickups, templateMessages } from "./rules-planner";
import type { RiskSignal, VillageRisk } from "./shortlist";
import type { Situation } from "./situation";

// A road along the equator-ish line 5.0° N: nodes every 0.01° (≈ 1.1 km) from n0 to n4.
const node = (i: number): LngLat => [102 + i * 0.01, 5.0];
const road = (i: number, name?: string): RoadFeature => ({
  type: "Feature", id: `r${i}`, geometry: { type: "LineString", coordinates: [node(i), node(i + 1)] },
  properties: { id: `r${i}`, from: `n${i}`, to: `n${i + 1}`, highway: "secondary", lengthM: 1109, ...(name && { name }) },
});
const ROADS = [road(0, "Jalan Satu"), road(1, "Jalan Dua"), road(2, "Jalan Tiga"), road(3, "Jalan Empat")];
const centre = (id: string, at: number, capacity: number, headcount = 0, elevationM = 50): EvacCentre =>
  ({ _id: id, regionId: "t", name: `Centre ${id}`, location: { type: "Point", coordinates: node(at) }, capacity, headcount, elevationM });
const village = (id: string, at: LngLat, population: number, vulnerable?: Partial<Record<"bedridden" | "disabled" | "elderly" | "noTransport", number>>): Village => ({
  _id: id, regionId: "t", name: `Kampung ${id}`, altNames: [], location: { type: "Point", coordinates: at }, population, district: "d",
  ...(vulnerable && { vulnerable: { bedridden: 0, disabled: 0, elderly: 0, noTransport: 0, ...vulnerable, source: "test", estimated: true } }),
});
const GAUGE: StationWithLatest = {
  _id: "g", regionId: "t", kind: "river", name: "Gauge g", district: "d", location: { type: "Point", coordinates: [102.0, 5.01] },
  thresholds: { normal: 10, alert: 11, warning: 12, danger: 13 },
  latest: { ts: "2014-12-24T04:00:00Z", value: 12.5, meta: { stationId: "g", kind: "river", source: "jps", mode: "replay" } },
};
const gaugeSignal: RiskSignal = { kind: "gauge", level: "warning", km: 1, sourceId: "g", stationId: "g", text: "gauge g WARNING 1 km" };
const risk = (v: Village, signals: RiskSignal[] = [gaugeSignal, { kind: "flooded_road", level: null, km: 0.3, text: "flooded road 0.3 km" }]): VillageRisk =>
  ({ village: v, level: "warning", hazard: "flood", signals, concrete: 1, gaugeKm: 1, vulnerable: 0 });

function situation(over: Partial<Situation> = {}): Situation {
  return {
    region: { _id: "t", name: "Test", languages: ["ms", "en"], timezone: "Asia/Kuala_Lumpur" } as unknown as Region,
    mode: "replay", now: new Date("2014-12-24T04:00:00Z"),
    stations: [GAUGE], riskEvents: [], villages: [], centres: [], roads: ROADS, knowledge: [],
    hazards: { blockedRoadIds: [], blockedRoads: { type: "MultiLineString", coordinates: [] }, landslide: { cells: [], runouts: [] } },
    isTestData: true,
    ...over,
  };
}
const plan = (s: Situation, atRisk: VillageRisk[], graph: RoadGraph = buildRoadGraph(s.roads)) => planAllByRules({ runId: "r", situation: s, graph }, atRisk);

test("grid nearestNode matches a full scan", () => {
  const g = buildRoadGraph(ROADS);
  for (const p of [[102.013, 5.004], [101.9, 5.2], [102.5, 4.9]] as LngLat[]) {
    const full = [...g.nodeCoord].map(([id, c]) => ({ id, d: Math.hypot(c[0] - p[0], c[1] - p[1]) })).sort((a, b) => a.d - b.d)[0]!.id;
    assert.equal(nearestNode(g, p)!.id, full);
  }
});

test("most urgent village first gets the nearest centre; the next is split without double-booking", () => {
  const A = village("A", node(0), 100, { bedridden: 2, elderly: 5 });
  const B = village("B", node(0), 100);
  const s = situation({ villages: [A, B], centres: [centre("C1", 1, 150), centre("C2", 3, 500)] });
  const { results, ledger } = plan(s, [risk(A), risk(B)]);
  assert.ok(results.every((r) => r.ok));
  const [a, b] = results as Extract<(typeof results)[number], { ok: true }>[];
  assert.deepEqual([...a!.alloc], [["C1", 100]]);
  assert.deepEqual([...b!.alloc], [["C1", 50], ["C2", 50]]); // only 50 left at C1
  assert.equal(ledger.free(s.centres[0]!), 0);
  const alert = a!.built.alerts[0]!;
  assert.equal(alert.status, "verified");
  assert.match(alert._id, /^r:A:rules:1$/);
  assert.deepEqual(alert.route.coordinates[0], node(0)); // follows the road, not a straight line
  assert.deepEqual(alert.pickups!.map((p) => [p.order, p.category, p.vehicle]), [[1, "bedridden", "ambulance"], [2, "elderly", "bus"]]);
  assert.match(alert.messages.find((m) => m.lang === "en")!.text, /^WARNING: flood risk for Kampung A\. Go to Centre C1 \(1\.1 km via Jalan Satu\)\. Vulnerable residents will be picked up \(bedridden first, by ambulance\)/);
  assert.match(b!.built.alerts[0]!.messages.find((m) => m.lang === "ms")!.text, /50 penduduk: pergi ke Centre C1/);
});

const FLOODED_R0 = { blockedRoadIds: ["r0"], blockedRoads: { type: "MultiLineString" as const, coordinates: [[node(0), node(1)]] }, landslide: { cells: [], runouts: [] } };

test("cut off by water: planned by BOAT along the flooded road, all pickups by boat, same checks", () => {
  const cut = village("cut", node(0), 50, { bedridden: 2, elderly: 4 }); // its only road (r0) is flooded
  const s = situation({ centres: [centre("C1", 2, 80)], hazards: FLOODED_R0 });
  const [r] = plan(s, [risk(cut)]).results;
  assert.ok(r!.ok);
  assert.equal(r.boatGroups, 1);
  const a = r.built.alerts[0]!;
  assert.equal(a.status, "verified");
  assert.ok(a.verification.find((x) => x.check === "route")!.passed);
  assert.deepEqual(a.pickups!.map((p) => [p.category, p.vehicle]), [["bedridden", "boat"], ["elderly", "boat"]]);
  assert.match(a.messages.find((m) => m.lang === "en")!.text, /^WARNING: flood risk for Kampung cut\. Rescue boats will take you to Centre C1; the rescue team chooses the way\. Wait at the highest safe point/);
  assert.match(a.messages.find((m) => m.lang === "ms")!.text, /Bot penyelamat akan membawa anda ke Centre C1; pasukan penyelamat menentukan laluan/);
  assert.ok(a.messages.every((m) => !/km/.test(m.text)), "no boat distance or route is claimed");
});

test("road first, boat for the rest: 30 by dry road, 70 by boat; then every pickup goes by boat", () => {
  const v = village("mix", node(1), 100, { disabled: 3 });
  // "wet" sits at the end of the flooded road but 50 m up (gauge g at 12.5 m) → usable, reachable only by boat.
  const s = situation({ centres: [centre("dry", 2, 30), centre("wet", 0, 200)], hazards: FLOODED_R0, floodGaugeByRoadId: new Map([["r0", "g"]]) });
  const [r] = plan(s, [risk(v)]).results;
  assert.ok(r!.ok, r!.ok ? "" : r!.detail);
  assert.deepEqual(r.built.alerts.map((a) => [a.evacCentreId, a.people]), [["dry", 30], ["wet", 70]]);
  assert.deepEqual(r.built.routes.map((x) => x.mode), ["road", "boat"]);
  assert.ok(r.built.alerts.flatMap((a) => a.pickups ?? []).every((p) => p.vehicle === "boat"));
});

test("why code can't plan: no road or boat route / no space → Gemini; conflicting signals → Gemini; off network / no population → fallback", () => {
  const island = road(9); // a road piece connected to nothing
  island.geometry.coordinates = [[102.2, 5.1], [102.21, 5.1]];
  island.properties = { ...island.properties, from: "i0", to: "i1" };
  const island2 = road(8); // another unconnected piece, with a 300-place centre on it
  island2.geometry.coordinates = [[102.3, 5.3], [102.31, 5.3]];
  island2.properties = { ...island2.properties, from: "j0", to: "j1" };
  const far2: EvacCentre = { ...centre("C2", 0, 300), location: { type: "Point", coordinates: [102.31, 5.3] } };
  const s = situation({ roads: [...ROADS, island, island2], centres: [centre("C1", 2, 80), far2], hazards: FLOODED_R0 });
  const isolated = village("isolated", [102.2, 5.1], 50); // C1 is 23 km away but not connected
  const big = village("big", node(1), 300); // road to C1 (80 places); C2's 300 places exist but can't be reached by code
  const huge = village("huge", node(1), 5000); // more than all 12 nearest centres together (380)
  const conflict = village("conflict", node(1), 10);
  const far = village("far", [102.0, 5.2], 10); // 22 km from any road
  const empty = village("empty", node(1), 0);
  const { results } = plan(s, [
    risk(isolated), risk(big), risk(huge),
    risk(conflict, [{ kind: "flooded_road", level: null, km: 0.1, text: "flooded road" }]),
    risk(far), risk(empty),
  ]);
  assert.deepEqual(results.map((r) => (r.ok ? "ok" : `${r.to}:${r.reason}`)), [
    "gemini:no_route", "gemini:no_centre_with_space", "fallback:not_enough_space", "gemini:conflicting_signals", "fallback:off_network", "fallback:no_population",
  ]);
  const tooBig = results[2]!;
  assert.ok(!tooBig.ok && /5,000 people but only 380 free places at the 12 nearest centres/.test(tooBig.detail), !tooBig.ok ? tooBig.detail : "");
});

test("conflict only when a gauge and a river event about the SAME station disagree", () => {
  const ev = (stationId: string, level: "warning" | "danger"): RiskSignal => ({ kind: "river_event", level, km: 2, sourceId: "e", stationId, text: `river event e ${level}` });
  assert.equal(conflictingSignals(risk(village("x", node(0), 1), [gaugeSignal, ev("other", "danger")])), null);
  assert.match(conflictingSignals(risk(village("x", node(0), 1), [gaugeSignal, ev("g", "danger")]))!, /disagrees/);
});

test("centre status: flooded road nearby only puts a centre at risk if its gauge's water reaches the centre's elevation", () => {
  const s = situation({
    centres: [centre("high", 1, 10, 0, 50), centre("low", 1, 10, 0, 12), centre("far", 4, 10)],
    hazards: { blockedRoadIds: ["r0"], blockedRoads: { type: "MultiLineString", coordinates: [[node(0), node(1)]] }, landslide: { cells: [], runouts: [] } },
    floodGaugeByRoadId: new Map([["r0", "g"]]), // gauge g at 12.5 m
  });
  assert.deepEqual([...centreStatus(s)], [["high", "usable"], ["low", "at_risk"], ["far", "usable"]]);
});

test("C's centre status wins: rules never send people to an 'at_risk' or 'unknown' centre, and the checks reject at-risk ones", () => {
  const v = village("v", node(0), 50);
  const s = situation({
    centres: [centre("near-risky", 1, 100), centre("near-unknown", 2, 100), centre("far-ok", 4, 100)],
    centreStatusById: new Map([["near-risky", "at_risk"], ["near-unknown", "unknown"], ["far-ok", "usable"]] as const),
  });
  assert.deepEqual([...centreStatus(s)], [["near-risky", "at_risk"], ["near-unknown", "unknown"], ["far-ok", "usable"]]);
  const [r] = plan(s, [risk(v)]).results;
  assert.ok(r!.ok);
  assert.deepEqual(r.built.alerts.map((a) => a.evacCentreId), ["far-ok"]);
  // A plan (e.g. Gemini's) that uses the at-risk centre fails the capacity check.
  const built = buildAndVerifyVillage({
    runId: "r", situation: s, graph: buildRoadGraph(s.roads), village: v, atRisk: claimFromScreen(risk(v), s),
    plan: { reasoning: "x", groups: [{ evacCentreId: "near-risky", people: 50, routeMode: "road", pickups: [], messages: [{ lang: "ms", text: "AMARAN banjir" }, { lang: "en", text: "WARNING: flood" }] }] },
  });
  assert.equal(built.passed, false);
  assert.ok(built.results.some((x) => x.check === "capacity" && !x.passed && /at risk of flooding/.test(x.detail)));
});

test("ledger: bookings reduce free places; a village's own booking can be given back", () => {
  const c = centre("C", 0, 100, 20);
  const l = new CapacityLedger([c]);
  l.book(new Map([["C", 50]]));
  assert.equal(l.free(c), 30);
  assert.equal(l.fits(new Map([["C", 40]])), false);
  assert.equal(l.fits(new Map([["C", 40]]), new Map([["C", 50]])), true);
  assert.equal(l.view()[0]!.headcount, 70);
});

test("pickups split over groups keep one priority order", () => {
  const p = (category: Pickup["category"], people: number, order: number): Pickup => ({ category, people, vehicle: "bus", order });
  assert.deepEqual(splitPickups([p("bedridden", 2, 1), p("elderly", 5, 2)], [4, 10]), [
    [p("bedridden", 2, 1), p("elderly", 2, 2)],
    [p("elderly", 3, 3)],
  ]);
});

test("template messages stay within 500 characters (roads dropped first)", () => {
  const long = "Sekolah Kebangsaan " + "Panjang ".repeat(40);
  const route = { found: true, mode: "road" as const, coordinates: [], segmentIds: [], lengthKm: 3.2, crossesFlood: false, note: "", segments: [{ id: "s", name: "Jalan " + "X".repeat(200), highway: "primary", lengthM: 1, coords: [] }] };
  const msgs = templateMessages({ languages: ["ms", "en"], village: village("v", node(0), 10), claim: { level: "danger", hazard: "flood" }, centre: { ...centre("c", 0, 10), name: long }, route, people: 10, pickups: [] });
  assert.ok(msgs.every((m) => m.text.length <= 500 && m.text.length > 0));
});
