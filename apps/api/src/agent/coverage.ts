// Coverage guarantee: EVERY at-risk village ends with an alert.
//   1. "rules"     — the deterministic planner (rules-planner.ts) plans and verifies it, no Gemini
//   2. "gemini"    — code couldn't (no dry route, no centre with space, conflicting signals, a
//                    failed check), or it's one of the top few by urgency (tailored message):
//                    Flash-Lite draft → Flash refine, the same checks. Capped (configurable).
//   3. "area-wide" — fallback for anything still unplanned: a deterministic district warning
//                    (template, no Gemini), still needing a human approval.
//
// AreaWarning is B-internal for now: the shared Alert needs a village, a centre and a route, which
// a district warning doesn't have. Proposed to A + C as a shared type; until then area warnings
// are logged as AgentSteps and returned from the run, not saved.

import type { AtRiskVillage } from "./schemas";
import type { FallbackReason, GeminiReason, RulesResult } from "./rules-planner";
import type { AlertLevel, VillageRisk } from "./shortlist";

export type PlannedBy = "rules" | "gemini" | "area-wide";

export const GEMINI_DEFAULTS = {
  /** Most villages sent to Gemini per run (fixes first, then tailored). AGENT_GEMINI_MAX_VILLAGES overrides. */
  cap: Number(process.env.AGENT_GEMINI_MAX_VILLAGES || 10), // empty in .env = default
  /** Top villages by urgency (Argon's order first) that get a Gemini-tailored message. */
  tailorTop: 5,
};

export interface GeminiPick {
  risk: VillageRisk;
  claim: AtRiskVillage;
  why: "fix" | "tailor";
  reason?: GeminiReason;
  detail?: string;
}

/**
 * Which villages Gemini gets: every rules failure it can fix (urgency order), then the top
 * `tailorTop` rules-planned villages (Argon's order first), up to `cap`. Fixes over the cap go to
 * the fallback; tailored villages over the cap simply keep their rules alert. Pure.
 */
export function selectForGemini(results: RulesResult[], opts: { cap: number; tailorTop: number; preferred?: string[] }) {
  const fixes: GeminiPick[] = results.flatMap((r) => (!r.ok && r.to === "gemini" ? [{ risk: r.risk, claim: r.claim, why: "fix" as const, reason: r.reason, detail: r.detail }] : []));
  const ok = results.filter((r) => r.ok);
  const rank = new Map((opts.preferred ?? []).map((id, i) => [id, i]));
  const tailor: GeminiPick[] = [...ok]
    .sort((a, b) => (rank.get(a.risk.village._id) ?? Infinity) - (rank.get(b.risk.village._id) ?? Infinity)) // stable: screen order otherwise
    .slice(0, opts.tailorTop)
    .map((r) => ({ risk: r.risk, claim: r.claim, why: "tailor" as const }));
  const picks = [...fixes, ...tailor].slice(0, Math.max(0, opts.cap));
  const picked = new Set(picks.map((p) => p.risk.village._id));
  return { picks, overCap: fixes.filter((f) => !picked.has(f.risk.village._id)) };
}

export function countBy<T extends string>(items: T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const x of items) out[x] = (out[x] ?? 0) + 1;
  return out;
}
const fmt = (o: Record<string, number | undefined>) => Object.entries(o).map(([k, n]) => `${k.replace(/_/g, " ")} ${n}`).join(", ");

export function rulesSummary(results: RulesResult[]): string {
  const ok = results.filter((r) => r.ok).length;
  const gem = results.flatMap((r) => (!r.ok && r.to === "gemini" ? [r.reason] : []));
  const fb = results.flatMap((r) => (!r.ok && r.to === "fallback" ? [r.reason] : []));
  return `Rules planner (no AI): ${ok}/${results.length} at-risk villages planned + verified; ${gem.length} need Gemini` +
    `${gem.length ? ` (${fmt(countBy<GeminiReason>(gem))})` : ""}; ${fb.length} fallback only${fb.length ? ` (${fmt(countBy<FallbackReason>(fb))})` : ""}`;
}

export function coverageSummary(plannedBy: Map<string, PlannedBy>, atRiskTotal: number): string {
  const n = countBy([...plannedBy.values()]);
  return `Coverage: ${atRiskTotal} at-risk villages → ${n.rules ?? 0} rules alerts, ${n.gemini ?? 0} Gemini alerts, ` +
    `${n["area-wide"] ?? 0} in area-wide fallback warnings${plannedBy.size < atRiskTotal ? ` — ${atRiskTotal - plannedBy.size} MISSING` : ""}`;
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
