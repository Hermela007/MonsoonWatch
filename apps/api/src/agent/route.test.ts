import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRoadGraph, planRoute } from "./route";
import { makeSampleSituation } from "./sample/kelantan-test";

const s = makeSampleSituation();
const graph = buildRoadGraph(s.roads);
const village = (id: string) => s.villages.find((v) => v._id === id)!.location.coordinates;
const centre = (id: string) => s.centres.find((c) => c._id === id)!.location.coordinates;

test("dry road route to the nearby school", () => {
  const r = planRoute(graph, s.hazards.blockedRoadIds, village("test-kg-manik-urai"), centre("test-sk-manik-urai"), "road");
  assert.equal(r.found, true);
  assert.equal(r.crossesFlood, false);
  assert.deepEqual(r.segmentIds, ["t1:0", "t1:1"]);
});

test("every road to SMK Kuala Krai is flooded: road mode not found, boat mode crosses flood", () => {
  const road = planRoute(graph, s.hazards.blockedRoadIds, village("test-kg-manik-urai"), centre("test-smk-kuala-krai"), "road");
  assert.equal(road.found, false);
  assert.equal(road.crossesFlood, true); // fallback path drawn so the route check can reject it
  const boat = planRoute(graph, s.hazards.blockedRoadIds, village("test-kg-manik-urai"), centre("test-smk-kuala-krai"), "boat");
  assert.equal(boat.found, true);
  assert.equal(boat.crossesFlood, true);
});

test("road mode avoids the flooded riverside road when a dry detour exists", () => {
  const r = planRoute(graph, s.hazards.blockedRoadIds, village("test-kg-tualang"), centre("test-dewan-tualang"), "road");
  assert.equal(r.found, true);
  assert.deepEqual(r.segmentIds, ["t4:0", "t4:1"]);
});
