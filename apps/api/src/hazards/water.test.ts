import { test } from "node:test";
import assert from "node:assert/strict";
import {
  curveAnchors, dischargeToLevel, floodedSegmentIds, highestRisk, levelName, replayLevels, riskRatio,
  FLOODPLAIN_M, MAX_GAUGE_DIST_M, type Gauge, type Segment, type Thresholds,
} from "./water";

// Kuala Krai's real JPS thresholds
const KK: Thresholds = { normal: 15, alert: 20, warning: 22, danger: 25 };
const gauge = (id: string, t: Thresholds, cellId = "c1"): Gauge => ({ id, name: id, lngLat: [102.2, 5.53], thresholds: t, cellId });
const seg = (id: string, groundM: number, over: Partial<Segment> = {}): Segment => ({ id, groundM, riverDistM: 500, gaugeId: "kk", gaugeDistM: 2000, ...over });

test("discharge → level hits the anchors and is linear between them", () => {
  assert.equal(dischargeToLevel(1500, KK), 20); // alert
  assert.equal(dischargeToLevel(4500, KK), 25); // danger
  assert.equal(dischargeToLevel(3000, KK), 22.5); // halfway alert → danger
  assert.equal(dischargeToLevel(1000, KK), 17.5); // halfway normal → alert
});

test("discharge → level clamps at normal and extrapolates above danger", () => {
  assert.equal(dischargeToLevel(100, KK), 15);
  assert.equal(dischargeToLevel(500, KK), 15);
  assert.ok(Math.abs(dischargeToLevel(6000, KK) - 27.5) < 1e-9); // +1,500 m³/s above danger = +2.5 m
});

test("calibrated: the official 2014 peak is reached at the cell's own Dec 2014 peak discharge", () => {
  const cal = { peakM: 34.17, cellPeakM3s: 5187 }; // Kuala Krai (Tangga Krai), JPS table
  assert.ok(Math.abs(dischargeToLevel(5187, KK, cal) - 34.17) < 1e-9);
  // the lower anchors are unchanged
  assert.equal(dischargeToLevel(1500, KK, cal), 20);
  assert.equal(dischargeToLevel(4500, KK, cal), 25);
  // halfway between danger and the peak anchor
  assert.ok(Math.abs(dischargeToLevel((4500 + 5187) / 2, KK, cal) - (25 + 34.17) / 2) < 1e-9);
  // uncalibrated behaviour at the same discharge is far lower (the old gap)
  assert.ok(dischargeToLevel(5187, KK) < 27);
});

test("calibrated: anchors at or above the peak are dropped so the curve stays increasing", () => {
  // Pasir Puteh: our thresholds 2/2.5/3/3.2, official 2014 peak 2.67 m (below our danger level)
  const pp: Thresholds = { normal: 2, alert: 2.5, warning: 3, danger: 3.2 };
  const cal = { peakM: 2.67, cellPeakM3s: 5163 };
  assert.deepEqual(curveAnchors(pp, cal), [[500, 2], [1500, 2.5], [5163, 2.67]]);
  assert.ok(Math.abs(dischargeToLevel(5163, pp, cal) - 2.67) < 1e-9);
  let prev = -Infinity;
  for (let q = 0; q <= 6000; q += 100) {
    const l = dischargeToLevel(q, pp, cal);
    assert.ok(l >= prev, `not increasing at ${q}`);
    prev = l;
  }
  // a peak below normal can't be used → uncalibrated curve
  assert.deepEqual(curveAnchors(KK, { peakM: 10, cellPeakM3s: 5000 }), curveAnchors(KK));
});

test("replayLevels applies each gauge's calibration", () => {
  const g: Gauge = { ...gauge("kk", KK, "up"), calibration: { peakM: 34.17, cellPeakM3s: 5187 } };
  assert.equal(replayLevels([g], new Map([["up", 5187]]))[0]!.levelM, 34.17);
});

test("level names and risk ratio", () => {
  assert.equal(levelName(19.9, KK), "normal");
  assert.equal(levelName(20, KK), "alert");
  assert.equal(levelName(23, KK), "warning");
  assert.equal(levelName(26, KK), "danger");
  assert.equal(riskRatio(20, KK), 0);
  assert.equal(riskRatio(25, KK), 1);
});

test("replayLevels uses each gauge's nearest cell and its own thresholds", () => {
  const coast: Thresholds = { normal: 1, alert: 3, warning: 4, danger: 5 };
  const levels = replayLevels([gauge("kk", KK, "up"), gauge("kb", coast, "down"), gauge("x", KK, "missing")], new Map([["up", 4500], ["down", 1500]]));
  assert.deepEqual(levels.map((l) => [l.id, l.levelM, l.dischargeM3s]), [["kk", 25, 4500], ["kb", 3, 1500]]);
});

test("highestRisk picks the gauge furthest into its flood range, not the highest level", () => {
  const coast: Thresholds = { normal: 1, alert: 3, warning: 4, danger: 5 };
  const g = [gauge("kk", KK), gauge("kb", coast)];
  const best = highestRisk(g, [{ id: "kk", levelM: 21, source: "jps" }, { id: "kb", levelM: 4.8, source: "jps" }]);
  assert.equal(best?.gauge.id, "kb"); // 0.9 of its range vs Kuala Krai's 0.2
});

test("flooded: below the water surface, in the floodplain, near the gauge, river at/above alert", () => {
  const g = [gauge("kk", KK)];
  const level = [{ id: "kk", levelM: 24, source: "jps" as const }];
  const ids = floodedSegmentIds(
    [
      seg("low", 22),
      seg("high", 30),
      seg("far-from-river", 22, { riverDistM: FLOODPLAIN_M + 1 }),
      seg("far-from-gauge", 22, { gaugeDistM: MAX_GAUGE_DIST_M + 1 }),
      seg("no-ground", 22, { groundM: null }),
      seg("other-gauge", 22, { gaugeId: "missing" }),
    ],
    g,
    level,
  );
  assert.deepEqual(ids, ["low"]);
});

test("no flooding while the river is below its alert level (in-bank), even over low channel pixels", () => {
  const ids = floodedSegmentIds([seg("channel-pixel", 14)], [gauge("kk", KK)], [{ id: "kk", levelM: 19.9, source: "jps" }]);
  assert.deepEqual(ids, []);
  assert.deepEqual(floodedSegmentIds([seg("channel-pixel", 14)], [gauge("kk", KK)], [{ id: "kk", levelM: 20, source: "jps" }]), ["channel-pixel"]);
});

test("worst case (margin) floods at least as much as likely", () => {
  const segs = [seg("a", 22), seg("b", 24.5), seg("c", 27)];
  const g = [gauge("kk", KK)];
  const lv = [{ id: "kk", levelM: 24, source: "jps" as const }];
  assert.deepEqual(floodedSegmentIds(segs, g, lv), ["a"]);
  assert.deepEqual(floodedSegmentIds(segs, g, lv, 2), ["a", "b"]);
  // margin can also lift a below-alert river into flooding for the worst case
  assert.deepEqual(floodedSegmentIds([seg("a", 19)], g, [{ id: "kk", levelM: 19.5, source: "jps" }], 0), []);
  assert.deepEqual(floodedSegmentIds([seg("a", 19)], g, [{ id: "kk", levelM: 19.5, source: "jps" }], 0.5), ["a"]);
});
