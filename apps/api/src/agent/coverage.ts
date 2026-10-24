// Coverage guarantee: EVERY at-risk village ends with an alert, and every other village near a
// river at alert+ (or where the flood model can't judge) gets an advisory. Nobody near danger is
// left without a message for an official to approve.
//   1. "rules"     — the deterministic planner (rules-planner.ts) plans and verifies it, no Gemini
//   2. "gemini"    — code couldn't (no road or boat route, no centre with space, conflicting signals, a
//                    failed check), or it's one of the top few by urgency (tailored message):
//                    Flash-Lite draft → Flash refine, the same checks. Capped (configurable).
//   3. "area-wide" — fallback for anything still unplanned: a deterministic district EVACUATE warning
//                    (template, no Gemini), still needing a human approval; pickups flagged for officials.
//   + advisories   — district ADVISORY warnings for "watch" villages (river at alert+ nearby, no
//                    flooding shown at the village) and "unknown" villages (model can't judge).
//
// AreaWarning is B-internal for now: the shared Alert needs a village, a centre and a route, which
// a district warning doesn't have. Proposed to A + C as a shared type; until then area warnings
// are logged as AgentSteps and returned from the run, not saved.

import type { Village, VulnerableCategory } from "@monsoonwatch/shared";
import type { AtRiskVillage } from "./schemas";
import type { FallbackReason, GeminiReason, RulesResult } from "./rules-planner";
import type { AlertLevel, RiskScreen, VillageRisk } from "./shortlist";

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
 * Which villages Gemini gets (pure), both lists in Argon's order first, then urgency (screen order):
 *   - fixes: rules failures Gemini can fix (unfixable ones (not enough space nearby, off network) never get here)
 *   - tailored: the top `tailorTop` rules-planned villages, for a Gemini-tailored message
 * Up to half the cap is RESERVED for tailored villages, so Argon's top picks are never crowded out
 * by fixes; slots either list doesn't use go to the other. Fixes over the cap go to the fallback;
 * tailored villages over the cap simply keep their rules alert.
 */
export function selectForGemini(results: RulesResult[], opts: { cap: number; tailorTop: number; preferred?: string[] }) {
  const cap = Math.max(0, opts.cap);
  const rank = new Map((opts.preferred ?? []).map((id, i) => [id, i]));
  const byArgon = <T extends { risk: VillageRisk }>(list: T[]) =>
    [...list].sort((a, b) => (rank.get(a.risk.village._id) ?? Infinity) - (rank.get(b.risk.village._id) ?? Infinity)); // stable: screen order otherwise
  const fixes: GeminiPick[] = byArgon(results.flatMap((r) => (!r.ok && r.to === "gemini" ? [{ risk: r.risk, claim: r.claim, why: "fix" as const, reason: r.reason, detail: r.detail }] : [])));
  const tailorable: GeminiPick[] = byArgon(results.filter((r) => r.ok))
    .slice(0, opts.tailorTop)
    .map((r) => ({ risk: r.risk, claim: r.claim, why: "tailor" as const }));
  const reserved = Math.min(tailorable.length, Math.floor(cap / 2));
  const fixPicks = fixes.slice(0, cap - reserved);
  const tailorPicks = tailorable.slice(0, cap - fixPicks.length);
  return { picks: [...fixPicks, ...tailorPicks], overCap: fixes.slice(fixPicks.length) };
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

/** Every village accounted for: at risk (alert or fallback), advised (watch / unknown), or no signal with an assessed road. */
export function accountabilitySummary(screen: RiskScreen, advisories: AreaWarning[], total: number): string {
  const advised = new Set(advisories.flatMap((w) => w.villageIds)).size;
  const counted = screen.atRisk.length + screen.watch.length + screen.unknown.length + screen.noSignal.length;
  return `Every village accounted for: ${screen.atRisk.length} at risk (alert or evacuate warning) + ${advised} advised ` +
    `(${screen.watch.length} river at alert+ nearby, ${screen.unknown.length} flood model can't judge) in ${advisories.length} advisories + ` +
    `${screen.noSignal.length} no risk signal (nearest road assessed, no message)${counted !== total ? ` — ${total - counted} UNACCOUNTED` : ""}`;
}

export interface AreaWarning {
  id: string;
  regionId: string;
  runId: string;
  /**
   * evacuate — at-risk villages (flooding / runout at the village) that got no individual plan:
   *            move now; officials must arrange transport and pickups (none were planned).
   * advisory — villages near a river at alert+ with no flooding shown at the village ("watch"), or
   *            where the flood model can't judge ("unknown"): be ready to move. Never "safe".
   */
  kind: "evacuate" | "advisory";
  /** Why these villages are in it (shown to the official). */
  basis: string;
  district: string;
  hazard: "flood" | "landslide";
  level: AlertLevel;
  villageIds: string[];
  people: number;
  vulnerable: number;
  /** Counts per category across the villages: pickups NOT planned — officials must arrange them. */
  vulnerableByCategory: Record<VulnerableCategory, number>;
  /** The strongest village's signals, so the text is checkable. */
  evidence: string[];
  messages: { lang: string; text: string }[];
  /** Template, no AI. Never sent without a human approval. */
  status: "needs_approval";
  label: "Area-wide warning (deterministic template, no AI)";
}

const LEVEL_RANK: Record<AlertLevel, number> = { alert: 1, warning: 2, danger: 3 };
const CATEGORIES: VulnerableCategory[] = ["bedridden", "disabled", "elderly", "noTransport"];

const LEVEL_TEXT: Record<"ms" | "en", Record<AlertLevel, string>> = {
  ms: { alert: "WASPADA", warning: "AMARAN", danger: "BAHAYA" },
  en: { alert: "ALERT", warning: "WARNING", danger: "DANGER" },
};
const HAZARD_TEXT: Record<"ms" | "en", Record<AreaWarning["hazard"], string>> = {
  ms: { flood: "banjir", landslide: "tanah runtuh" },
  en: { flood: "flood", landslide: "landslide" },
};

function names(list: Village[], lang: "ms" | "en"): string {
  const shown = list.slice(0, 3).map((v) => v.name).join(", ");
  const more = list.length - 3;
  if (more <= 0) return shown;
  return lang === "ms" ? `${shown} dan ${more} kampung lain` : `${shown} and ${more} other villages`;
}

type Basis = "at_risk" | "watch" | "unknown";
interface Group { kind: AreaWarning["kind"]; basis: Basis; district: string; hazard: AreaWarning["hazard"]; level: AlertLevel; villages: Village[]; evidence: string[] }

/** Messages start with the level word (verify.ts LEVEL_WORDS) and stay ≤ 500 characters. */
function template(lang: "ms" | "en", g: Group): string {
  const L = LEVEL_TEXT[lang][g.level];
  const H = HAZARD_TEXT[lang][g.hazard];
  const who = names(g.villages, lang);
  if (g.basis === "at_risk") {
    return lang === "ms"
      ? `${L} ${H} untuk daerah ${g.district}: ${who}. Pindah sekarang ke kawasan tinggi atau pusat pemindahan terdekat. Jangan meredah air banjir. ` +
        `Beritahu ketua kampung tentang penduduk terlantar, OKU dan warga emas yang perlu dijemput. Ikut arahan pihak berkuasa.`
      : `${L}: ${H} risk in ${g.district} district for ${who}. Move now to higher ground or the nearest evacuation centre. Do not walk or drive through floodwater. ` +
        `Tell your village head about bedridden, disabled and elderly people who need to be collected. Follow official instructions.`;
  }
  if (g.basis === "watch") {
    return lang === "ms"
      ? `${L}: paras sungai berhampiran ${who} (daerah ${g.district}) di tahap ${L}. Banjir belum ditunjukkan di kampung anda, tetapi bersedia untuk berpindah ke kawasan tinggi atau pusat pemindahan terdekat. ` +
        `Bantu jiran yang terlantar, OKU dan warga emas. Ikut arahan pihak berkuasa.`
      : `${L}: the river near ${who} (${g.district} district) is at ${L} level. Flooding is not yet shown at your village, but be ready to move to higher ground or the nearest evacuation centre. ` +
        `Help bedridden, disabled and elderly neighbours. Follow official instructions.`;
  }
  return lang === "ms"
    ? `${L}: status banjir tidak diketahui untuk ${who} (daerah ${g.district}) kerana tiada tolok sungai berdekatan. Sentiasa berwaspada dan bersedia untuk berpindah ke kawasan tinggi. ` +
      `Bantu jiran yang terlantar, OKU dan warga emas. Ikut arahan pihak berkuasa.`
    : `${L}: flood status is unknown for ${who} (${g.district} district) because no river gauge is in range. Stay alert and be ready to move to higher ground. ` +
      `Help bedridden, disabled and elderly neighbours. Follow official instructions.`;
}

const BASIS_TEXT: Record<Basis, string> = {
  at_risk: "At risk (flooding or landslide runout at the village) but no individual evacuation plan: transport and pickups must be arranged by officials",
  watch: "River gauge nearby at alert or above; flooding not shown at these villages by the (approximate) flood model",
  unknown: "Flood model can't judge these villages (no river gauge in range, or no mapped road nearby): unknown, not safe",
};

function toWarnings(groups: Group[], ctx: { regionId: string; runId: string; languages: string[] }): AreaWarning[] {
  const langs = ctx.languages.filter((l): l is "ms" | "en" => l === "ms" || l === "en");
  const out = groups.map((g): AreaWarning => {
    const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, g.villages.reduce((n, v) => n + (v.vulnerable?.[c] ?? 0), 0)])) as Record<VulnerableCategory, number>;
    return {
      id: `${g.kind === "evacuate" ? "area" : "advisory"}:${ctx.runId}:${g.basis}:${g.district}:${g.hazard}`,
      regionId: ctx.regionId,
      runId: ctx.runId,
      kind: g.kind,
      basis: BASIS_TEXT[g.basis],
      district: g.district,
      hazard: g.hazard,
      level: g.level,
      villageIds: g.villages.map((v) => v._id),
      people: g.villages.reduce((n, v) => n + v.population, 0),
      vulnerable: CATEGORIES.reduce((n, c) => n + byCat[c], 0),
      vulnerableByCategory: byCat,
      evidence: g.evidence,
      messages: (langs.length ? langs : (["en"] as const)).map((lang) => ({ lang, text: template(lang, g) })),
      status: "needs_approval",
      label: "Area-wide warning (deterministic template, no AI)",
    };
  });
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "evacuate" ? -1 : 1) || LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.villageIds.length - a.villageIds.length);
}

function groupBy<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Fallback: one "evacuate" warning per district (and hazard) for at-risk villages with no individual plan. */
export function buildAreaWarnings(areaWide: VillageRisk[], ctx: { regionId: string; runId: string; languages: string[] }): AreaWarning[] {
  const groups = [...groupBy(areaWide, (r) => `${r.village.district}|${r.hazard}`)].map(([k, list]): Group => {
    const [district, hazard] = k.split("|") as [string, AreaWarning["hazard"]];
    const top = list.reduce((a, b) => (LEVEL_RANK[b.level] > LEVEL_RANK[a.level] ? b : a));
    return { kind: "evacuate", basis: "at_risk", district, hazard, level: top.level, villages: list.map((r) => r.village), evidence: top.signals.map((x) => x.text) };
  });
  return toWarnings(groups, ctx);
}

/** Advisories, one per district and basis: "watch" (river at alert+ nearby) and "unknown" (model can't judge). */
export function buildAdvisories(screen: Pick<RiskScreen, "watch" | "unknown">, ctx: { regionId: string; runId: string; languages: string[] }): AreaWarning[] {
  const watch = [...groupBy(screen.watch, (w) => w.village.district)].map(([district, list]): Group => {
    const level = list.reduce<AlertLevel>((m, w) => (LEVEL_RANK[w.level] > LEVEL_RANK[m] ? w.level : m), "alert");
    return { kind: "advisory", basis: "watch", district, hazard: "flood", level, villages: list.map((w) => w.village), evidence: [`river gauge at ${level.toUpperCase()} within 10 km`] };
  });
  const unknown = [...groupBy(screen.unknown, (u) => u.village.district)].map(([district, list]): Group => ({
    kind: "advisory", basis: "unknown", district, hazard: "flood", level: "alert", villages: list.map((u) => u.village), evidence: [...new Set(list.map((u) => u.reason))],
  }));
  return toWarnings([...watch, ...unknown], ctx);
}
