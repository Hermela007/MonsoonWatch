// `pnpm load:osm` — OSM roads and rivers for the region → `geo` (one doc per feature).
//   roads:  highway = motorway … residential (+ _link). Split at junctions so B can route on it:
//           one feature = one segment between two junction nodes (a node used by 2+ road ways,
//           or used twice by one way) or way ends. id = "<osmWayId>:<segmentIndex>", stable as
//           long as the OSM data is the same (it comes from the cache with --from-cache).
//           Segments with any point outside the region bbox are dropped.
//   rivers: waterway=river, one feature per OSM way, id = "river:<osmWayId>".
//   buildings: not loaded — Kelantan has too many; /geo returns an empty collection.
//           Travel restrictions copied from the way's tags (optional RoadProps): oneway, bridge, access,
//           maxweightT, surface — see restrictions() below.
// Safe to re-run (replaces the region's geo docs, so re-run `pnpm prep:hazards` after it).
// Offline: pnpm load:osm --from-cache
import { fileURLToPath } from "node:url";
import { COLLECTIONS, type LineStringGeom, type LngLat, type Region, type RiverFeature, type RoadProps } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";
import { overpass, type OsmElement } from "./lib/osm";
import { restrictions } from "./lib/road-restrictions";

const dataDir = fileURLToPath(new URL("./data/osm/", import.meta.url));
const fromCache = process.argv.includes("--from-cache");

const ROAD_RE = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$";

type GeoDoc =
  | { _id: string; regionId: string; layer: "road"; geometry: LineStringGeom; properties: RoadProps }
  | { _id: string; regionId: string; layer: "river"; geometry: LineStringGeom; properties: RiverFeature["properties"] };

function haversineM([lon1, lat1]: LngLat, [lon2, lat2]: LngLat): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(a));
}

const lineLengthM = (coords: LngLat[]) => coords.slice(1).reduce((sum, c, i) => sum + haversineM(coords[i]!, c), 0);
const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Round to 6 dp (~0.1 m) and drop vertices that collapse onto the previous one (nodes a few cm apart). */
function compact(coords: LngLat[]): LngLat[] {
  const out: LngLat[] = [];
  for (const [lon, lat] of coords) {
    const p: LngLat = [round6(lon), round6(lat)];
    const prev = out[out.length - 1];
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) out.push(p);
  }
  return out.length >= 2 ? out : coords;
}

/** Size of the largest connected component (by from/to node), as a share of all segments. */
function largestComponentShare(roads: RoadProps[]): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root)! !== root) root = parent.get(root)!;
    while (parent.get(x)! !== root) { const next = parent.get(x)!; parent.set(x, root); x = next; }
    return root;
  };
  for (const r of roads) {
    if (!parent.has(r.from)) parent.set(r.from, r.from);
    if (!parent.has(r.to)) parent.set(r.to, r.to);
    parent.set(find(r.from), find(r.to));
  }
  const sizes = new Map<string, number>();
  for (const r of roads) sizes.set(find(r.from), (sizes.get(find(r.from)) ?? 0) + 1);
  return roads.length ? Math.max(...sizes.values()) / roads.length : 0;
}

try {
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: env.regionId });
  if (!region) throw new Error(`Region "${env.regionId}" not found — run \`pnpm seed:region\` first.`);
  const [minLon, minLat, maxLon, maxLat] = region.bbox;
  const inBbox = ([lon, lat]: LngLat) => lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;

  // Ways with their node ids, then (>) every node they use, with coordinates.
  const query = `[out:json][timeout:170];
area["ISO3166-2"="MY-03"]->.k;
(
  way["highway"~"${ROAD_RE}"](area.k)(${minLat},${minLon},${maxLat},${maxLon});
  way["waterway"="river"](area.k)(${minLat},${minLon},${maxLat},${maxLon});
);
out body;
>;
out skel qt;`;
  const elements = await overpass(query, `${dataDir}geo.${env.regionId}.json.gz`, fromCache);

  const coord = new Map<number, LngLat>();
  for (const e of elements) if (e.type === "node" && e.lon !== undefined && e.lat !== undefined) coord.set(e.id, [e.lon, e.lat]);
  const byId = (a: OsmElement, b: OsmElement) => a.id - b.id; // deterministic order regardless of Overpass output order
  const ways = elements.filter((e) => e.type === "way" && e.nodes && e.nodes.length >= 2).sort(byId);
  const roadWays = ways.filter((w) => new RegExp(ROAD_RE).test(w.tags?.highway ?? ""));
  const riverWays = ways.filter((w) => w.tags?.waterway === "river");
  if (roadWays.length === 0) throw new Error("Overpass returned no roads — check the query / region bbox.");

  // Junctions: every way end, plus any node used more than once across all road ways.
  const uses = new Map<number, number>();
  const junctions = new Set<number>();
  for (const w of roadWays) {
    const nodes = w.nodes!;
    junctions.add(nodes[0]!).add(nodes[nodes.length - 1]!);
    for (const n of nodes) uses.set(n, (uses.get(n) ?? 0) + 1);
  }
  for (const [n, count] of uses) if (count >= 2) junctions.add(n);

  const docs: GeoDoc[] = [];
  const roads: RoadProps[] = [];
  let droppedOutside = 0, droppedNoCoords = 0, droppedZeroLength = 0;
  for (const w of roadWays) {
    const nodes = w.nodes!;
    // Cut points: indices of junction nodes. A loop that would start and end on the same node
    // (closed way with no other junction) is cut at its middle so from !== to.
    const cuts = nodes.map((n, i) => (junctions.has(n) ? i : -1)).filter((i) => i >= 0);
    for (let k = cuts.length - 1; k > 0; k--) {
      const [a, b] = [cuts[k - 1]!, cuts[k]!];
      if (nodes[a] === nodes[b] && b - a >= 2) {
        const mid = Math.floor((a + b) / 2);
        cuts.splice(k, 0, mid);
        junctions.add(nodes[mid]!);
      }
    }
    for (let s = 0; s < cuts.length - 1; s++) {
      const segNodes = nodes.slice(cuts[s], cuts[s + 1]! + 1);
      const id = `${w.id}:${s}`;
      const coords = segNodes.map((n) => coord.get(n));
      if (coords.some((c) => !c)) { droppedNoCoords++; continue; }
      const full = coords as LngLat[];
      if (!full.every(inBbox)) { droppedOutside++; continue; }
      const lengthM = lineLengthM(full);
      if (!(lengthM > 0) || segNodes[0] === segNodes[segNodes.length - 1]) { droppedZeroLength++; continue; }
      const props: RoadProps = {
        id,
        from: String(segNodes[0]),
        to: String(segNodes[segNodes.length - 1]),
        ...(w.tags?.name ? { name: w.tags.name } : {}),
        highway: w.tags!.highway!,
        lengthM: Math.round(lengthM * 10) / 10,
        ...restrictions(w.tags),
      };
      roads.push(props);
      docs.push({ _id: id, regionId: env.regionId, layer: "road", geometry: { type: "LineString", coordinates: compact(full) }, properties: props });
    }
  }

  let rivers = 0;
  for (const w of riverWays) {
    const coords = w.nodes!.map((n) => coord.get(n)).filter((c): c is LngLat => !!c);
    if (coords.length < 2) continue;
    const id = `river:${w.id}`;
    const name = w.tags?.["name:ms"] ?? w.tags?.name;
    docs.push({
      _id: id,
      regionId: env.regionId,
      layer: "river",
      geometry: { type: "LineString", coordinates: compact(coords) },
      properties: { id, ...(name ? { name } : {}), waterway: w.tags!.waterway! },
    });
    rivers++;
  }

  const coll = db.collection<GeoDoc>(COLLECTIONS.geo);
  await coll.deleteMany({ regionId: env.regionId, layer: { $in: ["road", "river"] } });
  for (let i = 0; i < docs.length; i += 5000) await coll.insertMany(docs.slice(i, i + 5000), { ordered: false });

  const usedJunctions = new Set(roads.flatMap((r) => [r.from, r.to])).size;
  const byClass = roads.reduce<Record<string, number>>((acc, r) => ((acc[r.highway] = (acc[r.highway] ?? 0) + 1), acc), {});
  console.log(`✅ ${roads.length} road segments from ${roadWays.length} ways, ${usedJunctions} junctions`);
  console.log(`   by class: ${Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const tagged = (k: keyof RoadProps) => roads.filter((r) => r[k] !== undefined).length;
  console.log(`   restrictions: oneway ${tagged("oneway")} (forward ${roads.filter((r) => r.oneway === "forward").length}, reverse ${roads.filter((r) => r.oneway === "reverse").length}, no ${roads.filter((r) => r.oneway === "no").length}), bridge ${tagged("bridge")}, access ${tagged("access")}, maxweightT ${tagged("maxweightT")}, surface ${tagged("surface")}`);
  console.log(`   dropped: ${droppedOutside} outside bbox, ${droppedNoCoords} missing node coords, ${droppedZeroLength} zero-length`);
  console.log(`   largest connected component: ${(largestComponentShare(roads) * 100).toFixed(1)}% of segments`);
  console.log(`✅ ${rivers} rivers`);
  console.log("   buildings: not loaded (too many in Kelantan) — /geo returns an empty collection");
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
