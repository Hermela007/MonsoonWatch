import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { calibrateSeries, computeFactor, inWindow, loadRainCalibration, rain6dAt, windowTotal } from "./rain-calibration";

const W = { start: "2014-12-20", end: "2014-12-25" };
const times = ["2014-12-18", "2014-12-19", "2014-12-20", "2014-12-21", "2014-12-22", "2014-12-23", "2014-12-24", "2014-12-25", "2014-12-26"];
const mm = [10, 20, 30, null, 50, 60, 70, 80, 90];

test("window is inclusive and other days are unscaled", () => {
  assert.equal(inWindow("2014-12-20", W), true);
  assert.equal(inWindow("2014-12-25", W), true);
  assert.equal(inWindow("2014-12-26", W), false);
  assert.deepEqual(calibrateSeries(times, mm, 2, W), [10, 20, 60, null, 100, 120, 140, 160, 90]);
});

test("factor = published mean / ERA5 window total, and calibrated window total = published mean", () => {
  const era5 = windowTotal(times, mm, W); // 30+50+60+70+80 = 290
  assert.equal(era5, 290);
  const f = computeFactor([600, 560], era5);
  assert.ok(Math.abs(f - 580 / 290) < 1e-12);
  const cal = calibrateSeries(times, mm, f, W);
  assert.ok(Math.abs(windowTotal(times, cal, W) - 580) < 0.5);
  assert.throws(() => computeFactor([], 100));
});

test("rain6d comes from the calibrated series, so value and rain6d are scaled consistently", () => {
  const cal = calibrateSeries(times, mm, 2, W);
  // 26 Dec (index 8): unscaled value, but its previous days inside the window are scaled
  assert.deepEqual(rain6dAt(cal, 8), [60, null, 100, 120, 140, 160]);
  assert.deepEqual(rain6dAt(cal, 2), [null, null, null, null, 10, 20]);
});

test("calibration file: every station total, daily sum and factor traces to the sources", () => {
  const c = loadRainCalibration();
  const usm = c.sources.find((s) => s.id === "usm-data-hujan")!;
  for (const s of usm.stations!) assert.equal(Object.values(s.dailyMm).reduce((a, b) => a + b, 0), s.totalMm, s.station);
  const raw = JSON.parse(readFileSync(new URL("../data/replay-2014/rain-calibration-2014.json", import.meta.url), "utf8"));
  for (const [day, total] of Object.entries(raw.sources[0].dailyTotalsAllStationsMm as Record<string, number>)) {
    assert.equal(usm.stations!.reduce((a, s) => a + s.dailyMm[day]!, 0), total, day);
  }
  const era5 = JSON.parse(readFileSync(new URL("../data/replay-2014/openmeteo-rain.json", import.meta.url), "utf8")) as { latitude: number; longitude: number; daily: { time: string[]; precipitation_sum: (number | null)[] } }[];
  for (const d of c.districts) {
    const totals = usm.stations!.filter((s) => s.district === d.district).map((s) => s.totalMm);
    assert.deepEqual(usm.stations!.filter((s) => s.district === d.district).map((s) => s.station), d.stations, d.district);
    assert.equal(d.publishedMeanMm, totals.reduce((a, b) => a + b, 0) / totals.length, d.district);
    const p = era5.find((e) => e.latitude === d.gridLat && e.longitude === d.gridLon)!;
    assert.ok(p, `ERA5 point for ${d.district}`);
    assert.ok(Math.abs(windowTotal(p.daily.time, p.daily.precipitation_sum, c.window) - d.era5WindowMm) < 0.05, d.district);
    assert.ok(Math.abs(computeFactor(totals, d.era5WindowMm) - d.factor) < 1e-4, d.district);
  }
});
