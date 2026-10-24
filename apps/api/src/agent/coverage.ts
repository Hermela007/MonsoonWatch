// Coverage guarantee: every village the deterministic risk screen marks at risk ends up
//   "planned"   — in this run's first batch (Argon-confirmed, most urgent first)
//   "queued"    — a later batch of the same run (planned after the first, until done or stopped)
//   "area-wide" — a deterministic district warning (template text, no Gemini), still needing
//                 a human approval like every alert.
// Gemini cost stays bounded: only Argon-confirmed villages get Flash subagents.
//
// AreaWarning is B-internal for now: the shared Alert needs a village, a centre and a route, which
// a district warning doesn't have. Proposed to A + C as a shared type; until then area warnings
// are logged as AgentSteps and returned from the run, not saved.

import type { AlertLevel, VillageRisk } from "./shortlist";

export interface Coverage {
  /** Village ids per batch, most urgent first. batches[0] = planned now; the rest = queued. */
  batches: string[][];
  /** At-risk villages Argon did not confirm (or not sent to Argon), for area-wide warnings. */
  areaWide: VillageRisk[];
}

export interface AreaWarning {
  id: string;
  regionId: string;
  runId: string;
  district: string;
  hazard: "flood" | "landslide";
  level: AlertLevel;
  villageIds: string[];
  people: number;
  vulnerable: number;
  /** The strongest village's signals, so the text is checkable. */
  evidence: string[];
  messages: { lang: string; text: string }[];
  /** Template, no AI. Never sent without a human approval. */
  status: "needs_approval";
  label: "Area-wide warning (deterministic template, no AI)";
}

const LEVEL_RANK: Record<AlertLevel, number> = { alert: 1, warning: 2, danger: 3 };

/**
 * Splits the run's work. `confirmed` = Argon's villages, already in urgency order. Every
 * `atRisk` village lands in exactly one batch or in `areaWide`. Pure.
 */
export function assignCoverage(atRisk: VillageRisk[], confirmed: string[], batchSize: number): Coverage {
  const ids = [...new Set(confirmed)];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
  const planned = new Set(ids);
  return { batches, areaWide: atRisk.filter((r) => !planned.has(r.village._id)) };
}

/** Run stopped before batch `fromBatch`: those villages move to area-wide warnings. */
export function stopAt(c: Coverage, fromBatch: number, atRisk: VillageRisk[]): Coverage {
  const dropped = new Set(c.batches.slice(fromBatch).flat());
  return {
    batches: c.batches.slice(0, fromBatch),
    areaWide: [...c.areaWide, ...atRisk.filter((r) => dropped.has(r.village._id))],
  };
}

export function coverageCounts(c: Coverage) {
  return {
    planned: c.batches[0]?.length ?? 0,
    queued: c.batches.slice(1).reduce((n, b) => n + b.length, 0),
    queuedBatches: Math.max(0, c.batches.length - 1),
    areaWide: c.areaWide.length,
    districts: new Set(c.areaWide.map((r) => r.village.district)).size,
  };
}

export function coverageSummary(c: Coverage, atRiskTotal: number): string {
  const n = coverageCounts(c);
  return `Coverage of ${atRiskTotal} at-risk villages: ${n.planned} planned now, ${n.queued} queued in ${n.queuedBatches} later batch(es), ` +
    `${n.areaWide} in ${n.districts} area-wide warning(s) (template, no AI, need approval)`;
}

const LEVEL_TEXT: Record<string, Record<AlertLevel, string>> = {
  ms: { alert: "WASPADA", warning: "AMARAN", danger: "BAHAYA" },
  en: { alert: "ALERT", warning: "WARNING", danger: "DANGER" },
};
const HAZARD_TEXT: Record<string, Record<AreaWarning["hazard"], string>> = {
  ms: { flood: "banjir", landslide: "tanah runtuh" },
  en: { flood: "flood", landslide: "landslide" },
};

function names(list: VillageRisk[], lang: "ms" | "en"): string {
  const shown = list.slice(0, 3).map((r) => r.village.name).join(", ");
  const more = list.length - 3;
  if (more <= 0) return shown;
  return lang === "ms" ? `${shown} dan ${more} kampung lain` : `${shown} and ${more} other villages`;
}

function template(lang: "ms" | "en", w: Pick<AreaWarning, "district" | "hazard" | "level">, list: VillageRisk[]): string {
  const level = LEVEL_TEXT[lang]![w.level];
  const hazard = HAZARD_TEXT[lang]![w.hazard];
  return lang === "ms"
    ? `${level} ${hazard} untuk daerah ${w.district}: ${names(list, "ms")}. Bersedia untuk berpindah ke kawasan tinggi atau pusat pemindahan terdekat. ` +
      `Bantu jiran yang terlantar, kurang upaya dan warga emas. Ikut arahan pihak berkuasa.`
    : `${level}: ${hazard} risk in ${w.district} district for ${names(list, "en")}. Be ready to move to higher ground or the nearest evacuation centre. ` +
      `Help bedridden, disabled and elderly neighbours. Follow official instructions.`;
}

/** One deterministic warning per district (and hazard). Text in the region's languages (Malay / English templates). */
export function buildAreaWarnings(areaWide: VillageRisk[], ctx: { regionId: string; runId: string; languages: string[] }): AreaWarning[] {
  const groups = new Map<string, VillageRisk[]>();
  for (const r of areaWide) {
    const k = `${r.village.district}|${r.hazard}`;
    const list = groups.get(k);
    if (list) list.push(r);
    else groups.set(k, [r]);
  }
  const langs = ctx.languages.filter((l): l is "ms" | "en" => l === "ms" || l === "en");
  const out: AreaWarning[] = [];
  for (const [k, list] of groups) {
    const [district, hazard] = k.split("|") as [string, AreaWarning["hazard"]];
    const top = list.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a));
    const w = { district, hazard, level: top.level };
    out.push({
      id: `area:${ctx.runId}:${district}:${hazard}`,
      regionId: ctx.regionId,
      runId: ctx.runId,
      ...w,
      villageIds: list.map((r) => r.village._id),
      people: list.reduce((n, r) => n + r.village.population, 0),
      vulnerable: list.reduce((n, r) => n + r.vulnerable, 0),
      evidence: top.signals.map((x) => x.text),
      messages: (langs.length ? langs : (["en"] as const)).map((lang) => ({ lang, text: template(lang, w, list) })),
      status: "needs_approval",
      label: "Area-wide warning (deterministic template, no AI)",
    });
  }
  return out.sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.villageIds.length - a.villageIds.length);
}
