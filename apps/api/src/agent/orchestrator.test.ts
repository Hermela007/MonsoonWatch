// The plan → verify → replan loop with a scripted planner (no network). The real planners are
// Gemini (gemini-planners.ts); this checks the deterministic machinery around them.
import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentAI } from "./gemini-planners";
import { runAgent, stopAgentRun, type RunResult } from "./orchestrator";
import { shortlistForArgon } from "./shortlist";
import { makeSampleSituation } from "./sample/kelantan-test";
import type { Situation } from "./situation";
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
    messages: msg("BAHAYA banjir. Pergi ke SK Manik Urai.", "DANGER: flood. Go to SK Manik Urai."),
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
      messages: msg("BAHAYA banjir. Bot ke SMK Kuala Krai.", "DANGER: flood. Boats to SMK Kuala Krai."),
    },
    {
      evacCentreId: "test-sk-manik-urai", people: 50, routeMode: "road",
      pickups: [{ category: "noTransport", people: 25, vehicle: "bus", order: 4 }],
      messages: msg("BAHAYA banjir. Bas ke SK Manik Urai.", "DANGER: flood. Bus to SK Manik Urai."),
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
    messages: msg("AMARAN banjir. Pergi ke Dewan Tualang.", "WARNING: flood. Go to Dewan Tualang."),
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
        escalations: [
          { villageId: "test-kg-bukit-raja", hazard: "flood", level: "warning", etaHours: null, stationId: "test-lebir-tualang", sourceTitle: null, quote: null, reasoning: "Far downstream." },
        ],
        sitrep: "Sg. Galas at 44.3 m (DANGER) and Sg. Lebir at 34.6 m (WARNING); about 9999 people affected.",
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

/** Every at-risk village has a verified alert (rules or Gemini) or is in an area-wide fallback warning. */
function assertEveryVillageHasAlert(res: RunResult, situation: Situation) {
  const atRisk = shortlistForArgon(situation).screen.atRisk.map((r) => r.village._id);
  assert.ok(atRisk.length > 0);
  assert.equal(res.atRisk, atRisk.length);
  const verified = new Set([...res.rulesAlerts, ...res.outcomes.filter((o) => o.passed).flatMap((o) => o.alerts)].filter((a) => a.status === "verified").map((a) => a.villageId));
  const areaWide = new Set(res.areaWarnings.flatMap((w) => w.villageIds));
  for (const id of atRisk) {
    const by = res.plannedBy.get(id);
    assert.ok(by, `${id} has no alert`);
    if (by === "area-wide") assert.ok(areaWide.has(id), `${id} marked area-wide but in no warning`);
    else assert.ok(verified.has(id), `${id} marked ${by} but has no verified alert`);
  }
}

test("rules plan both sample villages with no Gemini: Tualang by dry road, Manik Urai 50 by road + 250 by boat", async () => {
  const situation = makeSampleSituation();
  const ai = scriptedAI();
  const res = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-rules-1", tailorTop: 0 });
  assert.deepEqual(ai.calls, []); // only Argon was asked
  assert.equal(res.plannedBy.get("test-kg-tualang"), "rules");
  assert.equal(res.plannedBy.get("test-kg-manik-urai"), "rules");
  const tualang = res.rulesAlerts.find((a) => a.villageId === "test-kg-tualang")!;
  assert.match(tualang._id, /:rules:1$/);
  assert.equal(tualang.status, "verified");
  assert.match(tualang.messages.find((m) => m.lang === "en")!.text, /Dewan Orang Ramai Tualang \(test\) \(\d+\.\d km via Jalan Tualang, Jalan Dewan\)/);
  const manik = res.rulesAlerts.filter((a) => a.villageId === "test-kg-manik-urai");
  assert.deepEqual(manik.map((a) => [a.evacCentreId, a.people]), [["test-sk-manik-urai", 50], ["test-smk-kuala-krai", 250]]);
  assert.ok(manik.flatMap((a) => a.pickups ?? []).every((p) => p.vehicle === "boat"));
  assert.match(manik[1]!.messages.find((m) => m.lang === "en")!.text, /250 residents: rescue boats will take you to SMK Kuala Krai \(test\)/);
  assert.deepEqual(manik.map((a) => a.routeMode), ["road", "boat"]); // boat → UI draws no line
  assert.ok(res.rulesAlerts.every((a) => a.plannedBy === "rules"));
  assert.ok(getMemorySteps("t-rules-1").some((s) => s.actor === "Rules planner" && /2\/2 at-risk villages planned \+ verified; 0 need Gemini/.test(s.summary)));
  assertEveryVillageHasAlert(res, situation);
  // Argon's escalation is checked by code (Bukit Raja is ~70 km from the cited gauge → rejected), and
  // its situation report is logged with unsupported numbers flagged.
  assert.equal(res.escalations.length, 1);
  assert.equal(res.escalations[0]!.accepted, false);
  const steps = getMemorySteps("t-rules-1");
  assert.ok(steps.some((x) => /^Argon escalation rejected: .*Bukit Raja/.test(x.summary)));
  assert.ok(steps.some((x) => x.actor === "Gemini 4 Argon" && x.status === "fail" && /numbers not in the data: 9999/.test(x.summary)));
});

test("tailored villages keep their rules alerts when Gemini's plans fail", async () => {
  const situation = makeSampleSituation();
  const ai = scriptedAI();
  ai.draftVillage = async () => naive;
  ai.planVillage = async () => ({ plan: naive });
  const res = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-rules-2" });
  assert.equal(res.outcomes.length, 2); // both tailored by Gemini…
  assert.ok(res.outcomes.every((o) => !o.passed)); // …both failed
  assert.equal(res.plannedBy.get("test-kg-tualang"), "rules");
  assert.equal(res.plannedBy.get("test-kg-manik-urai"), "rules");
  assert.deepEqual(res.areaWarnings.filter((w) => w.kind === "evacuate"), []); // only advisories (if any)
  assertEveryVillageHasAlert(res, situation);
});

/**
 * Manik Urai + 8 copies whose river evidence conflicts (gauge DANGER vs its own event WARNING):
 * the rules send them all to Gemini, and they compete for the same two centres.
 */
function conflictingVillages() {
  const base = makeSampleSituation();
  const manik = base.villages.find((v) => v._id === "test-kg-manik-urai")!;
  const copies = Array.from({ length: 8 }, (_, i) => ({ ...manik, _id: `test-copy-${i}`, name: `Copy ${i}` }));
  const riskEvents = base.riskEvents.map((e) => (e._id === "test-re-galas" ? { ...e, level: "warning" as const } : e));
  const situation = { ...base, villages: [...base.villages, ...copies], riskEvents };
  const ai = scriptedAI();
  ai.draftVillage = async (task) => (task.village._id === "test-kg-tualang" ? tualang : fixed);
  ai.planVillage = async (task) => ({ plan: task.village._id === "test-kg-tualang" ? tualang : fixed });
  return { situation, ai };
}

test("Gemini cap 0: nothing reaches Gemini, villages code can't plan get the area-wide fallback", async () => {
  const { situation, ai } = conflictingVillages();
  const store = memoryStore();
  const res = await runAgent({ situation, trigger: { type: "manual" }, ai, store, runId: "t-rules-3", geminiCap: 0 });
  assert.deepEqual(ai.calls, []);
  assert.equal(res.plannedBy.get("test-kg-manik-urai"), "area-wide");
  // District warnings are saved for approval, like alerts.
  const saved = await store.areaWarningsForRun("t-rules-3");
  assert.ok(saved.some((w) => w.kind === "evacuate" && w.villageIds.includes("test-kg-manik-urai") && w.status === "needs_approval"));
  assert.equal(saved.length, res.areaWarnings.length);
  assert.ok(getMemorySteps("t-rules-3").some((s) => /9 need Gemini \(conflicting signals 9\)/.test(s.summary)));
  assertEveryVillageHasAlert(res, situation);
});

test("Gemini batches of MAX_VILLAGES_PER_RUN; parallel plans that double-book a centre are rejected", async () => {
  const { situation, ai } = conflictingVillages();
  const res = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-rules-4", geminiCap: 20, tailorTop: 0 });
  assert.equal(res.outcomes.length, 9); // 2 batches: 6 + 3
  assert.equal([...res.plannedBy.values()].filter((b) => b === "gemini").length, 1); // only the first fits the 50-place school
  const steps = getMemorySteps("t-rules-4");
  assert.ok(steps.some((s) => /Gemini batch 2\/2: 3 village/.test(s.summary)));
  assert.ok(steps.some((s) => /double-books a centre already allocated this run — rejected/.test(s.summary)));
  assertEveryVillageHasAlert(res, situation);
});

test("stop before the next Gemini batch: the rest falls back to area-wide warnings", async () => {
  const { situation, ai } = conflictingVillages();
  const draft = ai.draftVillage;
  ai.draftVillage = async (task) => {
    stopAgentRun("t-rules-5"); // operator presses stop while batch 1 runs
    return draft(task);
  };
  const res = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-rules-5", geminiCap: 20, tailorTop: 0 });
  assert.equal(res.outcomes.length, 6);
  assert.ok(getMemorySteps("t-rules-5").some((s) => /Stopped before Gemini batch 2: 3 village/.test(s.summary)));
  assertEveryVillageHasAlert(res, situation);
});

test("every at-risk village ends with an alert even if Gemini is down", async () => {
  const { situation, ai } = conflictingVillages();
  ai.draftVillage = async () => { throw new Error("Gemini unavailable"); };
  ai.planVillage = async () => { throw new Error("Gemini unavailable"); };
  ai.planSituation = async () => ({ summary: "none", villages: [], escalations: [], sitrep: "" });
  const res = await runAgent({ situation, trigger: { type: "manual" }, ai, store: memoryStore(), runId: "t-rules-6" });
  assertEveryVillageHasAlert(res, situation);
  assert.ok(getMemorySteps("t-rules-6").some((s) => /Coverage: 10 at-risk villages → 1 rules alerts, 0 Gemini alerts, 9 in area-wide/.test(s.summary)));
});

