// B0 "done when": a hello-world Argon call runs and appears as an AgentStep.
// Run from the repo root:  pnpm --filter @monsoonwatch/api exec tsx src/agent/hello-argon.ts
// (.env at the repo root is loaded by ../env)

import { randomUUID } from "node:crypto";
import { interact } from "./gemini";
import { MODELS } from "./models";
import { getMemorySteps } from "./steps";

const runId = `hello-${randomUUID()}`;

const res = await interact({
  runId,
  model: MODELS.argon,
  thinkingLevel: "low",
  kind: "info",
  summary: "Hello-world Argon call",
  input: "In one sentence: why do floods arrive downstream hours after heavy rain in the hills?",
});

console.log("\nArgon says:", res.text);
console.log("\nAgentSteps recorded:");
console.table(getMemorySteps(runId).map(({ actor, kind, status, summary, latencyMs, tokens }) => ({
  actor, kind, status, summary, latencyMs, tokens,
})));
