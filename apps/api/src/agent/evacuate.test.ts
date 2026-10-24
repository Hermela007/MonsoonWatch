// Evacuation routing core → the shared EvacuationRoute contract. Every response is validated with
// EvacuationRouteSchema (what A builds against).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EvacuationRouteSchema, type EvacuationRoute, type RoadHazardStatus } from "@monsoonwatch/shared";
import { evacuationRoute, type CentreInfo, type EvacuationInput, type RoadHazards } from "./evacuate";
import { buildRoadGraph } from "./route";
import { makeSampleSituation } from "./sample/kelantan-test";

const s = makeSampleSituation();
const graph = buildRoadGraph(s.roads);
const centres: CentreInfo[] = s.centres.map((c) => ({ ...c, status: "usable", source: "osm-candidate", capacityEstimated: true, headcountUpdatedAt: null }));
const flooded = new Set(s.hazards.blockedRoadIds);
/** Every sample segment assessed: flooded or clear. */
const known: RoadHazards = {
  statusOf: (id): RoadHazardStatus => (flooded.has(id) ? "flooded" : "clear"),
  floodedIds: s.hazards.blockedRoadIds,
  landslideRoadIds: new Set(),
  assessedAt: s.now.toISOString(),
  source: "test flood model",
  notes: [],
};
const village = (id: string) => s.villages.find((v) => v._id === id)!.location.coordinates;
const manik = village("test-kg-manik-urai");
const tualang = village("test-kg-tualang");

function route(over: Partial<EvacuationInput> = {}): EvacuationRoute {
  const r = evacuationRoute({
    regionId: "kelantan", graph, centres, hazards: known, from: manik, travel: "car", mode: "replay", ts: s.now.toISOString(),
    version: "test", sources: ["test"], testData: true, ...over,
  });
  const parsed = EvacuationRouteSchema.parse(r); // the contract, exactly
  if (parsed.status === "ok") {
    assert.equal(parsed.reason, null);
    for (const st of parsed.steps) assert.ok(st.startIndex <= st.endIndex && st.endIndex < parsed.geometry!.coordinates.length);
  } else {
    assert.ok(parsed.reason);
    assert.equal(parsed.geometry, null, "never a geometry (or straight line) for a failed route");
    assert.deepEqual(parsed.steps, []);
  }
  if (parsed.hazards.status !== "assessed") assert.notEqual(parsed.hazards.crossesFlood, false, "false only when fully assessed");
  return parsed;
}

test("ok: car from Manik Urai to the nearest centre by dry road, steps index the road-following geometry", () => {
  const r = route({ people: 4 });
  assert.equal(r.status, "ok");
  assert.equal(r.centre!.id, "test-sk-manik-urai");
  assert.equal(r.centre!.status, "usable");
  assert.equal(r.query.people, 4);
  assert.deepEqual(r.origin.requested, manik);
  assert.ok(r.origin.snapped && r.origin.snapDistanceM !== null);
  assert.ok(r.geometry!.coordinates.length >= 3, "follows road segments, not a 2-point line");
  assert.equal(r.steps[0]!.roadName, "Jalan Manik Urai");
  assert.match(r.steps[0]!.instruction, /^Drive .* on Jalan Manik Urai$/);
  assert.deepEqual([r.steps.at(-1)!.instruction, r.steps.at(-1)!.roadName], ["Arrive at SK Manik Urai (test)", null]);
  assert.ok(r.durationSeconds! >= 60);
  assert.equal(r.durationBasis, "assumed average 30 km/h by car");
  assert.equal(r.hazards.status, "assessed");
  assert.equal(r.hazards.crossesFlood, false);
  assert.equal(r.hazards.segments.flooded, 0);
  assert.deepEqual(r.hazards.confirmedClosures, { available: false, source: null });
  assert.match(r.message, /^\[TEST DATA\] SK Manik Urai \(test\): \d+\.\d km by car, about \d+ min$/);
  assert.ok(r.alternatives.some((a) => a.centreId === "test-smk-kuala-krai" && a.status === "no_route" && a.reason === "all_routes_flooded"));
});

test("unnamed roads get roadName null and a neutral instruction (never an invented name)", () => {
  const r = route({ from: tualang, centreId: "test-dewan-tualang" });
  const step = r.steps.find((st) => st.roadName === null && !st.instruction.startsWith("Arrive"));
  if (step) assert.match(step.instruction, /the .* road$/);
  assert.ok(r.steps.filter((st) => st.roadName).every((st) => s.roads.some((x) => x.properties.name === st.roadName)));
});

test("Tualang: avoids the flooded riverside road and reports the detour", () => {
  const r = route({ from: tualang, centreId: "test-dewan-tualang" });
  assert.equal(r.status, "ok");
  assert.ok(r.hazards.floodedSegmentsAvoided! >= 1);
  assert.ok(r.hazards.detourM! > 0);
});

test("all_routes_flooded: forced centre behind floodwater → no route, alternatives, no silent switch", () => {
  const r = route({ centreId: "test-smk-kuala-krai" });
  assert.equal(r.reason, "all_routes_flooded");
  assert.equal(r.centre, null);
  assert.ok(r.alternatives.some((a) => a.centreId === "test-sk-manik-urai" && a.status === "ok"));
});

test("off_network: says how far the origin is from a road", () => {
  const r = route({ from: [101.5, 4.5] });
  assert.equal(r.reason, "off_network");
  assert.equal(r.origin.snapped, null);
  assert.ok(r.origin.snapDistanceM! > 2000);
  assert.match(r.message, /km from the nearest mapped road/);
});

test("boat → unsupported_mode (no navigable-water data, no boat route claimed)", () => {
  const r = route({ travel: "boat" });
  assert.equal(r.reason, "unsupported_mode");
  assert.equal(r.hazards.status, "unknown");
  assert.match(r.message, /no navigable-water data/);
});

test("centre_unavailable: requested centre missing, at risk or full — alternatives listed", () => {
  assert.equal(route({ centreId: "nope" }).reason, "centre_unavailable");
  const atRisk = centres.map((c) => (c._id === "test-sk-manik-urai" ? { ...c, status: "at_risk" as const } : c));
  const r = route({ centres: atRisk, centreId: "test-sk-manik-urai" });
  assert.equal(r.reason, "centre_unavailable");
  assert.match(r.message, /at risk/);
  const full = route({ centreId: "test-sk-manik-urai", people: 51 }); // 50 free
  assert.equal(full.reason, "centre_unavailable");
  assert.match(full.message, /has 50 free places; your group needs 51/);
  assert.ok(full.alternatives.length > 0);
});

test("people > free places: centres without room are skipped; none left → no_centre_with_space", () => {
  const r = route({ people: 60 }); // SK Manik Urai has 50 free → skipped
  assert.notEqual(r.centre?.id, "test-sk-manik-urai");
  assert.equal(route({ people: 10_000 }).reason, "no_centre_with_space");
});

test("no hazard data: route still planned, every segment unknown, crossesFlood null", () => {
  const r = route({ hazards: { statusOf: null, floodedIds: [], landslideRoadIds: null, assessedAt: null, source: null, notes: [] } });
  assert.equal(r.status, "ok");
  assert.equal(r.hazards.status, "unknown");
  assert.equal(r.hazards.crossesFlood, null);
  assert.equal(r.hazards.segments.unknown, r.hazards.segments.flooded + r.hazards.segments.clear + r.hazards.segments.outsideFloodplain + r.hazards.segments.unknown);
  assert.ok(r.limitations.some((l) => /NOT been checked for flooding/.test(l)));
});

test("partly assessed route → partial, crossesFlood null", () => {
  const r = route({ hazards: { ...known, statusOf: (id) => (id === "t1:0" ? "unknown" : flooded.has(id) ? "flooded" : "clear") } });
  if (r.hazards.segments.unknown > 0) {
    assert.equal(r.hazards.status, "partial");
    assert.equal(r.hazards.crossesFlood, null);
  }
});

test("no road network → no_routing_data", () => {
  assert.equal(route({ graph: null }).reason, "no_routing_data");
});
