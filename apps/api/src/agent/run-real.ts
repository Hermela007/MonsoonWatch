// Runs the REAL agent (Argon + Flash-Lite drafts + Flash refinements + checks) on REAL data from
// MongoDB at a moment. Needs GEMINI_API_KEY (with credit) and MONGODB_URI. Steps + alerts are saved,
// so they appear in the Tech HUD. Demo case from C: replay on 24 Dec 2014.
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/run-real.ts --mode=replay --at=2014-12-24T12:00:00+08:00
//   … --dry-run   NO Gemini calls: token estimate per section, risk-screen counts, coverage projection.

import { closeDb } from "../db/client";
import { env } from "../env";
import { runAgent } from "./orchestrator";
import { loadSituationFromDb } from "./situation-db";
import { getMemorySteps } from "./steps";
import { situationForPrompt } from "./situation";
import { MAX_VILLAGES_PER_RUN } from "./orchestrator";
import { assignCoverage, buildAreaWarnings, coverageCounts, coverageSummary } from "./coverage";
import { shortlistForArgon, shortlistSummary } from "./shortlist";

/** Argon's prompt asks for at most this many villages (prompts/orchestrator.md). */
const ARGON_MAX_VILLAGES = 10;

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
    console.log(`Argon input ≈ ${tokens(sent).toLocaleString()} tokens (was ≈ ${tokens(full).toLocaleString()} without the shortlist)\n`);

    const { screen } = shortlist;
    console.log(`Risk screen: ${screen.atRisk.length} at risk · ${screen.watch.length} watch (gauge only) · ${screen.noSignal.length} no signal (of ${situation.villages.length})`);
    const kinds = (k: string) => screen.atRisk.filter((r) => r.signals.some((x) => x.kind === k)).length;
    const levels = (l: string) => screen.atRisk.filter((r) => r.level === l).length;
    console.log(`  at-risk evidence: flooded road ${kinds("flooded_road")} · landslide runout ${kinds("landslide_runout")} · flood-model gap ${kinds("flood_model_gap")}`);
    console.log(`  at-risk levels:   danger ${levels("danger")} · warning ${levels("warning")} · alert ${levels("alert")}`);
    console.log(shortlistSummary(shortlist));
    console.log("\nNot sent to Argon, per district (in its prompt as notSentByDistrict):");
    console.table(shortlist.notSent);

    // Projection: Argon's real choice is unknown without calling it; assume it confirms the top of the shortlist.
    const assumed = shortlist.villages.slice(0, ARGON_MAX_VILLAGES).map((r) => r.village._id);
    const coverage = assignCoverage(screen.atRisk, assumed, MAX_VILLAGES_PER_RUN);
    const n = coverageCounts(coverage);
    console.log(`\nCoverage PROJECTION (assumes Argon confirms the top ${assumed.length} shortlisted villages):`);
    console.log(`  ${coverageSummary(coverage, screen.atRisk.length)}`);
    console.log(`  Gemini: 1 Argon call + ${n.planned + n.queued} villages × (1 Flash-Lite draft + up to 3 Flash refinements); area-wide warnings use none.`);
    const warnings = buildAreaWarnings(coverage.areaWide, { regionId: situation.region._id, runId: "dry-run", languages: situation.region.languages });
    console.table(warnings.map((w) => ({ district: w.district, hazard: w.hazard, level: w.level, villages: w.villageIds.length, people: w.people, vulnerable: w.vulnerable })));
    if (warnings[0]) console.log(`Example template text:\n  ${warnings[0].messages.map((m) => `[${m.lang}] ${m.text}`).join("\n  ")}`);
    process.exit(0);
  }
  console.log(`Running the agent on REAL ${mode} data @ ${at.toISOString()} (run ${runId})…\n`);
  // Ctrl+C stops the script (remaining queued batches are not planned).
  const { run, outcomes, coverage, areaWarnings } = await runAgent({ situation, trigger: { type: "manual" }, runId });
  console.table(getMemorySteps(runId).map(({ actor, kind, status, summary }) => ({ actor, kind, status, summary: summary.slice(0, 110) })));
  console.log(`\nRun ${run.status}${run.error ? `: ${run.error}` : ""}.`);
  for (const o of outcomes) {
    console.log(`\n${o.villageName}: ${o.passed ? "VERIFIED" : "NOT verified"} after ${o.attempts} attempt(s)`);
    for (const a of o.alerts) {
      console.log(`  → ${a.people} to ${a.evacCentreId}; pickups: ${(a.pickups ?? []).map((p) => `${p.order}.${p.category}×${p.people} ${p.vehicle}`).join(", ") || "none"}`);
      for (const v of a.verification.filter((r) => !r.passed)) console.log(`    ✗ ${v.check}: ${v.detail}`);
    }
  }
  console.log(`\n${coverageSummary(coverage, coverage.batches.flat().length + coverage.areaWide.length)}`);
  for (const w of areaWarnings) console.log(`  area-wide ${w.level.toUpperCase()} ${w.hazard} · ${w.district}: ${w.villageIds.length} villages (draft, needs approval, not saved)`);
} finally {
  await closeDb();
}
