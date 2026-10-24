import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvacCentre, KnowledgeChunk, LngLat, Region, StationWithLatest, Village } from "@monsoonwatch/shared";
import { pointToLineKm } from "./geo";
import { shortlistForArgon, shortlistSummary, situationForPrompt, villageRiskSignals, type Situation } from "./situation";

// ~0.009° ≈ 1 km at 5° N.
const village = (id: string, lngLat: LngLat, population = 100): Village =>
  ({ _id: id, regionId: "t", name: id, altNames: [], location: { type: "Point", coordinates: lngLat }, population, district: "d" });
const centre = (id: string, lngLat: LngLat): EvacCentre =>
  ({ _id: id, regionId: "t", name: id, location: { type: "Point", coordinates: lngLat }, capacity: 100, headcount: 0, elevationM: 50 });
const gauge = (id: string, lngLat: LngLat, value: number | null): StationWithLatest => ({
  _id: id, regionId: "t", kind: "river", name: id, district: "d", location: { type: "Point", coordinates: lngLat },
  thresholds: { normal: 10, alert: 11, warning: 12, danger: 13 },
  latest: value === null ? null : { ts: "2014-12-24T04:00:00Z", value, meta: { stationId: id, kind: "river", source: "jps", mode: "replay" } },
});

function situation(over: Partial<Situation> = {}): Situation {
  return {
    region: { _id: "t", name: "Test", languages: ["ms"], timezone: "Asia/Kuala_Lumpur" } as unknown as Region,
    mode: "replay", now: new Date("2014-12-24T04:00:00Z"),
    stations: [], riskEvents: [], villages: [], centres: [], roads: [], knowledge: [],
    hazards: { blockedRoadIds: [], blockedRoads: { type: "MultiLineString", coordinates: [] }, landslide: { cells: [], runouts: [] } },
    isTestData: true,
    ...over,
  };
}

test("pointToLineKm measures to the segment, not just its vertices", () => {
  // Point 1 km north of the middle of a 20 km east–west segment (vertices 10 km away).
  const km = pointToLineKm([102.0, 5.009], [[101.91, 5.0], [102.09, 5.0]]);
  assert.ok(Math.abs(km - 1.0) < 0.05, `got ${km}`);
});

test("each signal type puts a village on the shortlist; quiet villages are left out", () => {
  const s = situation({
    stations: [gauge("g-warn", [102.0, 5.0], 12.4), gauge("g-normal", [102.5, 5.5], 10.2)],
    riskEvents: [{ _id: "re1", regionId: "t", ts: "2014-12-24T04:00:00Z", type: "rain_accumulation", stationId: "g-normal", level: "alert", value: 60, threshold: 47.66, message: "m", source: "stream_processing" }],
    villages: [
      village("near-gauge", [102.05, 5.0]), // ~5.5 km from the WARNING gauge
      village("near-event", [102.5, 5.52]), // ~2 km from the station with an ALERT rain event
      village("by-road", [103.0, 5.004]), // ~0.45 km from a flooded road
      village("by-runout", [104.0, 6.005]), // ~0.55 km from a DANGER runout
      village("quiet", [105.0, 7.0]),
    ],
    hazards: {
      blockedRoadIds: ["r1"],
      blockedRoads: { type: "MultiLineString", coordinates: [[[102.95, 5.0], [103.05, 5.0]]] },
      landslide: { cells: [], runouts: [{ type: "LineString", coordinates: [[103.99, 6.0], [104.01, 6.0]], risk: 0.9 }] },
    },
  });
  const sig = villageRiskSignals(s);
  assert.deepEqual(sig.get("near-gauge")!.map((x) => [x.kind, x.level]), [["gauge", "warning"]]);
  assert.deepEqual(sig.get("near-event")!.map((x) => [x.kind, x.level]), [["risk_event", "alert"]]);
  assert.deepEqual(sig.get("by-road")!.map((x) => x.kind), ["flooded_road"]);
  assert.deepEqual(sig.get("by-runout")!.map((x) => [x.kind, x.level]), [["landslide_runout", "danger"]]);
  assert.equal(sig.has("quiet"), false); // a gauge at NORMAL is not a signal

  const sl = shortlistForArgon(s);
  // Most at-risk first: DANGER, WARNING, then ALERT-ranked (bigger population would break ties).
  assert.deepEqual(sl.villages.map((v) => v.village._id), ["by-runout", "near-gauge", "by-road", "near-event"]);
  assert.equal(sl.omitted.villagesNoSignal, 1);
  assert.match(shortlistSummary(sl), /1 villages with no risk signal not sent/);
  assert.match(shortlistSummary(sl), /left out ≠ safe/);
});

test("caps villages at the most at-risk, keeps nearby centres only, stations with a reading", () => {
  const villages = Array.from({ length: 50 }, (_, i) => village(`v${String(i).padStart(2, "0")}`, [102.0 + i * 0.001, 5.0], 1000 - i));
  const s = situation({
    stations: [gauge("g", [102.0, 5.0], 13.5), gauge("silent", [102.2, 5.2], null)],
    villages,
    centres: [centre("c-near", [102.05, 5.05]), centre("c-far", [103.0, 6.0])],
    knowledge: Array.from({ length: 15 }, (_, i) => ({ _id: `k${i}`, regionId: "t", kind: i === 14 ? "postmortem" : "other", title: `k${i}`, chunk: "x" }) as KnowledgeChunk),
  });
  const sl = shortlistForArgon(s);
  assert.equal(sl.villages.length, 40);
  assert.equal(sl.villages[0]!.village._id, "v00"); // same level → larger population first
  assert.equal(sl.omitted.villagesOverCap, 10);
  assert.deepEqual(sl.centres.map((c) => c._id), ["c-near"]); // c-far is > 15 km away
  assert.deepEqual(sl.stations.map((st) => st._id), ["g"]);
  assert.equal(sl.knowledge.length, 10);
  assert.equal(sl.knowledge[0]!._id, "k14"); // post-mortems first
});

test("same level: a hazard at the village beats a nearer gauge; then the nearer gauge wins; one gauge signal each", () => {
  const s = situation({
    stations: [gauge("g1", [102.0, 5.0], 12.5), gauge("g2", [102.02, 5.0], 12.6)],
    villages: [
      village("close", [102.0, 5.01], 10), // ~1.1 km from g1, no flooded road
      village("far", [102.0, 5.05], 10), // ~5.5 km from g1
      village("flooded", [102.0, 5.08], 10), // ~8.9 km from g1, but next to a flooded road
    ],
    hazards: {
      blockedRoadIds: ["r1"],
      blockedRoads: { type: "MultiLineString", coordinates: [[[101.99, 5.081], [102.01, 5.081]]] },
      landslide: { cells: [], runouts: [] },
    },
  });
  const sl = shortlistForArgon(s);
  assert.deepEqual(sl.villages.map((v) => v.village._id), ["flooded", "close", "far"]);
  assert.equal(sl.villages[1]!.signals.filter((x) => x.kind === "gauge").length, 1); // g1 and g2 both in range
  assert.match(sl.villages[1]!.signals[0]!.text, /^gauge g1 WARNING 1\.1 km$/);
});

test("prompt: shortlisted by default, coordinates rounded to 4 dp, full view keeps everything", () => {
  const s = situation({
    stations: [gauge("g", [102.123456789, 5.987654321], 12.5)],
    villages: [village("hit", [102.12349, 5.98761]), village("quiet", [104.0, 7.0])],
  });
  const p = situationForPrompt(s);
  assert.deepEqual(p.villages.map((v) => v.id), ["hit"]);
  assert.deepEqual(p.villages[0]!.lngLat, [102.1235, 5.9876]);
  assert.deepEqual(p.stations[0]!.lngLat, [102.1235, 5.9877]);
  assert.ok(p.villages[0]!.riskSignals?.[0]?.startsWith("gauge g WARNING"));
  assert.match(String(p.shortlist), /not checked as safe/);

  const full = situationForPrompt(s, { full: true });
  assert.equal(full.villages.length, 2);
  assert.equal("shortlist" in full, false);
});
