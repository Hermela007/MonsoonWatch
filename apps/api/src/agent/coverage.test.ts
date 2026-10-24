import { test } from "node:test";
import assert from "node:assert/strict";
import type { Village } from "@monsoonwatch/shared";
import { accountabilitySummary, buildAdvisories, buildAreaWarnings, coverageSummary, rulesSummary, selectForGemini, type AreaWarning } from "./coverage";
import { LEVEL_WORDS } from "./verify";
import type { RulesResult } from "./rules-planner";
import type { AtRiskVillage } from "./schemas";
import type { AlertLevel, VillageRisk } from "./shortlist";

const LEVELS: AlertLevel[] = ["alert", "warning", "danger"];
const risk = (i: number, district = `D${i % 3}`, level: AlertLevel = LEVELS[i % 3]!, hazard: VillageRisk["hazard"] = "flood"): VillageRisk => ({
  village: { _id: `v${i}`, regionId: "t", name: `Kampung ${i}`, altNames: [], location: { type: "Point", coordinates: [102, 5] }, population: 100 + i, district } as Village,
  level, hazard, signals: [{ kind: "flooded_road", level: null, km: 0.2, text: "flooded road 0.2 km (approximate flood model)" }],
  concrete: 1, gaugeKm: 2, vulnerable: 3,
});
const claim = (r: VillageRisk) => ({ villageId: r.village._id } as AtRiskVillage);
const ok = (i: number): RulesResult => ({ ok: true, risk: risk(i), claim: claim(risk(i)), built: { alerts: [], routes: [], planErrors: [], results: [], passed: true }, alloc: new Map(), boatGroups: 0 });
const gem = (i: number, reason: "no_route" | "no_centre_with_space" = "no_route"): RulesResult => ({ ok: false, risk: risk(i), claim: claim(risk(i)), to: "gemini", reason, detail: "x" });
const fb = (i: number): RulesResult => ({ ok: false, risk: risk(i), claim: claim(risk(i)), to: "fallback", reason: "off_network", detail: "x" });

test("Gemini gets every fix first (urgency order), then the top tailored villages (Argon's order first), up to the cap", () => {
  const results = [ok(0), gem(1), ok(2), gem(3), fb(4), ok(5), ok(6)];
  const { picks, overCap } = selectForGemini(results, { cap: 10, tailorTop: 2, preferred: ["v6", "v2"] });
  assert.deepEqual(picks.map((p) => [p.risk.village._id, p.why]), [["v1", "fix"], ["v3", "fix"], ["v6", "tailor"], ["v2", "tailor"]]);
  assert.deepEqual(overCap, []);
});

test("over the cap: half the slots stay reserved for tailoring; fixes beyond the rest go to the fallback", () => {
  const results = [gem(0), gem(1), gem(2), gem(3), ok(4), ok(5), ok(6)];
  const { picks, overCap } = selectForGemini(results, { cap: 4, tailorTop: 5, preferred: ["v6", "v3"] });
  // Argon's order first in both lists: fixes v3 then v0; tailored v6 then v4.
  assert.deepEqual(picks.map((p) => [p.risk.village._id, p.why]), [["v3", "fix"], ["v0", "fix"], ["v6", "tailor"], ["v4", "tailor"]]);
  assert.deepEqual(overCap.map((p) => p.risk.village._id), ["v1", "v2"]);
});

test("unused tailoring slots go to fixes, and unused fix slots to tailoring", () => {
  const fixesOnly = selectForGemini([gem(0), gem(1), gem(2)], { cap: 2, tailorTop: 5 });
  assert.deepEqual(fixesOnly.picks.map((p) => p.risk.village._id), ["v0", "v1"]);
  const fewFixes = selectForGemini([gem(0), ok(1), ok(2), ok(3), ok(4)], { cap: 4, tailorTop: 5 });
  assert.deepEqual(fewFixes.picks.map((p) => p.why), ["fix", "tailor", "tailor", "tailor"]);
});

test("summaries count rules, Gemini reasons and fallback; coverage flags anything missing", () => {
  const results = [ok(0), ok(1), gem(2), gem(3, "no_centre_with_space"), fb(4)];
  assert.equal(rulesSummary(results), "Rules planner (no AI): 2/5 at-risk villages planned + verified; 2 need Gemini (no route 1, no centre with space 1); 1 fallback only (off network 1)");
  const by = new Map([["v0", "rules"], ["v1", "gemini"], ["v2", "area-wide"]] as const);
  assert.equal(coverageSummary(new Map(by), 3), "Coverage: 3 at-risk villages → 1 rules alerts, 1 Gemini alerts, 1 in area-wide fallback warnings");
  assert.match(coverageSummary(new Map(by), 4), /1 MISSING/);
});

test("area-wide warnings: one per district and hazard, highest level, ms + en template, needs approval", () => {
  const list = [risk(1, "Kuala Krai", "warning"), risk(2, "Kuala Krai", "danger"), risk(3, "Kuala Krai", "alert"), risk(4, "Kuala Krai", "alert"), risk(5, "Machang", "alert", "landslide")];
  const ws = buildAreaWarnings(list, { regionId: "kelantan", runId: "r1", languages: ["ms", "en"] });
  assert.deepEqual(ws.map((w) => [w.district, w.hazard, w.level, w.villageIds.length]), [["Kuala Krai", "flood", "danger", 4], ["Machang", "landslide", "alert", 1]]);
  const kk = ws[0]!;
  assert.equal(kk.status, "needs_approval");
  assert.equal(kk.people, 101 + 102 + 103 + 104);
  assert.deepEqual(kk.messages.map((m) => m.lang), ["ms", "en"]);
  assert.match(kk.messages[0]!.text, /^BAHAYA banjir untuk daerah Kuala Krai: Kampung 1, Kampung 2, Kampung 3 dan 1 kampung lain\./);
  assert.match(kk.messages[1]!.text, /^DANGER: flood risk in Kuala Krai district for Kampung 1, Kampung 2, Kampung 3 and 1 other villages\./);
  assert.ok(kk.messages.every((m) => m.text.length <= 500));
  assert.match(ws[1]!.messages[0]!.text, /^WASPADA tanah runtuh/);
  assert.equal(kk.kind, "evacuate");
  assert.match(kk.messages[1]!.text, /Move now to higher ground/); // at risk: not just "be ready"
  assert.match(kk.messages[1]!.text, /bedridden, disabled and elderly people who need to be collected/);
  assert.deepEqual(kk.vulnerableByCategory, { bedridden: 0, disabled: 0, elderly: 0, noTransport: 0 }); // fixtures have no counts
});

test("advisories: watch villages (river at alert+ nearby) and unknown villages each get a district advisory", () => {
  const v = (i: number, district: string, vulnerable?: Village["vulnerable"]) =>
    ({ _id: `w${i}`, regionId: "t", name: `Kampung W${i}`, altNames: [], location: { type: "Point", coordinates: [102, 5] }, population: 200, district, ...(vulnerable && { vulnerable }) }) as Village;
  const ws = buildAdvisories({
    watch: [{ village: v(1, "Bachok", { bedridden: 1, disabled: 2, elderly: 3, noTransport: 4, source: "t", estimated: true }), level: "danger" }, { village: v(2, "Bachok"), level: "warning" }],
    unknown: [{ village: v(3, "Jeli"), reason: "nearest road's flood status is unknown (no river gauge in range)" }],
  }, { regionId: "kelantan", runId: "r1", languages: ["ms", "en"] });
  assert.deepEqual(ws.map((w) => [w.kind, w.district, w.level, w.villageIds.length]), [["advisory", "Bachok", "danger", 2], ["advisory", "Jeli", "alert", 1]]);
  const [bachok, jeli] = ws as [AreaWarning, AreaWarning];
  assert.equal(bachok.status, "needs_approval");
  assert.deepEqual(bachok.vulnerableByCategory, { bedridden: 1, disabled: 2, elderly: 3, noTransport: 4 });
  assert.match(bachok.messages[1]!.text, /^DANGER: the river near Kampung W1, Kampung W2 \(Bachok district\) is at DANGER level\. Flooding is not yet shown at your village, but be ready to move/);
  assert.match(jeli.messages[1]!.text, /^ALERT: flood status is unknown for Kampung W3 \(Jeli district\) because no river gauge is in range/);
  assert.match(jeli.messages[0]!.text, /^WASPADA: status banjir tidak diketahui/);
  for (const w of ws) for (const m of w.messages) {
    assert.ok(m.text.length <= 500);
    assert.ok(m.text.toUpperCase().startsWith(LEVEL_WORDS[m.lang]![w.level]), "starts with the level word, like every alert");
  }
});

test("accountability: every village is at risk, advised or has an assessed road — none unaccounted", () => {
  const vil = (id: string) => ({ _id: id, district: "d" }) as Village;
  const screen = { atRisk: [risk(1)], watch: [{ village: vil("w"), level: "danger" as const }], unknown: [{ village: vil("u"), reason: "x" }], noSignal: [vil("n")] };
  const adv = buildAdvisories(screen, { regionId: "t", runId: "r", languages: ["en"] });
  assert.equal(accountabilitySummary(screen, adv, 4), "Every village accounted for: 1 at risk (alert or evacuate warning) + 2 advised (1 river at alert+ nearby, 1 flood model can't judge) in 2 advisories + 1 no risk signal (nearest road assessed, no message)");
  assert.match(accountabilitySummary(screen, adv, 5), /1 UNACCOUNTED/);
});
