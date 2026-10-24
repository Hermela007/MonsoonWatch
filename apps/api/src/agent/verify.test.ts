import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert, EvacCentre, Reading, Station, Village } from "@monsoonwatch/shared";
import { allPassed, checkVillageSplit, failureReasons, levelFromThresholds, verifyAlert, type VerifyContext } from "./verify";

const village: Village = {
  _id: "v1", regionId: "kelantan", name: "Kg. Manik Urai", altNames: [],
  location: { type: "Point", coordinates: [102.2, 5.3] }, population: 300, district: "Kuala Krai",
};
const centre: EvacCentre = {
  _id: "c1", regionId: "kelantan", name: "SK Manik Urai",
  location: { type: "Point", coordinates: [102.22, 5.32] }, capacity: 500, headcount: 100, elevationM: 60,
};
const station: Station = {
  _id: "s1", regionId: "kelantan", kind: "river", name: "Sg. Lebir @ Kg. Tualang", district: "Kuala Krai",
  location: { type: "Point", coordinates: [102.25, 5.28] }, thresholds: { normal: 30, alert: 32, warning: 34, danger: 35 },
};
const now = new Date("2026-10-24T10:00:00Z");
const reading: Reading = {
  ts: "2026-10-24T09:50:00Z", value: 34.5,
  meta: { stationId: "s1", kind: "river", source: "jps", mode: "live" },
};

function makeAlert(over: Partial<Alert> = {}): Alert {
  return {
    _id: "a1", regionId: "kelantan", runId: "r1", villageId: "v1", level: "warning", hazard: "flood",
    evacCentreId: "c1", people: 300,
    route: { type: "LineString", coordinates: [[102.2, 5.3], [102.2, 5.32], [102.22, 5.32]] },
    messages: [{ lang: "ms", text: "AMARAN banjir" }, { lang: "en", text: "WARNING: flood" }],
    verification: [], status: "draft", ...over,
  };
}

function makeCtx(over: Partial<VerifyContext> = {}): VerifyContext {
  return {
    region: { languages: ["ms", "en"] }, mode: "live", now, village, centre,
    evidence: { station, latestReading: reading, riskEvents: [] },
    hazards: { blockedRoads: { type: "MultiLineString", coordinates: [[[102.205, 5.31], [102.215, 5.3]]] }, landslide: { cells: [], runouts: [] } },
    ...over,
  };
}

test("levels from JPS thresholds", () => {
  assert.equal(levelFromThresholds(31, station.thresholds!), "normal");
  assert.equal(levelFromThresholds(34.5, station.thresholds!), "warning");
  assert.equal(levelFromThresholds(35, station.thresholds!), "danger");
});

test("clean alert passes all five checks", () => {
  const r = verifyAlert(makeAlert(), makeCtx());
  assert.equal(allPassed(r), true, failureReasons(r));
});

test("route across a flooded road fails, replanned route passes", () => {
  const bad = makeAlert({ route: { type: "LineString", coordinates: [[102.2, 5.3], [102.21, 5.31], [102.22, 5.32]] } });
  const r = verifyAlert(bad, makeCtx());
  assert.equal(r.find((x) => x.check === "route")!.passed, false);
  assert.match(failureReasons(r), /flooded road/);
});

test("overclaiming the level fails the threshold check", () => {
  const r = verifyAlert(makeAlert({ level: "danger" }), makeCtx());
  assert.equal(r.find((x) => x.check === "threshold")!.passed, false);
});

test("stale live reading fails freshness; replay mode skips it", () => {
  const old = { ...reading, ts: "2026-10-24T07:00:00Z" };
  const live = verifyAlert(makeAlert(), makeCtx({ evidence: { station, latestReading: old, riskEvents: [] } }));
  assert.equal(live.find((x) => x.check === "freshness")!.passed, false);
  const replay = verifyAlert(makeAlert(), makeCtx({ mode: "replay", evidence: { station, latestReading: old, riskEvents: [] } }));
  assert.equal(replay.find((x) => x.check === "freshness")!.passed, true);
});

test("message headline must match the alert level (a DANGER alert can't say 'FLOOD WARNING')", () => {
  const danger = makeAlert({ level: "danger", messages: [{ lang: "ms", text: "BAHAYA banjir" }, { lang: "en", text: "FLOOD WARNING: go now" }] });
  const r = verifyAlert(danger, makeCtx()).find((x) => x.check === "language")!;
  assert.equal(r.passed, false);
  assert.match(r.detail, /en must start with "DANGER"/);
  const ok = makeAlert({ messages: [{ lang: "ms", text: "  amaran banjir" }, { lang: "en", text: "Warning: flood" }] }); // case-insensitive, leading spaces ok
  assert.equal(verifyAlert(ok, makeCtx()).find((x) => x.check === "language")!.passed, true);
});

test("missing Malay message fails the language check", () => {
  const r = verifyAlert(makeAlert({ messages: [{ lang: "en", text: "Flood warning" }] }), makeCtx());
  assert.equal(r.find((x) => x.check === "language")!.passed, false);
});

test("capacity uses alert.people; village split must add up", () => {
  const full = { ...centre, headcount: 450 };
  assert.equal(verifyAlert(makeAlert(), makeCtx({ centre: full })).find((x) => x.check === "capacity")!.passed, false);

  const c2: EvacCentre = { ...centre, _id: "c2", name: "SMK Dabong", headcount: 0, capacity: 200 };
  const split = [
    { villageId: "v1", evacCentreId: "c1", people: 150 },
    { villageId: "v1", evacCentreId: "c2", people: 150 },
  ];
  assert.equal(checkVillageSplit(split, village, [centre, c2]).passed, true);
  assert.equal(checkVillageSplit(split.slice(0, 1), village, [centre, c2]).passed, false);
});

test("replay: flood claim backed by a GloFAS river_threshold event (approximate)", () => {
  const glofas = {
    _id: "glofas-5.775-102.125:river_threshold:warning:x", regionId: "kelantan", ts: "2014-12-23T00:00:00Z",
    type: "river_threshold" as const, stationId: "glofas-5.775-102.125", level: "warning" as const,
    value: 3400, threshold: 3000, message: "", source: "stream_processing" as const,
  };
  const ctx = makeCtx({ mode: "replay", evidence: { riskEvents: [glofas] } });
  const ok = verifyAlert(makeAlert({ level: "warning" }), ctx).find((x) => x.check === "threshold")!;
  assert.equal(ok.passed, true);
  assert.match(ok.detail, /GloFAS, approximate/);
  assert.equal(verifyAlert(makeAlert({ level: "danger" }), ctx).find((x) => x.check === "threshold")!.passed, false);
});
