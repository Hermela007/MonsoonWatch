import { test } from "node:test";
import assert from "node:assert/strict";
import type { Village } from "@monsoonwatch/shared";
import { assignCoverage, buildAreaWarnings, coverageCounts, stopAt, type Coverage } from "./coverage";
import type { AlertLevel, VillageRisk } from "./shortlist";

const LEVELS: AlertLevel[] = ["alert", "warning", "danger"];
const risk = (i: number, district = `D${i % 3}`, level: AlertLevel = LEVELS[i % 3]!, hazard: VillageRisk["hazard"] = "flood"): VillageRisk => ({
  village: { _id: `v${i}`, regionId: "t", name: `Kampung ${i}`, altNames: [], location: { type: "Point", coordinates: [102, 5] }, population: 100 + i, district } as Village,
  level, hazard, signals: [{ kind: "flooded_road", level: null, km: 0.2, text: "flooded road 0.2 km (approximate flood model)" }],
  concrete: 1, gaugeKm: 2, vulnerable: 3,
});

/** Every at-risk village is in exactly one place: a batch (planned / queued) or an area-wide warning. */
function assertCovered(c: Coverage, atRisk: VillageRisk[]) {
  const where = new Map<string, number>();
  for (const id of [...c.batches.flat(), ...c.areaWide.map((r) => r.village._id)]) where.set(id, (where.get(id) ?? 0) + 1);
  for (const r of atRisk) assert.equal(where.get(r.village._id), 1, `${r.village._id} must be planned, queued or area-wide exactly once`);
}

test("Argon's villages go in batches of 6 (planned, then queued); every other at-risk village → area-wide", () => {
  const atRisk = Array.from({ length: 20 }, (_, i) => risk(i));
  const confirmed = ["v3", "v1", "v4", "v1", "v9", "v2", "v6", "v5", "v8", "v7"]; // urgency order, one duplicate
  const c = assignCoverage(atRisk, confirmed, 6);
  assert.deepEqual(c.batches, [["v3", "v1", "v4", "v9", "v2", "v6"], ["v5", "v8", "v7"]]);
  assert.deepEqual(coverageCounts(c), { planned: 6, queued: 3, queuedBatches: 1, areaWide: 11, districts: 3 });
  assertCovered(c, atRisk);
});

test("coverage guarantee holds for any Argon answer and any stop point (no at-risk village left out)", () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 200; round++) {
    const atRisk = Array.from({ length: Math.floor(rand() * 60) }, (_, i) => risk(i));
    // Argon may confirm any subset, in any order, and even villages the screen didn't mark.
    const confirmed = [...atRisk.filter(() => rand() < 0.3).map((r) => r.village._id), ...(rand() < 0.5 ? ["not-screened"] : [])].sort(() => rand() - 0.5);
    const c = assignCoverage(atRisk, confirmed, 6);
    assertCovered(c, atRisk);
    assertCovered(stopAt(c, Math.floor(rand() * (c.batches.length + 1)), atRisk), atRisk);
  }
});

test("stopping before batch 2 moves the queued villages to area-wide warnings", () => {
  const atRisk = Array.from({ length: 10 }, (_, i) => risk(i));
  const c = stopAt(assignCoverage(atRisk, atRisk.slice(0, 8).map((r) => r.village._id), 6), 1, atRisk);
  assert.equal(c.batches.length, 1);
  assert.deepEqual(c.areaWide.map((r) => r.village._id).sort(), ["v6", "v7", "v8", "v9"]);
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
});
