import { test } from "node:test";
import assert from "node:assert/strict";
import { evacuationRoute, type HazardInfo } from "./evacuate";
import { buildRoadGraph } from "./route";
import { makeSampleSituation } from "./sample/kelantan-test";

const s = makeSampleSituation();
const graph = buildRoadGraph(s.roads);
const known: HazardInfo = { blockedRoadIds: s.hazards.blockedRoadIds, assessedRoadIds: new Set(s.roads.map((r) => r.properties.id)), runouts: [], notes: [] };
const village = (id: string) => s.villages.find((v) => v._id === id)!.location.coordinates;
const manik = village("test-kg-manik-urai");
const tualang = village("test-kg-tualang");

test("car from Manik Urai: nearest centre with a dry road, road-following geometry, steps", () => {
  const r = evacuationRoute({ graph, centres: s.centres, hazards: known, from: manik, travel: "car" });
  assert.equal(r.status, "ok");
  assert.equal(r.centre!.id, "test-sk-manik-urai");
  assert.equal(r.hazards.status, "assessed");
  assert.equal(r.hazards.crossesFlood, false);
  assert.ok(r.geometry!.coordinates.length >= 3, "follows road segments, not a 2-point line");
  assert.match(r.steps![0]!.instruction, /^Drive .* on Jalan Manik Urai$/);
  assert.match(r.steps!.at(-1)!.instruction, /^Arrive at SK Manik Urai/);
  assert.ok(r.durationMin! >= 1);
  assert.ok(r.alternatives.some((a) => a.centreId === "test-smk-kuala-krai" && a.status === "no_route" && a.reason === "all_routes_flooded"));
});

test("forced centre behind floodwater: car fails honestly, boat succeeds and says so", () => {
  const car = evacuationRoute({ graph, centres: s.centres, hazards: known, from: manik, travel: "car", centreId: "test-smk-kuala-krai" });
  assert.equal(car.status, "no_route");
  assert.equal(car.reason, "all_routes_flooded");
  assert.equal(car.geometry, undefined, "no geometry for a failed route");
  const boat = evacuationRoute({ graph, centres: s.centres, hazards: known, from: manik, travel: "boat", centreId: "test-smk-kuala-krai" });
  assert.equal(boat.status, "ok");
  assert.equal(boat.hazards.crossesFlood, true);
  assert.ok(boat.limitations.some((l) => /stand-in for navigable water/.test(l)));
});

test("Tualang: avoids the flooded riverside road and reports the detour", () => {
  const r = evacuationRoute({ graph, centres: s.centres, hazards: known, from: tualang, travel: "car", centreId: "test-dewan-tualang" });
  assert.equal(r.status, "ok");
  assert.equal(r.hazards.floodedSegmentsAvoided, 1);
  assert.ok(r.hazards.detourM > 0);
});

test("missing hazard data is 'unknown', unassessed segments make it 'partial' — never 'safe'", () => {
  const none = evacuationRoute({ graph, centres: s.centres, hazards: { blockedRoadIds: null, assessedRoadIds: null, runouts: [], notes: [] }, from: manik, travel: "car" });
  assert.equal(none.hazards.status, "unknown");
  assert.ok(none.limitations.some((l) => /NOT been checked for flooding/.test(l)));
  const some = evacuationRoute({ graph, centres: s.centres, hazards: { ...known, assessedRoadIds: new Set(["t1:0"]) }, from: manik, travel: "car" });
  assert.equal(some.hazards.status, "partial");
  assert.equal(some.hazards.unassessedSegments, 1);
});

test("off the road network, full centres, unknown centre ids", () => {
  const far = evacuationRoute({ graph, centres: s.centres, hazards: known, from: [manik[0] + 0.2, manik[1]], travel: "walk" });
  assert.equal(far.status, "no_route");
  assert.equal(far.reason, "off_network");
  assert.match(far.message, /km from the nearest mapped road/);
  const full = s.centres.map((c) => ({ ...c, headcount: c.capacity }));
  assert.equal(evacuationRoute({ graph, centres: full, hazards: known, from: manik, travel: "car" }).reason, "no_centre_with_space");
  assert.equal(evacuationRoute({ graph, centres: s.centres, hazards: known, from: manik, travel: "car", centreId: "nope" }).reason, "centre_unavailable");
});
