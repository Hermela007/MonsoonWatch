// Runs the REAL agent (Argon + Flash-Lite drafts + Flash refinements + checks) on REAL data from
// MongoDB at a moment. Needs GEMINI_API_KEY (with credit) and MONGODB_URI. Steps + alerts are saved,
// so they appear in the Tech HUD. Demo case from C: replay on 24 Dec 2014.
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/run-real.ts --mode=replay --at=2014-12-24T12:00:00+08:00
//   … --dry-run   NO Gemini calls: estimate the tokens Argon would receive and stop.

import { closeDb } from "../db/client";
import { env } from "../env";
import { runAgent } from "./orchestrator";
import { loadSituationFromDb } from "./situation-db";
import { getMemorySteps } from "./steps";
import { shortlistForArgon, shortlistSummary, situationForPrompt } from "./situation";
import { MAX_VILLAGES_PER_RUN } from "./orchestrator";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const mode = (arg("mode") ?? "live") as "live" | "replay";
const at = arg("at") ? new Date(arg("at")!) : new Date();
const runId = `real-${mode}-${Date.now()}`;

try {
  const situation = await loadSituationFromDb(arg("region") ?? env.regionId, { mode, at });
  if (process.argv.includes("--dry-run")) {
    const tokens = (v: unknown) => Math.round(JSON.stringify(v ?? null).length / 4); // rough: ~4 characters per token
    const full = situationForPrompt(situation, { full: true });
    const shortlist = shortlistForArgon(situation);
    const sent = situationForPrompt(situation, { shortlist });
    const SECTIONS = ["villages", "evacCentres", "stations", "knowledge", "glofasCells", "riskEvents"] as const;
    const count = (v: unknown) => (Array.isArray(v) ? v.length : "");
    const rows: Record<string, { allItems: number | string; allTokens: number; sentItems: number | string; sentTokens: number }> = {};
    for (const k of SECTIONS) rows[k] = { allItems: count(full[k]), allTokens: tokens(full[k]), sentItems: count(sent[k]), sentTokens: tokens(sent[k]) };
    const rest = (o: Record<string, unknown>) => tokens(Object.fromEntries(Object.entries(o).filter(([k]) => !(SECTIONS as readonly string[]).includes(k))));
    rows.other = { allItems: "", allTokens: rest(full), sentItems: "", sentTokens: rest(sent) };
    rows.TOTAL = { allItems: "", allTokens: tokens(full), sentItems: "", sentTokens: tokens(sent) };
    console.log(`DRY RUN (no Gemini calls) · ${mode} @ ${at.toISOString()}`);
    console.log("Argon input by section (≈ tokens, 4 chars/token) — all data vs. what the shortlist sends:");
    console.table(rows);
    console.log(shortlistSummary(shortlist));
    console.log(`Argon input ≈ ${tokens(sent).toLocaleString()} tokens (was ≈ ${tokens(full).toLocaleString()} without the shortlist)`);
    console.log(`Then up to ${MAX_VILLAGES_PER_RUN} villages × (1 Flash-Lite draft + ~3–6 Flash turns of ~1–2k tokens each).`);
    process.exit(0);
  }
  console.log(`Running the agent on REAL ${mode} data @ ${at.toISOString()} (run ${runId})…\n`);
  const { run, outcomes } = await runAgent({ situation, trigger: { type: "manual" }, runId });
  console.table(getMemorySteps(runId).map(({ actor, kind, status, summary }) => ({ actor, kind, status, summary: summary.slice(0, 110) })));
  console.log(`\nRun ${run.status}${run.error ? `: ${run.error}` : ""}.`);
  for (const o of outcomes) {
    console.log(`\n${o.villageName}: ${o.passed ? "VERIFIED" : "NOT verified"} after ${o.attempts} attempt(s)`);
    for (const a of o.alerts) {
      console.log(`  → ${a.people} to ${a.evacCentreId}; pickups: ${(a.pickups ?? []).map((p) => `${p.order}.${p.category}×${p.people} ${p.vehicle}`).join(", ") || "none"}`);
      for (const v of a.verification.filter((r) => !r.passed)) console.log(`    ✗ ${v.check}: ${v.detail}`);
    }
  }
} finally {
  await closeDb();
}
