import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvacCentre, KnowledgeChunk, LngLat, Region, RoadFeature, StationWithLatest, Village } from "@monsoonwatch/shared";
import { pointToLineKm } from "./geo";
import { compareRisk, screenVillages, shortlistForArgon, shortlistSummary, type VillageRisk } from "./shortlist";
import { situationForPrompt, type Situation } from "./situation";

// ~0.009° ≈ 1 km at 5° N.
const village = (id: string, lngLat: LngLat, population = 100, district = "d"): Village =>
  ({ _id: id, regionId: "t", name: id, altNames: [], location: { type: "Point", coordinates: lngLat }, population, district });
const centre = (id: string, lngLat: LngLat): EvacCentre =>
  ({ _id: id, regionId: "t", name: id, location: { type: "Point", coordinates: lngLat }, capacity: 100, headcount: 0, elevationM: 50 });
const gauge = (id: string, lngLat: LngLat, value: number | null): StationWithLatest => ({
  _id: id, regionId: "t", kind: "river", name: id, district: "d", location: { type: "Point", coordinates: lngLat },
  thresholds: { normal: 10, alert: 11, warning: 12, danger: 13 },
  latest: value === null ? null : { ts: "2014-12-24T04:00:00Z", value, meta: { stationId: id, kind: "river", source: "jps", mode: "replay" } },
});
const road = (id: string, coordinates: LngLat[]): RoadFeature =>
  ({ type: "Feature", id, geometry: { type: "LineString", coordinates }, properties: { id, from: "a", to: "b", highway: "primary", lengthM: 1000 } });

function situation(over: Partial<Situation> = {}): Situation {
  return {
    region: { _id: "t", name: "Test", languages: ["ms", "en"], timezone: "Asia/Kuala_Lumpur" } as unknown as Region,
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

test("at risk only on concrete evidence; a gauge alone is 'watch'; unknown flood-model coverage is not safe", () => {
  const dry = road("dry", [[101.99, 5.045], [102.01, 5.045]]);
  const s = situation({
    stations: [gauge("g-warn", [102.0, 5.0], 12.4)],
    villages: [
      village("flooded", [102.0, 5.02]), // flooded road 0.3 km away; WARNING gauge 2.2 km
      village("gap", [102.02, 5.0]), // WARNING gauge 2.2 km, no assessed road within 1 km
      village("watch", [102.0, 5.045]), // gauge 5 km, assessed road right here and dry
      village("slide", [104.0, 6.005]), // DANGER runout 0.55 km
      village("road-too-far", [103.0, 5.008]), // flooded road 0.9 km (> 0.5), no gauge
      village("quiet", [105.0, 7.0]),
    ],
    roads: [dry],
    assessedRoadIds: new Set(["dry"]),
    hazards: {
      blockedRoadIds: ["r1", "r2"],
      blockedRoads: { type: "MultiLineString", coordinates: [[[101.99, 5.0227], [102.01, 5.0227]], [[102.95, 5.0], [103.05, 5.0]]] },
      landslide: { cells: [], runouts: [{ type: "LineString", coordinates: [[103.99, 6.0], [104.01, 6.0]], risk: 0.9 }] },
    },
  });
  const screen = screenVillages(s);
  assert.deepEqual(screen.atRisk.map((r) => [r.village._id, r.hazard, r.level]), [
    ["slide", "landslide", "danger"],
    ["flooded", "flood", "warning"], // concrete evidence ranks above the flood-model gap
    ["gap", "flood", "warning"],
  ]);
  assert.ok(screen.atRisk[2]!.signals.some((x) => x.kind === "flood_model_gap" && /unknown, not safe/.test(x.text)));
  assert.deepEqual(screen.watch.map((w) => [w.village._id, w.level]), [["watch", "warning"]]);
  // No flooding signal and no assessed road within 1 km: the model can't judge → "unknown" (advisory), never "no signal".
  assert.deepEqual(screen.unknown.map((u) => u.village._id).sort(), ["quiet", "road-too-far"]);
  assert.deepEqual(screen.noSignal, []);
});

test("with C's road status: an 'unknown' nearest road makes a quiet village 'unknown' (advisory), a 'clear' one 'no signal'; near a warning gauge it's at risk", () => {
  const status: Record<string, "clear" | "unknown"> = { rc: "clear", ru: "unknown", rg: "unknown" };
  const s = situation({
    stations: [gauge("g", [103.0, 6.0], 12.5)], // WARNING
    roads: [road("rc", [[102.0, 5.0], [102.01, 5.0]]), road("ru", [[104.0, 5.0], [104.01, 5.0]]), road("rg", [[103.0, 6.01], [103.01, 6.01]])],
    roadStatusOf: (id) => status[id] ?? "unknown",
    villages: [village("clear", [102.005, 5.001]), village("blind", [104.005, 5.001]), village("near-gauge", [103.005, 6.011]), village("no-road", [105.0, 7.0])],
  });
  const sc = screenVillages(s);
  assert.deepEqual(sc.noSignal.map((v) => v._id), ["clear"]);
  assert.deepEqual(sc.unknown.map((u) => [u.village._id, /unknown|no mapped road/.test(u.reason)]), [["blind", true], ["no-road", true]]);
  assert.deepEqual(sc.atRisk.map((r) => [r.village._id, r.signals.at(-1)!.kind]), [["near-gauge", "flood_model_gap"]]);
});

test("without the flood model's assessed set, a village by a warning gauge is at risk (unknown ≠ safe)", () => {
  const s = situation({ stations: [gauge("g", [102.0, 5.0], 12.5)], villages: [village("v", [102.0, 5.01])] });
  assert.equal(screenVillages(s).atRisk[0]?.signals.at(-1)?.kind, "flood_model_gap");
});

test("ranking: level → concrete evidence → nearer warning gauge → vulnerable residents → population", () => {
  const r = (id: string, over: Partial<VillageRisk>): VillageRisk =>
    ({ village: village(id, [0, 0]), level: "warning", hazard: "flood", signals: [], concrete: 1, gaugeKm: 5, vulnerable: 0, ...over });
  const list = [
    r("pop", { village: village("pop", [0, 0], 900) }),
    r("vuln", { vulnerable: 40 }),
    r("near", { gaugeKm: 1 }),
    r("two", { concrete: 2 }),
    r("danger", { level: "danger", concrete: 0, gaugeKm: Infinity }),
    r("base", {}),
  ];
  assert.deepEqual(list.sort(compareRisk).map((x) => x.village._id), ["danger", "two", "near", "vuln", "pop", "base"]);
});

test("caps villages at the most at-risk; over-cap ones are summarised per district; nearby centres only", () => {
  const villages = Array.from({ length: 50 }, (_, i) => village(`v${String(i).padStart(2, "0")}`, [102.0 + i * 0.001, 5.001], 100, i < 45 ? "Kuala Krai" : "Machang"));
  const s = situation({
    stations: [gauge("g", [102.0, 5.0], 13.5), gauge("silent", [102.2, 5.2], null)],
    villages,
    centres: [centre("c-near", [102.05, 5.05]), centre("c-far", [103.0, 6.0])],
    hazards: { blockedRoadIds: ["r"], blockedRoads: { type: "MultiLineString", coordinates: [[[101.99, 5.0], [102.06, 5.0]]] }, landslide: { cells: [], runouts: [] } },
    knowledge: Array.from({ length: 15 }, (_, i) => ({ _id: `k${i}`, regionId: "t", kind: i === 14 ? "postmortem" : "other", title: `k${i}`, chunk: "x" }) as KnowledgeChunk),
  });
  const sl = shortlistForArgon(s);
  assert.equal(sl.villages.length, 40);
  assert.equal(sl.villages[0]!.village._id, "v00"); // all DANGER + flooded road → nearest gauge first
  assert.equal(sl.omitted.atRiskOverCap, 10);
  assert.deepEqual(sl.notSent.map((d) => [d.district, d.atRisk, d.highestLevel, d.floodedRoad]), [["Kuala Krai", 5, "danger", 5], ["Machang", 5, "danger", 5]]);
  assert.deepEqual(sl.centres.map((c) => c._id), ["c-near"]); // c-far is > 15 km away
  assert.deepEqual(sl.stations.map((st) => st._id), ["g"]);
  assert.equal(sl.knowledge.length, 10);
  assert.equal(sl.knowledge[0]!._id, "k14"); // post-mortems first
  assert.match(shortlistSummary(sl), /not sent ≠ safe/);
});

test("prompt: shortlisted by default with screen level, signals and notSentByDistrict; 4 dp; full view keeps everything", () => {
  const s = situation({
    stations: [gauge("g", [102.123456789, 5.987654321], 12.5)],
    villages: [village("hit", [102.12349, 5.98761]), village("quiet", [104.0, 7.0], 100, "Gua Musang")],
  });
  const p = situationForPrompt(s);
  assert.deepEqual(p.villages.map((v) => v.id), ["hit"]);
  assert.deepEqual(p.villages[0]!.lngLat, [102.1235, 5.9876]);
  assert.deepEqual(p.stations[0]!.lngLat, [102.1235, 5.9877]);
  assert.equal(p.villages[0]!.screenLevel, "warning");
  assert.ok(p.villages[0]!.riskSignals?.[0]?.startsWith("gauge g WARNING"));
  assert.deepEqual(p.notSentByDistrict?.map((d) => [d.district, d.unknown]), [["Gua Musang", 1]]);
  assert.match(String(p.shortlist), /not checked as safe/);

  const full = situationForPrompt(s, { full: true });
  assert.equal(full.villages.length, 2);
  assert.equal("shortlist" in full, false);
});
