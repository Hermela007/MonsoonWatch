// The plan → verify → replan loop with a scripted planner (no network). The real planners are
// Gemini (gemini-planners.ts); this checks the deterministic machinery around them.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAI } from "./gemini-planners";
import { runAgent } from "./orchestrator";
import { makeSampleSituation } from "./sample/kelantan-test";
import type { VillagePlan } from "./schemas";
import { getMemorySteps, memoryStepSink, setStepSink } from "./steps";
import { memoryStore } from "./store";

before(() => setStepSink(memoryStepSink)); // never write to a real DB from tests

const msg = (ms: string, en: string) => [{ lang: "ms", text: ms }, { lang: "en", text: en }];

// Attempt 1 for Manik Urai: everyone to the nearest school (only 50 places), bedridden forgotten.
const naive: VillagePlan = {
  reasoning: "Nearest centre.",
  groups: [{
    evacCentreId: "test-sk-manik-urai", people: 300, routeMode: "road",
    pickups: [
      { category: "disabled", people: 8, vehicle: "ambulance", order: 1 },
      { category: "elderly", people: 40, vehicle: "bus", order: 2 },
      { category: "noTransport", people: 25, vehicle: "bus", order: 3 },
    ],
    messages: msg("Amaran banjir. Pergi ke SK Manik Urai.", "Flood warning. Go to SK Manik Urai."),
  }],
};

// Attempt 2: split — 50 by dry road to the school, 250 by boat to Kuala Krai; bedridden first by boat.
const fixed: VillagePlan = {
  reasoning: "School is nearly full and roads to Kuala Krai are flooded.",
  groups: [
    {
      evacCentreId: "test-smk-kuala-krai", people: 250, routeMode: "boat",
      pickups: [
        { category: "bedridden", people: 12, vehicle: "boat", order: 1 },
        { category: "disabled", people: 8, vehicle: "boat", order: 2 },
        { category: "elderly", people: 40, vehicle: "boat", order: 3 },
      ],
      messages: msg("Amaran banjir. Bot ke SMK Kuala Krai.", "Flood warning. Boats to SMK Kuala Krai."),
    },
    {
      evacCentreId: "test-sk-manik-urai", people: 50, routeMode: "road",
      pickups: [{ category: "noTransport", people: 25, vehicle: "bus", order: 4 }],
      messages: msg("Amaran banjir. Bas ke SK Manik Urai.", "Flood warning. Bus to SK Manik Urai."),
    },
  ],
};

const tualang: VillagePlan = {
  reasoning: "Dry road to the hall.",
  groups: [{
    evacCentreId: "test-dewan-tualang", people: 180, routeMode: "road",
    pickups: [
      { category: "bedridden", people: 4, vehicle: "ambulance", order: 1 },
      { category: "disabled", people: 3, vehicle: "ambulance", order: 2 },
      { category: "elderly", people: 20, vehicle: "bus", order: 3 },
      { category: "noTransport", people: 10, vehicle: "bus", order: 4 },
    ],
    messages: msg("Amaran banjir. Pergi ke Dewan Tualang.", "Flood warning. Go to Dewan Tualang."),
  }],
};

function scriptedAI(): AgentAI & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async planSituation() {
      return {
        summary: "Sg. Galas at DANGER, Sg. Lebir at WARNING",
        villages: [
          { villageId: "test-kg-manik-urai", hazard: "flood", level: "danger", etaHours: 6, stationId: "test-galas-dabong", riskEventIds: ["test-re-galas"], reasoning: "Downstream of Galas." },
          { villageId: "test-kg-tualang", hazard: "flood", level: "warning", etaHours: 3, stationId: "test-lebir-tualang", riskEventIds: ["test-re-lebir"], reasoning: "At the Lebir station." },
          { villageId: "made-up-village", hazard: "flood", level: "alert", etaHours: null, stationId: null, riskEventIds: [], reasoning: "hallucinated" },
        ],
      };
    },
    async planVillage(task, feedback) {
      calls.push(`${task.village._id}:${feedback ? "replan" : "plan"}`);
      if (task.village._id === "test-kg-tualang") return { plan: tualang };
      return { plan: feedback ? fixed : naive, interactionId: "i-1" };
    },
  };
}

test("fail → replan → pass for Manik Urai; Tualang passes first time; unknown village ignored", async () => {
  const ai = scriptedAI();
  const store = memoryStore();
  const { run, outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, ai, store, runId: "t-run-1" });

  assert.equal(run.status, "done");
  assert.equal(outcomes.length, 2);
  const manik = outcomes.find((o) => o.villageId === "test-kg-manik-urai")!;
  assert.equal(manik.passed, true);
  assert.equal(manik.attempts, 2);
  assert.equal(manik.alerts.length, 2);
  assert.ok(manik.alerts.every((a) => a.status === "verified"));
  assert.equal(outcomes.find((o) => o.villageId === "test-kg-tualang")!.attempts, 1);
  assert.deepEqual(ai.calls.sort(), ["test-kg-manik-urai:plan", "test-kg-manik-urai:replan", "test-kg-tualang:plan"]);

  const steps = getMemorySteps("t-run-1");
  const failed = steps.filter((s) => s.kind === "verify" && s.status === "fail").map((s) => s.summary).join("\n");
  assert.match(failed, /capacity FAILED/);
  assert.match(failed, /12 of 12 bedridden/);
  assert.match(failed, /unknown village id "made-up-village"/);
  assert.ok(steps.some((s) => /Kg\. Manik Urai: all checks passed on attempt 2/.test(s.summary)));
});

test("a village that never passes stays draft (not approvable) after 3 attempts", async () => {
  const ai = scriptedAI();
  ai.planVillage = async (task) => ({ plan: task.village._id === "test-kg-tualang" ? tualang : naive });
  const { outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-2" });
  const manik = outcomes.find((o) => o.villageId === "test-kg-manik-urai")!;
  assert.equal(manik.passed, false);
  assert.equal(manik.attempts, 3);
  assert.ok(manik.alerts.every((a) => a.status === "draft"));
});

test("a road route through floodwater fails the route check", async () => {
  const ai = scriptedAI();
  const bad: VillagePlan = structuredClone(fixed);
  bad.groups[0]!.routeMode = "road";
  ai.planVillage = async (task) => ({ plan: task.village._id === "test-kg-tualang" ? tualang : bad });
  const { outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-3" });
  const route = outcomes.find((o) => o.villageId === "test-kg-manik-urai")!.alerts[0]!.verification.find((r) => r.check === "route" && !r.passed);
  assert.ok(route, "expected a failed route check");
  assert.match(route.detail, /flooded road segment|No dry road route/);
});
