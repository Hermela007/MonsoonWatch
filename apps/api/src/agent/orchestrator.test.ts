// The plan → verify → replan loop with a scripted planner (no network). The real planners are
// Gemini (gemini-planners.ts); this checks the deterministic machinery around them.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAI } from "./gemini-planners";
import { runAgent, stopAgentRun } from "./orchestrator";
import { shortlistForArgon } from "./shortlist";
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
    async draftVillage(task) {
      calls.push(`${task.village._id}:draft`);
      return task.village._id === "test-kg-tualang" ? tualang : naive;
    },
    async planVillage(task, feedback) {
      calls.push(`${task.village._id}:${feedback ? "refine" : "plan"}`);
      if (task.village._id === "test-kg-tualang") return { plan: tualang };
      return { plan: fixed };
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
  assert.deepEqual(ai.calls.sort(), ["test-kg-manik-urai:draft", "test-kg-manik-urai:refine", "test-kg-tualang:draft"]);

  const steps = getMemorySteps("t-run-1");
  const failed = steps.filter((s) => s.kind === "verify" && s.status === "fail").map((s) => s.summary).join("\n");
  assert.match(failed, /capacity FAILED/);
  assert.match(failed, /12 of 12 bedridden/);
  assert.match(failed, /unknown village id "made-up-village"/);
  assert.ok(steps.some((s) => /Kg\. Manik Urai: all checks passed on attempt 2/.test(s.summary)));
});

test("a village that never passes stays draft (not approvable) after draft + 3 refines", async () => {
  const ai = scriptedAI();
  ai.planVillage = async (task) => ({ plan: task.village._id === "test-kg-tualang" ? tualang : naive });
  const { outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-2" });
  const manik = outcomes.find((o) => o.villageId === "test-kg-manik-urai")!;
  assert.equal(manik.passed, false);
  assert.equal(manik.attempts, 4);
  assert.ok(manik.alerts.every((a) => a.status === "draft"));
});

test("a road route through floodwater fails the route check", async () => {
  const ai = scriptedAI();
  const bad: VillagePlan = structuredClone(fixed);
  bad.groups[0]!.routeMode = "road";
  ai.draftVillage = async (task) => (task.village._id === "test-kg-tualang" ? tualang : bad);
  ai.planVillage = async (task) => ({ plan: task.village._id === "test-kg-tualang" ? tualang : bad });
  const { outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-3" });
  const route = outcomes.find((o) => o.villageId === "test-kg-manik-urai")!.alerts[0]!.verification.find((r) => r.check === "route" && !r.passed);
  assert.ok(route, "expected a failed route check");
  assert.match(route.detail, /flooded road segment|No dry road route/);
});

test("if the draft call itself fails, Flash plans from scratch", async () => {
  const ai = scriptedAI();
  ai.draftVillage = async () => { throw new Error("Flash-Lite unavailable"); };
  const { outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-4" });
  assert.ok(outcomes.every((o) => o.passed));
  assert.ok(getMemorySteps("t-run-4").some((st) => st.actor === "Gemini 3.5 Flash-Lite" && st.status === "fail"));
});

function manyVillages() {
  const base = makeSampleSituation();
  const extra = Array.from({ length: 8 }, (_, i) => ({ ...base.villages[2]!, _id: `test-extra-${i}`, name: `Extra ${i}` }));
  const situation = { ...base, villages: [...base.villages, ...extra] };
  const ai = scriptedAI();
  ai.planSituation = async () => ({
    summary: "many",
    villages: [
      ...extra.map((v) => ({ villageId: v._id, hazard: "flood" as const, level: "alert" as const, etaHours: 10, stationId: "test-lebir-tualang", riskEventIds: [], reasoning: "x" })),
      { villageId: "test-kg-manik-urai", hazard: "flood" as const, level: "danger" as const, etaHours: 6, stationId: "test-galas-dabong", riskEventIds: ["test-re-galas"], reasoning: "x" },
    ],
  });
  ai.draftVillage = async (task) => (task.village._id === "test-kg-manik-urai" ? fixed : tualang);
  return { situation, ai };
}

test("Argon's villages are planned in batches of MAX_VILLAGES_PER_RUN, most urgent first, until all are done", async () => {
  const { situation, ai } = manyVillages();
  const { outcomes, coverage } = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-cap" });
  assert.deepEqual(coverage.batches.map((b) => b.length), [6, 3]);
  assert.equal(outcomes.length, 9); // batch 2 (queued) ran too
  assert.equal(outcomes[0]!.villageId, "test-kg-manik-urai"); // danger first
  const steps = getMemorySteps("t-run-cap");
  assert.ok(steps.some((st) => /6 planned now, 3 queued in 1 later batch/.test(st.summary)));
  assert.ok(steps.some((st) => /Batch 2\/2: planning 3 queued village/.test(st.summary)));
});

test("stopping a run before its next batch moves the queued villages out of planning", async () => {
  const { situation, ai } = manyVillages();
  const draft = ai.draftVillage;
  ai.draftVillage = async (task) => {
    stopAgentRun("t-run-stop"); // operator presses stop while batch 1 is being planned
    return draft(task);
  };
  const { outcomes, coverage } = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-stop" });
  assert.equal(outcomes.length, 6);
  assert.equal(coverage.batches.length, 1);
  assert.ok(getMemorySteps("t-run-stop").some((st) => /Stopped before batch 2: 3 queued village\(s\) moved to area-wide warnings/.test(st.summary)));
});

test("end to end: every at-risk village from the screen is planned or in an area-wide warning", async () => {
  const situation = makeSampleSituation();
  const atRisk = shortlistForArgon(situation).screen.atRisk.map((r) => r.village._id);
  assert.ok(atRisk.length > 0, "sample scenario should have at-risk villages");
  const ai = scriptedAI();
  ai.planSituation = async () => ({ summary: "none confirmed", villages: [] }); // worst case: Argon names nobody
  const { outcomes, areaWarnings } = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-run-cover" });
  const covered = new Set([...outcomes.map((o) => o.villageId), ...areaWarnings.flatMap((w) => w.villageIds)]);
  for (const id of atRisk) assert.ok(covered.has(id), `${id} left without plan or area-wide warning`);
  assert.ok(areaWarnings.every((w) => w.status === "needs_approval"));
  assert.ok(getMemorySteps("t-run-cover").some((st) => /Coverage of \d+ at-risk villages: 0 planned now/.test(st.summary)));
});
