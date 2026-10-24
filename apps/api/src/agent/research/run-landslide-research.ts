// B5 — run ONCE in advance (not live in the demo): Deep Research finds published rainfall
// thresholds for landslides in Kelantan / Malaysia, Argon extracts them with citations, code checks
// them, and the results are saved for the landslide model and C's stream processor.
//
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/research/run-landslide-research.ts
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/research/run-landslide-research.ts --save
//
// Always writes (commit these — judges and README link to them):
//   src/agent/research/output/landslide-thresholds.<region>.json   thresholds + citations + checks
//   src/agent/research/output/landslide-report.<region>.md         the full Deep Research report
// With --save (needs MONGODB_URI, MOCK≠1): also sets regions.<id>.landslide and upserts the report
// into `knowledge` as kind "deep_research" chunks (Automated Embedding picks them up).
// Takes several minutes (Deep Research: most runs < 20 min).

import { writeFileSync } from "node:fs";
import { COLLECTIONS, type KnowledgeChunk, type Region } from "@monsoonwatch/shared";
import { closeDb, getDb } from "../../db/client";
import { env } from "../../env";
import { interact, interactJson } from "../gemini";
import { AGENTS, MODELS } from "../models";
import { emitStep } from "../steps";
import { checkExtraction, chunkReport, collectSources, ThresholdExtractionSchema, toRegionLandslide } from "./thresholds";

const regionId = process.argv.find((a) => a.startsWith("--region="))?.split("=")[1] ?? env.regionId;
const save = process.argv.includes("--save");
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

const EXTRACT_INSTRUCTION = `You extract landslide thresholds from a Deep Research report for an early-warning screening model.
Use ONLY values stated in the report and cite the numbered source that states them (from the sources list).
Never invent a number or a source. If the report gives one threshold rather than three levels, map it
honestly (e.g. the published threshold = "warning") and explain the mapping in notes. Prefer 3-day
cumulative rainfall if available. Return only JSON matching the schema.`;

console.log(`Deep Research for ${regionId} — this takes several minutes…`);
try {
  const research = await interact({
    runId,
    agent: AGENTS.deepResearch,
    agentConfig: { type: "deep-research", thinking_summaries: "none", visualization: "off", collaborative_planning: false },
    kind: "tool",
    summary: "Deep Research: published rainfall thresholds for landslides in Kelantan / Malaysia",
    input: QUERY,
  });
  const report = research.text ?? "";
  if (!report) throw new Error("Deep Research returned an empty report");
  const sources = collectSources(research.raw, report);
  writeFileSync(out(`landslide-report.${regionId}.md`), `${report}\n`);
  console.log(`Report: ${report.length} chars, ${sources.length} sources found.`);

  const { data: extraction } = await interactJson({
    runId,
    model: MODELS.argon,
    thinkingLevel: "medium",
    kind: "plan",
    summary: `Extracting cited thresholds from the Deep Research report (${sources.length} sources)`,
    systemInstruction: EXTRACT_INSTRUCTION,
    input: `SOURCES:\n${sources.map((s) => `[${s.index}] ${s.title} — ${s.url}`).join("\n")}\n\nREPORT:\n${report}`,
    schema: ThresholdExtractionSchema,
  });

  const check = checkExtraction(extraction, sources);
  await emitStep({
    runId, actor: "Verification", kind: "verify", status: check.passed ? "ok" : "fail",
    summary: check.passed
      ? `Landslide thresholds: every value cites a returned source and is plausible (${extraction.rainThresholdsMm.length} thresholds)`
      : `Landslide thresholds REJECTED: ${check.problems.join("; ")}`.slice(0, 240),
  });

  const landslide = check.passed ? toRegionLandslide(extraction, sources) : null;
  writeFileSync(out(`landslide-thresholds.${regionId}.json`), `${JSON.stringify({
    regionId,
    generatedAt: new Date().toISOString(),
    method: `${AGENTS.deepResearch} report → ${MODELS.argon} extraction → deterministic checks`,
    label: "Screening thresholds from published sources — not a site-specific geotechnical assessment",
    check,
    regionLandslide: landslide,
    extraction,
    sources,
  }, null, 2)}\n`);

  console.log(`\nChecks: ${check.passed ? "PASSED" : "FAILED"}`);
  for (const p of check.problems) console.log(`  ✗ ${p}`);
  for (const t of extraction.rainThresholdsMm) console.log(`  ${t.level.padEnd(7)} ${String(t.mm).padStart(5)} mm over ${t.days} d  [${t.source}] ${sources.find((s) => s.index === t.source)?.url ?? "?"}`);
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
