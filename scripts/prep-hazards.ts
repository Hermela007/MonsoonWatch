// `pnpm prep:hazards` — precomputes what the hazards model (apps/api/src/hazards) needs, so a
// /hazards request only compares numbers. Re-run after `pnpm load:osm` (which replaces geo docs)
// or `pnpm build:terrain`.
//   road segments (geo, layer "road") get extra field `hazard`:
//     groundM      lowest DEM elevation sampled along the segment (every ~40 m + vertices).
//                  OSM bridges (bridge=* on the way) use the lower of their two END points instead —
//                  otherwise every bridge would read the river surface beneath it and "flood".
//     riverDistM   distance to the nearest OSM river line (waterway=river)
//     riverName    that river's name (if OSM has one)
//     gaugeId      nearest usable JPS river gauge on the same named river; if the river has no name or
//                  no gauge, the nearest usable gauge overall. gaugeDistM = straight-line distance.
//     cellId       nearest GloFAS cell (Region.glofasCells) — drives the replay
//   river stations get extra field `hazardGauge` { usable, groundM, riverName, riverDistM, cellId }.
//     usable = has thresholds, a real location (locationSource nominatim/manual; district-centre
//     locations are too coarse) and a live level within 10 m of the valley floor (lowest DEM within 1 km)
//     — larger gaps mean the geocode is wrong, so its water surface would land on the wrong terrain.
// Also prints the JPS datum check: latest live level vs DEM ground at each usable gauge.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import type { AnyBulkWriteOperation } from "mongodb";
import { COLLECTIONS, type LngLat, type Region, type Station } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";
import { elevationAt, loadElevationGrid } from "@monsoonwatch/api/terrain";

const SAMPLE_M = 40;
const MAX_VALLEY_GAP_M = 10; // datum/location check: |live level − valley floor| above this → gauge not used
const INDEX_CELL_DEG = 0.02; // spatial index cell for river edges (~2.2 km)
const osmCache = fileURLToPath(new URL(`./data/osm/geo.${env.regionId}.json.gz`, import.meta.url));

interface GeoDoc { _id: string; layer: "road" | "river"; geometry: { coordinates: LngLat[] }; properties: { name?: string } }
interface Edge { ax: number; ay: number; bx: number; by: number; name?: string }

// Local equirectangular metres (fine over a ~200 km region)
const LAT0 = 5.45;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180), KY = 111_320;
const xy = ([lon, lat]: LngLat) => [lon * KX, lat * KY] as const;
const distM = (a: LngLat, b: LngLat) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.hypot(ax - bx, ay - by); };

function pointEdgeM(px: number, py: number, e: Edge): number {
  const dx = e.bx - e.ax, dy = e.by - e.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - e.ax) * dx + (py - e.ay) * dy) / len2)) : 0;
  return Math.hypot(px - (e.ax + t * dx), py - (e.ay + t * dy));
}

/** Points every SAMPLE_M along a line, plus its vertices. */
function samplePoints(coords: LngLat[]): LngLat[] {
  const out: LngLat[] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!, b = coords[i]!;
    const n = Math.floor(distM(a, b) / SAMPLE_M);
    for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / (n + 1), a[1] + ((b[1] - a[1]) * k) / (n + 1)]);
    out.push(b);
  }
  return out;
}

try {
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: env.regionId });
  if (!region) throw new Error(`Region "${env.regionId}" not found`);
  const grid = loadElevationGrid(env.regionId);
  const geo = db.collection<GeoDoc>(COLLECTIONS.geo);

  // River edges in a grid index
  const rivers = await geo.find({ regionId: env.regionId, layer: "river" } as never, { projection: { geometry: 1, properties: 1 } }).toArray();
  const index = new Map<string, Edge[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  for (const r of rivers) {
    const c = r.geometry.coordinates;
    for (let i = 1; i < c.length; i++) {
      const [ax, ay] = xy(c[i - 1]!), [bx, by] = xy(c[i]!);
      const e: Edge = { ax, ay, bx, by, name: r.properties.name };
      const minCx = Math.floor(Math.min(c[i - 1]![0], c[i]![0]) / INDEX_CELL_DEG), maxCx = Math.floor(Math.max(c[i - 1]![0], c[i]![0]) / INDEX_CELL_DEG);
      const minCy = Math.floor(Math.min(c[i - 1]![1], c[i]![1]) / INDEX_CELL_DEG), maxCy = Math.floor(Math.max(c[i - 1]![1], c[i]![1]) / INDEX_CELL_DEG);
      for (let cx = minCx; cx <= maxCx; cx++) for (let cy = minCy; cy <= maxCy; cy++) {
        const list = index.get(key(cx, cy));
        if (list) list.push(e); else index.set(key(cx, cy), [e]);
      }
    }
  }
  /** Nearest river edge to a point, searching rings of index cells outwards (up to ~20 km). */
  const nearestRiver = (p: LngLat): { m: number; name?: string } => {
    const [px, py] = xy(p);
    const cx = Math.floor(p[0] / INDEX_CELL_DEG), cy = Math.floor(p[1] / INDEX_CELL_DEG);
    let best: { m: number; name?: string } = { m: Infinity };
    for (let ring = 0; ring <= 10; ring++) {
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        for (const e of index.get(key(cx + dx, cy + dy)) ?? []) {
          const m = pointEdgeM(px, py, e);
          if (m < best.m) best = { m, name: e.name };
        }
      }
      // Anything in ring r+1 is at least r·cell away: stop once the best is closer than that.
      if (best.m < ring * INDEX_CELL_DEG * KX) break;
    }
    return best;
  };
    /** Lowest DEM within `radiusM` of a point ≈ the river channel next to a gauge ("valley floor"). */
  const valleyFloor = (p: LngLat, radiusM: number): number | null => {
    let low: number | null = null;
    const step = grid.metresPerPx;
    for (let dy = -radiusM; dy <= radiusM; dy += step) for (let dx = -radiusM; dx <= radiusM; dx += step) {
      if (dx * dx + dy * dy > radiusM * radiusM) continue;
      const e = elevationAt(grid, p[0] + dx / KX, p[1] + dy / KY);
      if (e !== null && (low === null || e < low)) low = e;
    }
    return low;
  };
  const nearestCell = (p: LngLat) => region.glofasCells.reduce((a, c) => (distM(p, c.lngLat) < distM(p, a.lngLat) ? c : a)).id;

  // Gauges
  const stations = await db.collection<Station & { locationSource?: string }>(COLLECTIONS.stations)
    .find({ regionId: env.regionId, kind: "river", location: { $exists: true } }).toArray();
  const latest = new Map(
    (await db.collection(COLLECTIONS.rawReadings).aggregate<{ _id: string; value: number; ts: Date }>([
      { $match: { "meta.kind": "river", "meta.mode": "live" } },
      { $sort: { ts: -1 } },
      { $group: { _id: "$meta.stationId", value: { $first: "$value" }, ts: { $first: "$ts" } } },
    ]).toArray()).map((r) => [r._id, r]),
  );
  const gauges: { id: string; name: string; at: LngLat; riverName?: string; usable: boolean }[] = [];
  const stationOps: AnyBulkWriteOperation<Station>[] = [];
  console.log("JPS datum check: latest live level vs DEM ground at the gauge point, and vs the valley floor");
  console.log("(lowest DEM within 1 km ≈ the river channel; the gauge reads the water surface, not the bank):");
  console.log("  station".padEnd(44) + "src".padEnd(11) + "level".padStart(8) + "ground".padStart(8) + "  Δground" + " valley".padStart(8) + "  Δvalley  alert/danger");
  const deltas: number[] = [];
  const valleyDeltas: number[] = [];
  for (const s of stations) {
    const at = s.location.coordinates;
    const groundM = elevationAt(grid, at[0], at[1]);
    const river = nearestRiver(at);
    const src = s.locationSource ?? (s._id.startsWith("gen-") ? "generated" : "unknown");
    const r = latest.get(s._id);
    const valleyM = groundM !== null ? valleyFloor(at, 1000) : null;
    // A gauge whose level is far from the valley floor around its geocoded point is mis-located
    // (e.g. Nominatim matched a same-named place elsewhere): its water surface would land on the wrong terrain.
    const offValley = r && valleyM !== null ? Math.abs(r.value - valleyM) > MAX_VALLEY_GAP_M : false;
    const usable = !!s.thresholds && groundM !== null && (src === "nominatim" || src === "manual") && !offValley;
    if (groundM !== null && (src === "nominatim" || src === "manual")) {
      const d = r ? r.value - groundM : null;
      const dv = r && valleyM !== null ? r.value - valleyM : null;
      if (d !== null) deltas.push(d);
      if (dv !== null) valleyDeltas.push(dv);
      const f = (x: number | null) => (x === null ? "—" : (x >= 0 ? "+" : "") + x.toFixed(1));
      console.log(`  ${s.name.slice(0, 41).padEnd(42)}${src.padEnd(11)}${(r ? r.value.toFixed(2) : "—").padStart(8)}${groundM.toFixed(0).padStart(8)}${f(d).padStart(9)}${(valleyM?.toFixed(0) ?? "—").padStart(8)}${f(dv).padStart(9)}  ${s.thresholds ? `${s.thresholds.alert}/${s.thresholds.danger}` : "—"}`);
    }
    gauges.push({ id: s._id, name: s.name, at, riverName: river.name, usable });
    stationOps.push({ updateOne: { filter: { _id: s._id }, update: { $set: { hazardGauge: { usable, offValley, groundM, valleyM, riverName: river.name ?? null, riverDistM: Math.round(river.m), cellId: nearestCell(at), locationSource: src } } } as never } });
  }
  const summary = (label: string, ds: number[]) => {
    ds.sort((a, b) => a - b);
    console.log(`  → vs ${label}: median Δ ${ds[Math.floor(ds.length / 2)]?.toFixed(1)} m, ${ds.filter((d) => Math.abs(d) <= 10).length}/${ds.length} within ±10 m`);
  };
  summary("gauge-point ground", deltas);
  summary("valley floor (1 km)", valleyDeltas);
  const usableGauges = gauges.filter((g) => g.usable);
  console.log(`  usable gauges for the water model: ${usableGauges.length}; excluded ${gauges.length - usableGauges.length}: ${gauges.filter((g) => !g.usable).map((g) => g.name.replace(/ \(F\d\)$/, "")).join(", ")}`);
  console.log(`  (excluded = district-centre location, outside the DEM, no thresholds, or > ${MAX_VALLEY_GAP_M} m off the valley floor → likely mis-geocoded)`);
  if (stationOps.length) await db.collection<Station>(COLLECTIONS.stations).bulkWrite(stationOps, { ordered: false });

  // Bridges, from the cached Overpass result
  const bridgeWays = new Set<number>();
  for (const e of JSON.parse(gunzipSync(readFileSync(osmCache)).toString("utf8")).elements as { type: string; id: number; tags?: Record<string, string> }[]) {
    if (e.type === "way" && e.tags?.highway && e.tags.bridge && e.tags.bridge !== "no") bridgeWays.add(e.id);
  }

  // Road segments
  const roads = geo.find({ regionId: env.regionId, layer: "road" } as never, { projection: { geometry: 1 } });
  let ops: AnyBulkWriteOperation<GeoDoc>[] = [];
  let n = 0, bridges = 0, noGround = 0;
  for await (const r of roads) {
    const c = r.geometry.coordinates;
    const isBridge = bridgeWays.has(Number(r._id.split(":")[0]));
    const pts = samplePoints(c);
    let groundM = Infinity;
    for (const p of isBridge ? [c[0]!, c[c.length - 1]!] : pts) {
      const e = elevationAt(grid, p[0], p[1]);
      if (e !== null && e < groundM) groundM = e;
    }
    let river: { m: number; name?: string } = { m: Infinity };
    for (const p of pts.length > 12 ? pts.filter((_, i) => i % Math.ceil(pts.length / 12) === 0 || i === pts.length - 1) : pts) {
      const near = nearestRiver(p);
      if (near.m < river.m) river = near;
    }
    const mid = c[Math.floor(c.length / 2)]!;
    const sameRiver = river.name ? usableGauges.filter((g) => g.riverName === river.name) : [];
    const pool = sameRiver.length ? sameRiver : usableGauges;
    const gauge = pool.reduce((a, g) => (distM(mid, g.at) < distM(mid, a.at) ? g : a), pool[0]!);
    if (isBridge) bridges++;
    if (!Number.isFinite(groundM)) noGround++;
    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: {
          $set: {
            hazard: {
              groundM: Number.isFinite(groundM) ? Math.round(groundM * 10) / 10 : null,
              riverDistM: Number.isFinite(river.m) ? Math.round(river.m) : null,
              riverName: river.name ?? null,
              gaugeId: gauge?.id ?? null,
              gaugeDistM: gauge ? Math.round(distM(mid, gauge.at)) : null,
              gaugeSameRiver: sameRiver.length > 0,
              cellId: nearestCell(mid),
              bridge: isBridge,
            },
          },
        } as never,
      },
    });
    if (ops.length === 2000) { await geo.bulkWrite(ops, { ordered: false }); ops = []; }
    n++;
  }
  if (ops.length) await geo.bulkWrite(ops, { ordered: false });
  console.log(`✅ ${n} road segments: hazard fields set (${bridges} bridge segments use end-point ground; ${noGround} outside the DEM)`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
