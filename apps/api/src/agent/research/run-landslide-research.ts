// B5 — run ONCE in advance (not live in the demo): Deep Research finds published rainfall
// thresholds for landslides in Kelantan / Malaysia, Argon extracts them with citations, code checks
// them, and the results are saved for the landslide model and C's stream processor.
//
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/research/run-landslide-research.ts
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/research/run-landslide-research.ts --save
//   … --from-report [--save]   skip Deep Research: re-extract + re-check the saved report
//   … --use-saved --save       NO Gemini calls: re-check the saved extraction and save it
//
// Always writes (commit these — judges and README link to them):
//   src/agent/research/output/landslide-thresholds.<region>.json   thresholds + citations + checks
//   src/agent/research/output/landslide-report.<region>.md         the full Deep Research report
// With --save (needs MONGODB_URI, MOCK≠1): also sets regions.<id>.landslide and upserts the report
// into `knowledge` as kind "deep_research" chunks (Automated Embedding picks them up).
// Takes several minutes (Deep Research: most runs < 20 min).

import { readFileSync, writeFileSync } from "node:fs";
import { COLLECTIONS, type KnowledgeChunk, type Region } from "@monsoonwatch/shared";
import { closeDb, getDb } from "../../db/client";
import { env } from "../../env";
import { interact, interactJson } from "../gemini";
import { AGENTS, MODELS } from "../models";
import { emitStep } from "../steps";
import { checkExtraction, chunkReport, collectSources, ThresholdExtractionSchema, toRegionLandslide, type Source, type ThresholdExtraction } from "./thresholds";

const regionId = process.argv.find((a) => a.startsWith("--region="))?.split("=")[1] ?? env.regionId;
const save = process.argv.includes("--save");
const useSaved = process.argv.includes("--use-saved");
const fromReport = useSaved || process.argv.includes("--from-report");
const runId = `research-landslide-${regionId}-${Date.now()}`;
const out = (name: string) => new URL(`./output/${name}`, import.meta.url);

const QUERY = `Find published, citable rainfall thresholds for triggering landslides in Kelantan and Peninsular Malaysia
(or, if none exist for Kelantan, the closest comparable humid tropical regions with a clear statement of that).

I need, with a source for every number:
1. Cumulative rainfall thresholds (mm) over 1, 3 and 5 days that are associated with landslide occurrence,
   ideally split into increasing alert / warning / danger levels, as used by Malaysian agencies
   (JKR / Public Works Department slope guidelines, JMG / Minerals and Geoscience Department, MetMalaysia)
   or peer-reviewed studies of Malaysian landslides, including the December 2014 monsoon events.
2. The minimum slope angle (degrees) above which slopes are treated as landslide-prone in Malaysian guidance.
3. Any intensity-duration (I-D) threshold equations proposed for Malaysia, with their parameters.

Write a structured report: a short summary, then a table of thresholds (value, accumulation period,
level, region the study covers, source), then caveats on uncertainty and applicability to the Kelantan
valley. Put the full URL of each source next to the values it supports.`;

// Team decision (24 Oct, "option A"): keep three cited levels even though their windows differ,
// and show the caveats openly rather than inventing Kelantan-specific numbers.
export const DECISION =
  "Option A (team, 24 Oct): alert = national empirical 3-day threshold (50% landslide probability; may " +
  "over-warn in Kelantan's monsoon); warning and danger = published operational 1-day criteria " +
  "(JKR/JICA early-warning criterion; MetMalaysia continuous-heavy-rain danger warning). Mixed windows: " +
  "each level is checked against its own window. Screening use only.";

const EXTRACT_INSTRUCTION = `You extract landslide thresholds from a Deep Research report for an early-warning SCREENING model.
Use ONLY values stated in the report and cite the numbered source that states them (from the sources list).
Never invent a number or a source. Copy each quote EXACTLY from the report text.

Use this level mapping (the team's decision):
- alert   = the national empirical cumulative 3-day threshold (e.g. 50% landslide-initiation probability).
- warning = the published operational 1-day criterion used by JKR / the JICA early-warning criteria.
- danger  = the published 1-day MetMalaysia continuous-heavy-rain danger threshold.
- slope   = the minimum slope angle Malaysian guidance treats as landslide-prone.
For each level, write a one-sentence caveat on applicability to Kelantan (the report discusses this:
e.g. national/West-Coast values may over-warn during the Northeast Monsoon; a weather warning is not a
landslide study). Put the overall reasoning in notes. Return only JSON matching the schema.`;

try {
  let report: string;
  let sources: Source[];
  if (fromReport) {
    // Reuse the saved Deep Research output (report + the sources collected from its raw response).
    report = readFileSync(out(`landslide-report.${regionId}.md`), "utf8");
    sources = (JSON.parse(readFileSync(out(`landslide-thresholds.${regionId}.json`), "utf8")) as { sources: Source[] }).sources;
    console.log(`Re-using saved report (${report.length} chars, ${sources.length} sources) — Deep Research not re-run.`);
  } else {
    console.log(`Deep Research for ${regionId} — this takes several minutes…`);
    const research = await interact({
      runId,
      agent: AGENTS.deepResearch,
      agentConfig: { type: "deep-research", thinking_summaries: "none", visualization: "off", collaborative_planning: false },
      kind: "tool",
      summary: "Deep Research: published rainfall thresholds for landslides in Kelantan / Malaysia",
      input: QUERY,
    });
    report = research.text ?? "";
    if (!report) throw new Error("Deep Research returned an empty report");
    sources = collectSources(research.raw, report);
    writeFileSync(out(`landslide-report.${regionId}.md`), `${report}\n`);
    console.log(`Report: ${report.length} chars, ${sources.length} sources found.`);
  }

  // --use-saved: take the extraction from the last run's JSON (no Gemini call); the deterministic
  // checks below still run again on it before anything is saved.
  const saved = useSaved
    ? (JSON.parse(readFileSync(out(`landslide-thresholds.${regionId}.json`), "utf8")) as { extraction?: ThresholdExtraction }).extraction
    : undefined;
  if (useSaved && !saved) throw new Error("--use-saved: no extraction in the saved JSON — run with --from-report first");
  if (useSaved) console.log("Using the saved extraction — no Gemini calls.");
  const extraction = saved ? ThresholdExtractionSchema.parse(saved) : (await interactJson({
    runId,
    model: MODELS.argon,
    thinkingLevel: "medium",
    kind: "plan",
    summary: `Extracting cited thresholds from the Deep Research report (${sources.length} sources)`,
    systemInstruction: EXTRACT_INSTRUCTION,
    input: `SOURCES:\n${sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n")}\n\nREPORT:\n${report}`,
    schema: ThresholdExtractionSchema,
  })).data;

  const check = checkExtraction(extraction, sources, report);
  await emitStep({
    runId, actor: "Verification", kind: "verify", status: check.passed ? "ok" : "fail",
    summary: check.passed
      ? `Landslide thresholds: every value cited, found verbatim in the report and plausible (${extraction.rainThresholdsMm.length} thresholds)${check.warnings.length ? " · mixed windows" : ""}`
      : `Landslide thresholds REJECTED: ${check.problems.join("; ")}`.slice(0, 240),
  });

  const landslide = check.passed ? toRegionLandslide(extraction, sources) : null;
  writeFileSync(out(`landslide-thresholds.${regionId}.json`), `${JSON.stringify({
    regionId,
    generatedAt: new Date().toISOString(),
    method: `${AGENTS.deepResearch} report → ${MODELS.argon} extraction → deterministic checks`,
    label: "Screening thresholds from published sources — not a site-specific geotechnical assessment",
    decision: DECISION,
    check,
    // For C's stream processor (risk.js): one entry per level, with its own window.
    levels: extraction.rainThresholdsMm.map((t) => ({
      level: t.level, days: t.days, mm: t.mm, caveat: t.caveat,
      source: sources.find((x) => x.index === t.source)?.url ?? null,
    })),
    regionLandslide: landslide,
    extraction,
    sources,
  }, null, 2)}\n`);

  console.log(`\nChecks: ${check.passed ? "PASSED" : "FAILED"}`);
  for (const p of check.problems) console.log(`  ✗ ${p}`);
  for (const w of check.warnings) console.log(`  ⚠ ${w}`);
  for (const t of extraction.rainThresholdsMm) {
    console.log(`  ${t.level.padEnd(7)} ${String(t.mm).padStart(6)} mm over ${t.days} d  [${t.source}] ${sources.find((s) => s.index === t.source)?.url ?? "?"}`);
    console.log(`          caveat: ${t.caveat}`);
  }
  console.log(`  slope ≥ ${extraction.slopeMinDeg}°  [${extraction.slopeSource}]`);
  console.log(`  notes: ${extraction.notes}`);
  console.log(`\nWrote src/agent/research/output/landslide-thresholds.${regionId}.json and landslide-report.${regionId}.md`);

  if (save) {
    if (!landslide) throw new Error("Not saving: the checks failed (see above)");
    if (env.mock || !env.mongodbUri) throw new Error("--save needs MONGODB_URI and MOCK≠1");
    const db = await getDb();
    await db.collection<Region>(COLLECTIONS.regions).updateOne({ _id: regionId }, { $set: { landslide } });
    const chunks = chunkReport(regionId, "Deep Research: landslide rainfall thresholds", report, landslide.citations[0]?.url);
    for (const c of chunks) await db.collection<KnowledgeChunk>(COLLECTIONS.knowledge).replaceOne({ _id: c._id }, c, { upsert: true });
    await emitStep({ runId, actor: "MongoDB", kind: "db", status: "ok", summary: `Saved Region.landslide + ${chunks.length} knowledge chunks for ${regionId}` });
    console.log(`Saved regions.${regionId}.landslide and ${chunks.length} knowledge chunks.`);
  }
} finally {
  await closeDb();
}
