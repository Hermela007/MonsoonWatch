// Runs the REAL agent (Gemini 4 Argon + 3.8 Flash subagents + checks) on the labelled TEST scenario.
// Needs GEMINI_API_KEY in .env. From the repo root:
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/run-sample.ts
// Steps/alerts go to MongoDB too if MONGODB_URI is set and MOCK≠1 (so they appear in the Tech HUD).

import { closeDb } from "../db/client";
import { runAgent } from "./orchestrator";
import { makeSampleSituation } from "./sample/kelantan-test";
import { getMemorySteps } from "./steps";

const runId = `sample-${Date.now()}`;
console.log(`Running the agent on TEST DATA (run ${runId}) — this takes a minute or two…\n`);
try {
  const { run, outcomes } = await runAgent({ situation: makeSampleSituation(), trigger: { type: "manual" }, runId });
  console.table(getMemorySteps(runId).map(({ actor, kind, status, summary, latencyMs }) => ({
    actor, kind, status, summary: summary.slice(0, 110), latencyMs,
  })));
  console.log(`\nRun ${run.status}.`);
  for (const o of outcomes) {
    console.log(`\n${o.villageName}: ${o.passed ? "VERIFIED" : "NOT verified"} after ${o.attempts} attempt(s)`);
    for (const a of o.alerts) {
      console.log(`  → ${a.people} people to ${a.evacCentreId}; pickups: ${(a.pickups ?? []).map((p) => `${p.order}.${p.category}×${p.people} by ${p.vehicle}`).join(", ") || "none"}`);
      for (const m of a.messages) console.log(`    [${m.lang}] ${m.text}`);
      for (const v of a.verification.filter((r) => !r.passed)) console.log(`    ✗ ${v.check}: ${v.detail}`);
    }
  }
} finally {
  await closeDb();
}
