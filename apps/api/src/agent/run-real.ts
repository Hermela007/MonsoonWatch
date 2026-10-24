// Runs the REAL agent (Argon + rules planner + Gemini for what code can't plan + checks) on REAL
// data from MongoDB at a moment. Needs GEMINI_API_KEY (with credit) and MONGODB_URI. Steps + alerts
// are saved, so they appear in the Tech HUD. Demo case from C: replay on 24 Dec 2014.
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/run-real.ts --mode=replay --at=2014-12-24T12:00:00+08:00
//   … --dry-run   NO Gemini calls: token estimate, risk screen, the REAL rules planner (it is
//                 deterministic), who would go to Gemini and why, and the fallback.
//   … --gemini-cap=N  most villages sent to Gemini (default AGENT_GEMINI_MAX_VILLAGES or 10)

import { closeDb } from "../db/client";
import { env } from "../env";
import { GEMINI_DEFAULTS, accountabilitySummary, buildAdvisories, buildAreaWarnings, countBy, rulesSummary, selectForGemini, type AreaWarning } from "./coverage";
import { LEVEL_WORDS } from "./verify";
import { MAX_ATTEMPTS, MAX_VILLAGES_PER_RUN, runAgent } from "./orchestrator";
import { buildRoadGraph } from "./route";
import { planAllByRules, type FallbackReason, type GeminiReason } from "./rules-planner";
import { shortlistForArgon, shortlistSummary } from "./shortlist";
import { situationForPrompt } from "./situation";
import { loadSituationFromDb } from "./situation-db";
import { getMemorySteps } from "./steps";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const mode = (arg("mode") ?? "live") as "live" | "replay";
const at = arg("at") ? new Date(arg("at")!) : new Date();
const runId = `real-${mode}-${Date.now()}`;
const geminiCap = arg("gemini-cap") ? Number(arg("gemini-cap")) : GEMINI_DEFAULTS.cap;

try {
  const situation = await loadSituationFromDb(arg("region") ?? env.regionId, { mode, at });
  if (process.argv.includes("--dry-run")) {
    const tokens = (v: unknown) => Math.round(JSON.stringify(v ?? null).length / 4); // rough: ~4 characters per token
    const full = situationForPrompt(situation, { full: true });
    const shortlist = shortlistForArgon(situation);
    const sent = situationForPrompt(situation, { shortlist });
    const SECTIONS = ["villages", "undecidedVillages", "evacCentres", "stations", "knowledge", "glofasCells", "riskEvents"] as const;
    const count = (v: unknown) => (Array.isArray(v) ? v.length : "");
    const rows: Record<string, { allItems: number | string; allTokens: number; sentItems: number | string; sentTokens: number }> = {};
    const pick = (o: Record<string, unknown>, k: string) => o[k];
    for (const k of SECTIONS) rows[k] = { allItems: count(pick(full, k)), allTokens: tokens(pick(full, k)), sentItems: count(pick(sent, k)), sentTokens: tokens(pick(sent, k)) };
    const rest = (o: Record<string, unknown>) => tokens(Object.fromEntries(Object.entries(o).filter(([k]) => !(SECTIONS as readonly string[]).includes(k))));
    rows.other = { allItems: "", allTokens: rest(full), sentItems: "", sentTokens: rest(sent) };
    rows.TOTAL = { allItems: "", allTokens: tokens(full), sentItems: "", sentTokens: tokens(sent) };
    console.log(`DRY RUN (no Gemini calls) · ${mode} @ ${at.toISOString()}`);
    console.log("Argon input by section (≈ tokens, 4 chars/token) — all data vs. what the shortlist sends:");
    console.table(rows);
    console.log(`Argon input ≈ ${tokens(sent).toLocaleString()} tokens (was ≈ ${tokens(full).toLocaleString()} without the shortlist)\n`);

    const { screen } = shortlist;
    console.log(`Risk screen: ${screen.atRisk.length} at risk · ${screen.watch.length} watch (gauge only) · ${screen.noSignal.length} no signal (of ${situation.villages.length})`);
    console.log(shortlistSummary(shortlist));

    // The rules planner is deterministic: run it for real (Argon's claims unknown → screen claims).
    const t0 = Date.now();
    const graph = buildRoadGraph(situation.roads);
    const tGraph = Date.now() - t0;
    const { results, centresAtRisk, centresUnknown, centreStatusSource } = planAllByRules({ runId: "dry-run", situation, graph }, screen.atRisk);
    console.log(`\n${rulesSummary(results)}`);
    console.log(`  (road graph ${tGraph} ms, planning ${Date.now() - t0 - tGraph} ms; centres not used by the rules: ${centresAtRisk} at risk + ${centresUnknown} unknown of ${situation.centres.length} (status: ${centreStatusSource}))`);
    const ok = results.filter((r) => r.ok);
    const alerts = ok.flatMap((r) => r.built.alerts);
    const split = ok.filter((r) => r.built.alerts.length > 1).length;
    const boatVillages = ok.filter((r) => r.boatGroups > 0);
    const allBoat = boatVillages.filter((r) => r.boatGroups === r.built.alerts.length).length;
    console.log(`  rules alerts: ${alerts.length} for ${ok.length} villages (${split} split across centres); ${new Set(alerts.map((a) => a.evacCentreId)).size} centres used`);
    console.log(`  by dry road only: ${ok.length - boatVillages.length} villages · with boats: ${boatVillages.length} (${allBoat} all by boat, ${boatVillages.length - allBoat} road + boat)`);

    const { picks, overCap } = selectForGemini(results, { cap: geminiCap, tailorTop: GEMINI_DEFAULTS.tailorTop });
    const fixes = picks.filter((p) => p.why === "fix");
    const allFixes = results.flatMap((r) => (!r.ok && r.to === "gemini" ? [r] : []));
    const fallbackByRules = results.flatMap((r) => (!r.ok && r.to === "fallback" ? [r] : []));
    console.log(`\nNeed Gemini (rules couldn't plan): ${allFixes.length}`, countBy<GeminiReason>(allFixes.map((r) => r.reason)));
    for (const r of allFixes.slice(0, 8)) console.log(`  · ${r.reason}: ${r.detail}`);
    if (allFixes.length > 8) console.log(`  · … ${allFixes.length - 8} more`);
    console.log(`Gemini this run (cap ${geminiCap}): ${fixes.length} fixes + ${picks.length - fixes.length} tailored (top by urgency; a real run prefers Argon's order) = ${picks.length} villages in ${Math.ceil(picks.length / MAX_VILLAGES_PER_RUN)} batch(es)`);
    console.log(`  Gemini calls ≈ 1 Argon + ${picks.length} Flash-Lite drafts + up to ${picks.length * (MAX_ATTEMPTS - 1)} Flash refinements (fewer when drafts pass)`);

    const fallback = [...fallbackByRules.map((r) => r.risk), ...overCap.map((f) => f.risk)];
    console.log(`\nFallback (area-wide warning): ${fallback.length} — ${fallbackByRules.length} code+Gemini can't plan`, countBy<FallbackReason>(fallbackByRules.map((r) => r.reason)),
      `+ ${overCap.length} Gemini fixes over the cap; plus any Gemini fix that still fails its checks in the real run`);
    const warnings = buildAreaWarnings(fallback, { regionId: situation.region._id, runId: "dry-run", languages: situation.region.languages });
    const row = (w: AreaWarning) => ({ kind: w.kind, district: w.district, level: w.level, villages: w.villageIds.length, people: w.people, vulnerable: w.vulnerable, bedridden: w.vulnerableByCategory.bedridden });
    if (warnings.length) console.table(warnings.map(row));

    const check = ok.length + picks.filter((p) => p.why === "fix").length + fallback.length;
    console.log(`\nCoverage: ${screen.atRisk.length} at risk = ${ok.length} rules (${picks.length - fixes.length} of them also tailored by Gemini) + ${fixes.length} Gemini fixes + ${fallback.length} fallback → ${check === screen.atRisk.length ? "every village covered" : `MISMATCH (${check})`}`);

    const advisories = buildAdvisories(screen, { regionId: situation.region._id, runId: "dry-run", languages: situation.region.languages });
    console.log(`\nAdvisories (template, no AI, need approval): ${advisories.length} for ${screen.watch.length} watch + ${screen.unknown.length} unknown villages`);
    if (advisories.length) console.table(advisories.map(row));
    console.log(accountabilitySummary(screen, advisories, situation.villages.length));
    const levelOk = [...alerts, ...warnings, ...advisories].every((a) => a.messages.every((m) => !LEVEL_WORDS[m.lang] || m.text.trimStart().toUpperCase().startsWith(LEVEL_WORDS[m.lang]![a.level as "alert"])));
    console.log(`Every rules alert / warning / advisory starts with its level word: ${levelOk ? "yes" : "NO"}`);
    if (advisories[0]) console.log(`Example advisory:\n  ${advisories[0].messages.map((m) => `[${m.lang}] ${m.text}`).join("\n  ")}`);
    for (const sample of [alerts.find((a) => !boatVillages.some((r) => r.built.alerts.includes(a))), boatVillages[0]?.built.alerts.find((a) => a.pickups?.length)]) {
      if (!sample) continue;
      console.log(`\nExample rules alert (${sample._id}; pickups: ${(sample.pickups ?? []).map((p) => `${p.order}.${p.category}×${p.people} ${p.vehicle}`).join(", ") || "none"}):`);
      console.log(`  ${sample.messages.map((m) => `[${m.lang}] ${m.text}`).join("\n  ")}`);
    }
    process.exit(0);
  }
  console.log(`Running the agent on REAL ${mode} data @ ${at.toISOString()} (run ${runId}, Gemini cap ${geminiCap})…\n`);
  // Ctrl+C stops the script (remaining Gemini batches are not planned).
  const { run, outcomes, rulesAlerts, plannedBy, areaWarnings, atRisk, escalations, sitrep } = await runAgent({ situation, trigger: { type: "manual" }, runId, geminiCap });
  console.table(getMemorySteps(runId).map(({ actor, kind, status, summary }) => ({ actor, kind, status, summary: summary.slice(0, 110) })));
  console.log(`\nRun ${run.status}${run.error ? `: ${run.error}` : ""}.`);
  console.log(`\nArgon's situation report:\n  ${sitrep || "(none)"}`);
  console.log(`Argon's escalations: ${escalations.filter((e) => e.accepted).length} accepted, ${escalations.filter((e) => !e.accepted).length} rejected`);
  for (const e of escalations) console.log(`  ${e.accepted ? "✓" : "✗"} ${e.detail}`);
  console.log(`${rulesAlerts.length} rules alerts (verified). Gemini villages:`);
  for (const o of outcomes) {
    console.log(`\n${o.villageName}: ${o.passed ? "VERIFIED" : "NOT verified"} after ${o.attempts} attempt(s) → covered by ${plannedBy.get(o.villageId)}`);
    for (const a of o.alerts) {
      console.log(`  → ${a.people} to ${a.evacCentreId}; pickups: ${(a.pickups ?? []).map((p) => `${p.order}.${p.category}×${p.people} ${p.vehicle}`).join(", ") || "none"}`);
      for (const v of a.verification.filter((r) => !r.passed)) console.log(`    ✗ ${v.check}: ${v.detail}`);
    }
  }
  console.log(`\nCoverage of ${atRisk} at-risk villages:`, countBy([...plannedBy.values()]));
  for (const w of areaWarnings) console.log(`  area-wide ${w.level.toUpperCase()} ${w.hazard} · ${w.district}: ${w.villageIds.length} villages (draft, needs approval, not saved)`);
} finally {
  await closeDb();
}
