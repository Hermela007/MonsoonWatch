// Deep Research → landslide rainfall thresholds: the deterministic parts (no LLM, unit-tested).
//
// Deep Research returns a cited report but no structured output (official docs), so:
//   1. collectSources: gather every URL Deep Research returned (annotations anywhere in the raw
//      response, plus URLs written in the report text) into a numbered source list,
//   2. Argon extracts thresholds into ThresholdExtractionSchema, each value pointing at a source,
//   3. checkExtraction: every value must cite a source that Deep Research actually returned and be
//      physically plausible. Nothing is saved unless this passes.

import { z } from "zod";
import type { KnowledgeChunk, Region } from "@monsoonwatch/shared";

export interface Source { index: number; url: string; title: string }

const URL_RE = /https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?]/g;

/** Every URL in the raw interaction (any `url`/`uri` field, any text) — deduplicated, numbered from 1. */
export function collectSources(raw: unknown, reportText: string): Source[] {
  const found = new Map<string, string>(); // url → title
  const add = (url: string, title?: string) => {
    const clean = url.trim();
    if (!/^https?:\/\//.test(clean)) return;
    if (!found.has(clean) || (title && !found.get(clean))) found.set(clean, title ?? "");
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 12 || v === null || v === undefined) return;
    if (typeof v === "string") { for (const m of v.match(URL_RE) ?? []) add(m); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      const url = typeof o.url === "string" ? o.url : typeof o.uri === "string" ? o.uri : undefined;
      if (url) add(url, typeof o.title === "string" ? o.title : undefined);
      for (const x of Object.values(o)) walk(x, depth + 1);
    }
  };
  walk(raw, 0);
  for (const m of reportText.match(URL_RE) ?? []) add(m);
  return [...found.entries()].map(([url, title], i) => ({ index: i + 1, url, title: title || url }));
}

export const ThresholdExtractionSchema = z.object({
  slopeMinDeg: z.number().describe("Minimum slope angle (degrees) at which the cited sources treat slopes as landslide-prone"),
  slopeSource: z.number().int().describe("Index of the source stating the slope value"),
  rainThresholdsMm: z
    .array(
      z.object({
        level: z.enum(["alert", "warning", "danger"]),
        days: z.number().describe("Accumulation period in days"),
        mm: z.number().describe("Cumulative rainfall in mm over `days`"),
        source: z.number().int().describe("Index of the source that states (or directly supports) this value"),
        quote: z.string().describe("Short phrase from the report backing this value"),
      }),
    )
    .describe("Cumulative rainfall thresholds; empty if the sources give none"),
  notes: z.string().describe("Caveats: region the thresholds were derived for, uncertainty, how levels were mapped"),
});
export type ThresholdExtraction = z.infer<typeof ThresholdExtractionSchema>;

export interface CheckResult { passed: boolean; problems: string[] }

/** Deterministic checks on Argon's extraction. */
export function checkExtraction(x: ThresholdExtraction, sources: Source[]): CheckResult {
  const problems: string[] = [];
  const known = new Set(sources.map((s) => s.index));
  if (sources.length === 0) problems.push("Deep Research returned no sources");
  if (!known.has(x.slopeSource)) problems.push(`slope cites source ${x.slopeSource}, which Deep Research did not return`);
  if (!(x.slopeMinDeg >= 5 && x.slopeMinDeg <= 60)) problems.push(`slopeMinDeg ${x.slopeMinDeg}° is outside 5–60°`);
  if (x.rainThresholdsMm.length === 0) problems.push("no rainfall thresholds extracted");
  for (const t of x.rainThresholdsMm) {
    const label = `${t.level} ${t.mm} mm / ${t.days} d`;
    if (!known.has(t.source)) problems.push(`${label} cites source ${t.source}, which Deep Research did not return`);
    if (!(t.days >= 1 && t.days <= 30)) problems.push(`${label}: days outside 1–30`);
    if (!(t.mm >= 10 && t.mm <= 2000)) problems.push(`${label}: mm outside 10–2000`);
  }
  const order = ["alert", "warning", "danger"] as const;
  for (const days of new Set(x.rainThresholdsMm.map((t) => t.days))) {
    const byLevel = order.map((l) => x.rainThresholdsMm.find((t) => t.days === days && t.level === l)?.mm);
    for (let i = 1; i < 3; i++) {
      const lo = byLevel[i - 1], hi = byLevel[i];
      if (lo !== undefined && hi !== undefined && hi <= lo) problems.push(`${days}-day thresholds must rise alert < warning < danger`);
    }
  }
  return { passed: problems.length === 0, problems };
}

/** Region.landslide (§1.6 decision 6): only sources actually cited by a value are kept. */
export function toRegionLandslide(x: ThresholdExtraction, sources: Source[]): NonNullable<Region["landslide"]> {
  const cited = new Set([x.slopeSource, ...x.rainThresholdsMm.map((t) => t.source)]);
  return {
    slopeMinDeg: x.slopeMinDeg,
    rainThresholdsMm: [...x.rainThresholdsMm].sort((a, b) => a.days - b.days || a.mm - b.mm).map(({ days, mm }) => ({ days, mm })),
    citations: sources.filter((s) => cited.has(s.index)).map(({ title, url }) => ({ title, url })),
  };
}

/** Split the report into knowledge chunks (~1,500 chars, on paragraph boundaries). */
export function chunkReport(regionId: string, title: string, report: string, sourceUrl?: string, maxChars = 1500): KnowledgeChunk[] {
  const paras = report.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) { chunks.push(cur); cur = ""; }
    cur = cur ? `${cur}\n\n${p}` : p;
    while (cur.length > maxChars) { chunks.push(cur.slice(0, maxChars)); cur = cur.slice(maxChars); }
  }
  if (cur) chunks.push(cur);
  return chunks.map((chunk, i) => ({
    _id: `dr-landslide-${regionId}-${i + 1}`,
    regionId,
    kind: "deep_research" as const,
    title: `${title} (part ${i + 1}/${chunks.length})`,
    ...(sourceUrl ? { sourceUrl } : {}),
    chunk,
  }));
}
