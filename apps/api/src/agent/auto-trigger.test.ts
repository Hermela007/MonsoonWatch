import { test } from "node:test";
import assert from "node:assert/strict";
import type { RiskEvent } from "@monsoonwatch/shared";
import { createAutoTrigger } from "./auto-trigger";

type Ev = RiskEvent & { mode?: "live" | "replay" };
const ev = (id: string, stationId: string, level: RiskEvent["level"], ts: string, mode: "live" | "replay" = "replay"): Ev => ({
  _id: id, regionId: "kelantan", ts, type: "river_threshold", stationId, level, value: 0, threshold: 0,
  message: `${stationId} ${level}`, source: "stream_processing", mode,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("first event per station/level and escalations start runs; repeats and low levels don't", async () => {
  const started: string[] = [];
  const t = createAutoTrigger({ coalesceMs: 20, log: () => {}, start: async (_r, _m, e) => { started.push(e._id); } });

  assert.equal(t.onRiskEvent(ev("a:alert", "a", "alert", "2014-12-20T00:00:00Z")), false); // below warning
  assert.equal(t.onRiskEvent(ev("a:warning:1", "a", "warning", "2014-12-21T00:00:00Z")), true);
  assert.equal(t.onRiskEvent(ev("a:warning:1", "a", "warning", "2014-12-21T00:00:00Z")), false); // same _id
  assert.equal(t.onRiskEvent(ev("a:warning:2", "a", "warning", "2014-12-22T00:00:00Z")), false); // same level, next day
  assert.equal(t.onRiskEvent(ev("b:danger:1", "b", "danger", "2014-12-22T00:00:00Z")), true); // other station, coalesced
  await wait(60);
  assert.deepEqual(started, ["b:danger:1"], "one run, triggered by the most severe event");

  assert.equal(t.onRiskEvent(ev("a:danger:1", "a", "danger", "2014-12-23T00:00:00Z")), true); // escalation
  await wait(60);
  assert.deepEqual(started, ["b:danger:1", "a:danger:1"]);
  t.stop();
});

test("a replay restart (clock jumps back) resets the memory", async () => {
  const started: string[] = [];
  const t = createAutoTrigger({ coalesceMs: 10, log: () => {}, start: async (_r, _m, e) => { started.push(e._id); } });
  t.onRiskEvent(ev("a:warning:x", "a", "warning", "2014-12-24T00:00:00Z"));
  await wait(40);
  assert.equal(t.onRiskEvent(ev("a:warning:y", "a", "warning", "2014-12-12T00:00:00Z")), true);
  await wait(40);
  assert.equal(started.length, 2);
  t.stop();
});

test("live and replay lanes are separate; non-stream-processing events are ignored", () => {
  const t = createAutoTrigger({ coalesceMs: 1_000, log: () => {}, start: async () => {} });
  assert.equal(t.onRiskEvent(ev("l1", "a", "warning", new Date().toISOString(), "live")), true);
  assert.equal(t.onRiskEvent(ev("r1", "a", "warning", "2014-12-21T00:00:00Z", "replay")), true);
  assert.equal(t.onRiskEvent({ ...ev("x", "c", "danger", "2014-12-21T00:00:00Z"), source: "agent" }), false);
  t.stop();
});
