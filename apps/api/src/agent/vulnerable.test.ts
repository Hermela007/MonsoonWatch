import { test } from "node:test";
import assert from "node:assert/strict";
import type { Alert, Pickup, Village } from "@monsoonwatch/shared";
import { checkVulnerable, suggestPickups, vehicleFor } from "./vulnerable";

const village: Village = {
  _id: "kg-manik-urai",
  regionId: "kelantan",
  name: "Kg. Manik Urai",
  altNames: [],
  location: { type: "Point", coordinates: [102.2, 5.3] },
  population: 300,
  district: "Kuala Krai",
  vulnerable: { bedridden: 12, disabled: 8, elderly: 40, noTransport: 25, source: "test", estimated: true },
};

const alertWith = (pickups: Pickup[]): Pick<Alert, "villageId" | "pickups"> => ({ villageId: village._id, pickups });

test("suggestPickups orders bedridden first and covers everyone", () => {
  const p = suggestPickups(village, false);
  assert.deepEqual(p.map((x) => x.category), ["bedridden", "disabled", "elderly", "noTransport"]);
  assert.equal(p[0]!.vehicle, "ambulance");
  assert.equal(checkVulnerable([alertWith(p)], village, { routeCrossesFlood: false }).passed, true);
});

test("demo beat: first plan forgets the bedridden → FAIL, replan → PASS", () => {
  const forgot = suggestPickups(village, false).filter((p) => p.category !== "bedridden");
  const r1 = checkVulnerable([alertWith(forgot)], village, { routeCrossesFlood: false });
  assert.equal(r1.passed, false);
  assert.match(r1.detail, /12 of 12 bedridden/);

  const r2 = checkVulnerable([alertWith(suggestPickups(village, true))], village, { routeCrossesFlood: true });
  assert.equal(r2.passed, true);
  assert.match(r2.detail, /12 bedridden first by boat/);
});

test("coverage can be split across a village's alerts", () => {
  const all = suggestPickups(village, false);
  const r = checkVulnerable([alertWith(all.slice(0, 2)), alertWith(all.slice(2))], village, { routeCrossesFlood: false });
  assert.equal(r.passed, true);
});

test("priority order must not go backwards", () => {
  const p = suggestPickups(village, false).map((x) => ({ ...x }));
  p[0]!.order = 4; // bedridden last
  p[3]!.order = 1;
  assert.equal(checkVulnerable([alertWith(p)], village, { routeCrossesFlood: false }).passed, false);
});

test("route across floodwater needs boats; bedridden never by bus", () => {
  assert.equal(vehicleFor("elderly", true), "boat");
  const byRoad = suggestPickups(village, false);
  assert.equal(checkVulnerable([alertWith(byRoad)], village, { routeCrossesFlood: true }).passed, false);
  const bus = suggestPickups(village, false).map((x) => (x.category === "bedridden" ? { ...x, vehicle: "bus" as const } : x));
  assert.equal(checkVulnerable([alertWith(bus)], village, { routeCrossesFlood: false }).passed, false);
});

test("village without vulnerable data passes with an explicit note", () => {
  const { vulnerable: _omit, ...plain } = village;
  const r = checkVulnerable([], plain, { routeCrossesFlood: false });
  assert.equal(r.passed, true);
  assert.match(r.detail, /no vulnerable residents recorded/);
});
