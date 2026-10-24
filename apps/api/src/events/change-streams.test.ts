import { test } from "node:test";
import assert from "node:assert/strict";
import { wantsHudStep } from "./change-streams";

const sp = { source: "stream_processing" };

test("HUD step for every Stream Processing river crossing", () => {
  for (const level of ["alert", "warning", "danger"]) assert.equal(wantsHudStep({ ...sp, type: "river_threshold", level }), true);
});

test("HUD step for rain only at warning or danger (alert-level rain is too frequent in the monsoon)", () => {
  assert.equal(wantsHudStep({ ...sp, type: "rain_accumulation", level: "alert" }), false);
  assert.equal(wantsHudStep({ ...sp, type: "rain_accumulation", level: "warning" }), true);
  assert.equal(wantsHudStep({ ...sp, type: "rain_accumulation", level: "danger" }), true);
});

test("no HUD step for risk events not written by Stream Processing", () => {
  assert.equal(wantsHudStep({ source: "agent", type: "river_threshold", level: "danger" }), false);
});
