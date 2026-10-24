import { test } from "node:test";
import assert from "node:assert/strict";
import { centreStatus, countStatuses, interpolateDaily, isStaleLive, roadStatus, roadsCrossingRunouts, REPLAY_MAX_GAP_MS } from "./status";
import { FLOODPLAIN_M, MAX_GAUGE_DIST_M, type Segment, type Thresholds } from "./water";

const KK: Thresholds = { normal: 17, alert: 20, warning: 22.5, danger: 25 };
const seg = (over: Partial<Segment> = {}): Segment => ({ id: "s", groundM: 22, riverDistM: 500, gaugeId: "kk", gaugeDistM: 2000, ...over });
const fresh = new Map([["kk", 24]]);

test("road status: flooded / clear only when assessed with a fresh usable gauge", () => {
  assert.equal(roadStatus(seg(), fresh, new Set(["s"])).status, "flooded");
  assert.equal(roadStatus(seg({ groundM: 30 }), fresh, new Set()).status, "clear");
});

test("road status: outside the floodplain (> FLOODPLAIN_M, or no river found at all)", () => {
  assert.equal(roadStatus(seg({ riverDistM: FLOODPLAIN_M + 1 }), fresh, new Set()).status, "outside_floodplain");
  assert.equal(roadStatus(seg({ riverDistM: null }), fresh, new Set()).status, "outside_floodplain");
});

test("road status: unknown when ground, gauge or a fresh reading is missing — never flooded or clear", () => {
  const blocked = new Set(["s"]); // even if something put it in the blocked set
  assert.deepEqual(roadStatus(seg({ groundM: null }), fresh, blocked), { status: "unknown", reason: "no_ground" });
  assert.deepEqual(roadStatus(seg({ gaugeId: null }), fresh, blocked), { status: "unknown", reason: "no_gauge_in_range" });
  assert.deepEqual(roadStatus(seg({ gaugeDistM: MAX_GAUGE_DIST_M + 1 }), fresh, blocked), { status: "unknown", reason: "no_gauge_in_range" });
  assert.deepEqual(roadStatus(seg(), new Map(), blocked), { status: "unknown", reason: "stale_gauge" });
});

test("counts use routing.ts key names", () => {
  assert.deepEqual(countStatuses(["flooded", "clear", "clear", "outside_floodplain", "unknown"]), { flooded: 1, clear: 2, outsideFloodplain: 1, unknown: 1 });
});

test("live freshness: older than 2 h at ts is stale", () => {
  const ts = new Date("2026-10-24T12:00:00Z");
  assert.equal(isStaleLive(new Date("2026-10-24T10:30:00Z"), ts), false);
  assert.equal(isStaleLive(new Date("2026-10-24T09:59:00Z"), ts), true);
});

test("replay interpolation: midday lies between the two end-of-day values", () => {
  const d23 = { ts: new Date("2014-12-23T23:59:59+08:00"), value: 4294 };
  const d24 = { ts: new Date("2014-12-24T23:59:59+08:00"), value: 5187 };
  const r = interpolateDaily(d23, d24, new Date("2014-12-24T11:59:59+08:00"))!;
  assert.ok(Math.abs(r.value - (4294 + 5187) / 2) < 1e-6);
  assert.equal(r.interpolated, true);
  assert.equal(r.basisTs, d23.ts);
  // exactly on a reading → that value, not interpolated
  assert.deepEqual(interpolateDaily(d23, d24, d23.ts), { value: 4294, basisTs: d23.ts, interpolated: false });
});

test("replay interpolation: one side only within 36 h; nothing beyond", () => {
  const d = { ts: new Date("2015-01-10T23:59:59+08:00"), value: 900 };
  assert.equal(interpolateDaily(d, null, new Date(d.ts.getTime() + 12 * 3600e3))!.value, 900);
  assert.equal(interpolateDaily(d, null, new Date(d.ts.getTime() + REPLAY_MAX_GAP_MS + 1)), null);
  assert.equal(interpolateDaily(null, d, new Date(d.ts.getTime() - REPLAY_MAX_GAP_MS - 1)), null);
});

test("centre status: at_risk on the likely level vs only within the margin, usable, unknown", () => {
  const g = new Map([["kk", { name: "Kuala Krai", thresholds: KK }]]);
  const h = { groundM: 22, riverDistM: 500, gaugeId: "kk", gaugeDistM: 2000 };
  assert.deepEqual(
    [centreStatus(h, new Map([["kk", 24]]), g, 2).status, centreStatus(h, new Map([["kk", 24]]), g, 2).basis],
    ["at_risk", "likely"],
  );
  const m = centreStatus({ ...h, groundM: 25 }, new Map([["kk", 24]]), g, 2);
  assert.deepEqual([m.status, m.basis], ["at_risk", "uncertainty_margin"]);
  assert.match(m.reason, /uncertainty margin/);
  assert.equal(centreStatus({ ...h, groundM: 30 }, new Map([["kk", 24]]), g, 2).status, "usable");
  // below alert even with the margin → in-bank → usable
  assert.equal(centreStatus({ ...h, groundM: 15 }, new Map([["kk", 17]]), g, 2).status, "usable");
  assert.equal(centreStatus({ ...h, riverDistM: FLOODPLAIN_M + 1 }, new Map(), g, 2).status, "usable");
  assert.equal(centreStatus(h, new Map(), g, 2).status, "unknown"); // no fresh reading
  assert.equal(centreStatus({ ...h, gaugeDistM: MAX_GAUGE_DIST_M + 1 }, new Map([["kk", 24]]), g, 2).status, "unknown");
  assert.equal(centreStatus({ ...h, groundM: null }, new Map([["kk", 24]]), g, 2).status, "unknown");
  assert.equal(centreStatus(undefined, new Map(), g, 2).status, "unknown");
});

test("landslide: only roads crossing a runout line", () => {
  const roads = [
    { id: "crosses", coords: [[0, 0], [2, 2]] as [number, number][] },
    { id: "near", coords: [[0, 3], [1, 3]] as [number, number][] },
  ];
  assert.deepEqual(roadsCrossingRunouts(roads, [{ coordinates: [[0, 2], [2, 0]] }]), ["crosses"]);
  assert.deepEqual(roadsCrossingRunouts(roads, []), []);
});
