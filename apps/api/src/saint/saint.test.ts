import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alert, AreaWarning } from "@monsoonwatch/shared";
import { readFileSync } from "node:fs";
import { AREA_BRIEF_MAX_VILLAGES, buildAreaBrief, buildBrief, whatsappUrl } from "./brief";
import { normaliseName, parseCheckins } from "./checkin";

test("parses a check-in line inside a longer WhatsApp message", () => {
  const text = "Leader replied: 30 people heading out now.\n*MW CHECKIN alert=alert-123 centre=SK Dabong people=30 status=moving*\nI'll chase again in 15 min.";
  const { checkins, errors } = parseCheckins(text);
  assert.equal(errors.length, 0);
  assert.deepEqual(checkins.map(({ raw: _raw, ...c }) => c), [{ alertId: "alert-123", centre: "SK Dabong", people: 30, status: "moving" }]);
});

test("handles several lines, center spelling, case and trailing punctuation", () => {
  const { checkins } = parseCheckins("mw checkin alert=a1 center=Sekolah Kebangsaan Dabong people=12 status=ARRIVED.\nMW CHECKIN alert=a2 centre=SMK Manek Urai people=5 status=acknowledged");
  assert.equal(checkins.length, 2);
  assert.equal(checkins[0]!.centre, "Sekolah Kebangsaan Dabong");
  assert.equal(checkins[0]!.status, "arrived");
  assert.equal(checkins[1]!.people, 5);
});

test("reports bad lines instead of guessing", () => {
  const { checkins, errors } = parseCheckins("MW CHECKIN alert=a1 centre=SK X people=lots status=moving\nMW CHECKIN alert=a1 centre=SK X people=3 status=maybe\nMW CHECKIN alert=a1 people=3 status=moving");
  assert.equal(checkins.length, 0);
  assert.equal(errors.length, 3);
});

test("same report → same idempotency key", () => {
  const a = parseCheckins("MW CHECKIN alert=a1 centre=SK Dabong people=30 status=arrived").checkins[0]!;
  const b = parseCheckins("  MW  CHECKIN alert=a1  centre=SK Dabong people=30 status=arrived ").checkins[0]!;
  assert.equal(a.raw, b.raw);
});

test("centre names match loosely", () => {
  assert.equal(normaliseName("Sekolah Kebangsaan Dabong"), normaliseName("SK Dabong"));
  assert.equal(normaliseName("SMK  Manek-Urai"), "smk manek urai");
});

const alert: Alert = {
  _id: "alert-1", regionId: "kelantan", runId: "run-1", villageId: "v1", level: "danger", hazard: "flood", etaHours: 14,
  evacCentreId: "c1", people: 120,
  pickups: [{ category: "bedridden", people: 2, vehicle: "boat", order: 1 }, { category: "elderly", people: 12, vehicle: "boat", order: 2 }],
  route: { type: "LineString", coordinates: [[102.06, 5.389], [102.01, 5.378]] },
  messages: [{ lang: "en", text: "Evacuate now to SK Dabong." }, { lang: "ms", text: "Sila berpindah sekarang ke SK Dabong." }],
  verification: [], status: "approved", approvedBy: "Heru", approvedAt: "2014-12-24T02:00:00Z",
};

test("brief includes alert, village, centre, pickups, both languages (Malay first) and the CHECKIN template", () => {
  const brief = buildBrief({ taskId: "saint-1", alert, village: { name: "Kuala Gris", district: "Kuala Krai" }, centre: { name: "SK Dabong", capacity: 400, headcount: 100 } });
  assert.match(brief, /Saint task saint-1/);
  assert.match(brief, /Kuala Gris \(Kuala Krai\), 120 people/);
  assert.match(brief, /DANGER, ETA ~14 h/);
  assert.match(brief, /300 places free of 400/);
  assert.match(brief, /1\. 2 bedridden by boat/);
  assert.ok(brief.indexOf("[BM]") < brief.indexOf("[EN]"));
  assert.match(brief, /MW CHECKIN alert=alert-1 centre=SK Dabong people=<number>/);
  assert.match(brief, /Route: \d+\.\d km/);
});

test("whatsapp link encodes the brief; no number → null", () => {
  assert.equal(whatsappUrl("", "x"), null);
  const url = whatsappUrl("+44 7700 900000", "Hi & bye\nnext");
  assert.equal(url, "https://wa.me/447700900000?text=Hi%20%26%20bye%0Anext");
});

const areaFixture = JSON.parse(readFileSync(new URL("../../../../packages/shared/fixtures/area-warning.evacuate.json", import.meta.url), "utf8")) as AreaWarning;

test("district warning brief: villages, estimated people, vulnerable, Malay first, check-in line with the warning id", () => {
  const warning = { ...areaFixture, status: "approved" as const, approvedBy: "Duty officer", approvedAt: "2014-12-24T04:00:00.000Z" };
  const brief = buildAreaBrief({ taskId: "saint-1", warning, villageNames: ["Kampung Sample A", "Kampung Sample B"] });
  assert.match(brief, /DISTRICT EVACUATION WARNING/);
  assert.match(brief, /District: Kuala Krai/);
  assert.match(brief, /Villages \(2\): Kampung Sample A, Kampung Sample B\n/);
  assert.match(brief, /People: about 2,000 \(estimated\)/);
  assert.match(brief, /5 bedridden, 20 disabled, 160 elderly, 65 without transport/);
  assert.ok(brief.indexOf("[BM]") < brief.indexOf("[EN]"));
  assert.match(brief, new RegExp(`MW CHECKIN alert=${warning._id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} centre=<centre name>`));
  // The check-in line Thea fills in parses back to the warning id.
  const line = `MW CHECKIN alert=${warning._id} centre=SK Dabong people=40 status=arrived`;
  assert.equal(parseCheckins(line).checkins[0]!.alertId, warning._id);
});

test("district warning brief caps the village list", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `v-${i}`);
  const warning = { ...areaFixture, villageIds: ids };
  const brief = buildAreaBrief({ taskId: "t", warning, villageNames: ids.slice(0, AREA_BRIEF_MAX_VILLAGES) });
  assert.match(brief, new RegExp(`Villages \\(40\\): .* and ${40 - AREA_BRIEF_MAX_VILLAGES} more`));
});

test("keeps underscores inside ids but strips WhatsApp italics", () => {
  const c = parseCheckins("_MW CHECKIN alert=area:r1:at_risk:Kuala Krai:flood centre=SK Dabong people=4 status=moving_").checkins[0]!;
  assert.equal(c.alertId, "area:r1:at_risk:Kuala Krai:flood");
  assert.equal(c.status, "moving");
});
