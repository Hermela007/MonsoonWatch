import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEscalations, checkEscalation, escalateScreen, unsupportedNumbers } from "./escalation";
import { makeSampleSituation } from "./sample/kelantan-test";
import type { Escalation } from "./schemas";
import type { RiskScreen } from "./shortlist";

function setup() {
  const s = makeSampleSituation();
  const bukit = s.villages.find((v) => v._id === "test-kg-bukit-raja")!;
  const near = { ...bukit, _id: "test-kg-near", name: "Kg. Near (test)", location: { type: "Point" as const, coordinates: [102.05, 5.42] as [number, number] } };
  s.villages.push(near);
  const screen: RiskScreen = { atRisk: [], watch: [{ village: near, level: "danger" }], unknown: [{ village: bukit, reason: "no gauge" }], noSignal: [] };
  return { s, screen, near, bukit };
}

const base: Escalation = {
  villageId: "test-kg-near", hazard: "flood", level: "danger", etaHours: 4, stationId: "test-galas-dabong",
  sourceTitle: "Test note (not a real document)", quote: "low sections of Jalan Kuala Krai flood first",
  reasoning: "Downstream of Galas at DANGER; the note says these roads flood first.",
};

test("a watch village with a supporting gauge and a verbatim quote is escalated", () => {
  const { s, screen } = setup();
  const v = checkEscalation(base, s, screen);
  assert.equal(v.accepted, true, v.detail);
  assert.match(v.detail, /watch → DANGER flood.*cites "Test note/);
});

test("overclaims, invented quotes, far stations and non-advisory villages are rejected", () => {
  const { s, screen } = setup();
  const no = (e: Partial<Escalation>, re: RegExp) => {
    const v = checkEscalation({ ...base, ...e }, s, screen);
    assert.equal(v.accepted, false);
    assert.match(v.detail, re);
  };
  no({ stationId: "test-lebir-tualang" }, /overclaim/); // Lebir is WARNING, claim is DANGER
  no({ quote: "the whole village flooded to the rooftops in 2014" }, /quote not found verbatim/);
  no({ sourceTitle: "A report that does not exist" }, /not found/);
  no({ stationId: null }, /must cite a river station/);
  no({ villageId: "test-kg-bukit-raja", level: "warning", stationId: "test-lebir-tualang" }, /km away/);
  no({ villageId: "test-kg-manik-urai" }, /assessed its roads as clear/);
  no({ villageId: "made-up" }, /unknown village id/);
});

test("accepted escalations move from advisory to at risk; accounting stays exact", () => {
  const { s, screen } = setup();
  const { risks, claims } = applyEscalations([checkEscalation(base, s, screen), checkEscalation(base, s, screen)]);
  assert.equal(risks.length, 1); // duplicates collapse
  assert.equal(claims[0]!.stationId, "test-galas-dabong");
  assert.equal(risks[0]!.signals[0]!.kind, "argon_escalation");
  const after = escalateScreen(screen, risks);
  assert.deepEqual([after.atRisk.length, after.watch.length, after.unknown.length], [1, 0, 1]);
});

test("sitrep numbers that aren't in the input are flagged", () => {
  const input = JSON.stringify({ stations: [{ value: 44.3 }], villages: 765, people: 12400 });
  assert.deepEqual(unsupportedNumbers("Galas at 44.3 m; 765 villages screened; 12,400 people.", input), []);
  assert.deepEqual(unsupportedNumbers("About 9,000 people must move.", input), ["9,000"]);
});
