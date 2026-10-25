import { test } from "node:test";
import assert from "node:assert/strict";
import type { Village } from "@monsoonwatch/shared";
import type { ElevationGrid } from "../hazards/terrain";
import { OPTION_A, landslideEventsForVillages, levelFromRisk, rainLevel, rainOverDays, runoutPath, screenLandslides, slopeDegAt } from "./landslide";

// 60×60 px synthetic hill, 75 m pixels: a steep cone in the middle on flat ground.
function hill(): ElevationGrid {
  const w = 60, h = 60;
  const data = new Int16Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - 30, y - 30);
    data[y * w + x] = Math.max(0, Math.round(1200 - r * 60)); // ≈ 38.7° flank
  }
  return { regionId: "t", bbox: [102, 5, 102 + w * 0.000675, 5 + h * 0.000675], width: w, height: h, dLon: 0.000675, dLat: 0.000675, metresPerPx: 75, scale: 1, nodata: -32768, minElev: 0, maxElev: 1200, source: "test", data };
}
const centre: [number, number] = [102.02, 5.02];

test("rain accumulation uses today + previous days; nulls count as 0", () => {
  assert.equal(rainOverDays({ value: 20, rain6d: [1, 2, 3, 4, null, 10] }, 3), 30);
  assert.equal(rainOverDays({ value: 20 }, 1), 20);
});

test("highest reached level wins across mixed windows (option A)", () => {
  const p = { stationId: "s", lngLat: centre, value: 120, rain6d: [0, 0, 0, 0, 0, 0] };
  assert.equal(rainLevel(p, OPTION_A)!.level, "warning"); // 120 mm/1 d ≥ 100
  assert.equal(rainLevel({ ...p, value: 10, rain6d: [0, 0, 0, 0, 20, 20] }, OPTION_A)!.level, "alert"); // 50 mm / 3 d
  assert.equal(rainLevel({ ...p, value: 5, rain6d: [] }, OPTION_A), null);
});

test("slope and steepest-descent runout on the synthetic hill", () => {
  const g = hill();
  assert.ok(slopeDegAt(g, 30, 20)! > 35);
  const path = runoutPath(g, 30, 22);
  assert.ok(path.length > 3);
  assert.ok(path[path.length - 1]![1] > path[0]![1] - 1); // moved, stayed in the grid
});

test("no rain above threshold → no cells; heavy rain → cells + runouts in the danger band", () => {
  const g = hill();
  assert.equal(screenLandslides(g, [{ stationId: "s", lngLat: centre, value: 5 }], OPTION_A, { cellPx: 4 }).landslide.cells.length, 0);
  const { landslide, sources } = screenLandslides(g, [{ stationId: "s", lngLat: centre, value: 300 }], OPTION_A, { cellPx: 4 });
  assert.ok(landslide.cells.length > 0);
  assert.ok(landslide.runouts.length > 0);
  assert.equal(levelFromRisk(landslide.runouts[0]!.risk), "danger");
  assert.ok(landslide.cells.every((c) => c.risk > 0 && c.risk <= 1));
  assert.equal(sources[0]!.level, "danger");
});

test("villages near a runout get a landslide_screen event the threshold check can use", () => {
  const g = hill();
  const { landslide, sources } = screenLandslides(g, [{ stationId: "s", lngLat: centre, value: 300 }], OPTION_A, { cellPx: 4 });
  const end = landslide.runouts[0]!.coordinates.at(-1)!;
  const v = (id: string, c: [number, number]): Village => ({ _id: id, regionId: "t", name: id, altNames: [], location: { type: "Point", coordinates: c }, population: 100, district: "d" });
  const ev = landslideEventsForVillages("t", "2014-12-23T00:00:00Z", [v("near", end), v("far", [103, 6])], landslide, sources);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.type, "landslide_screen");
  assert.match(ev[0]!.message, /not a site survey/);
});

test("a cell uses its own nearest rain station, not a wetter one further away", () => {
  const g = hill();
  const dryHere = { stationId: "dry", lngLat: centre, value: 0, rain6d: [0, 0, 0, 0, 0, 0] };
  const wetFar = { stationId: "wet", lngLat: [102.15, 5.02] as [number, number], value: 300 }; // ≈ 14 km away
  assert.equal(screenLandslides(g, [dryHere, wetFar], OPTION_A, { cellPx: 4 }).landslide.cells.length, 0);
  assert.ok(screenLandslides(g, [wetFar], OPTION_A, { cellPx: 4 }).landslide.cells.length > 0); // alone, the wet one still counts
});
