// `pnpm load:places` — villages and candidate evacuation centres for the region, from OpenStreetMap.
//   villages:     OSM place=city|town|village|hamlet inside Kelantan and the region bbox
//   evac_centres: OSM schools and community halls (the buildings Malaysia normally opens as PPS
//                 relief centres). These are CANDIDATES — capacity is an estimate until replaced by
//                 the official list (put it in scripts/data/osm/evac-centres.manual.json; it wins).
// Population: OSM `population` tag when present, otherwise a per-type estimate (populationEstimated: true).
// Elevation (m) from the Open-Meteo elevation API — the agent uses it to prefer high-ground centres.
// Safe to re-run (replaces OSM-sourced docs). Offline: pnpm load:places --from-cache
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLLECTIONS, type EvacCentre, type Region, type Village } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";
import { DISTRICT_CENTRES } from "./lib/geocode";
import { elevations, overpass, type OsmElement } from "./lib/osm";

const dataDir = fileURLToPath(new URL("./data/osm/", import.meta.url));
const fromCache = process.argv.includes("--from-cache");

const POPULATION_ESTIMATE: Record<string, number> = { city: 50000, town: 8000, village: 800, hamlet: 150 };
const CAPACITY_ESTIMATE: Record<string, number> = { school: 400, community_centre: 150, townhall: 200 };
const LATIN = /^[\p{Script=Latin}\d\s'’.,()&/-]+$/u;

function nearestDistrict(lon: number, lat: number): string {
  let best = "", bestD = Infinity;
  for (const [name, [dLon, dLat]] of Object.entries(DISTRICT_CENTRES)) {
    const d = (dLon - lon) ** 2 + (dLat - lat) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best;
}

const point = (e: OsmElement) => (e.lat !== undefined && e.lon !== undefined ? { lat: e.lat, lon: e.lon } : e.center ?? null);

try {
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: env.regionId });
  if (!region) throw new Error(`Region "${env.regionId}" not found — run \`pnpm seed:region\` first.`);
  const [minLon, minLat, maxLon, maxLat] = region.bbox;

  const query = `[out:json][timeout:170];
area["ISO3166-2"="MY-03"]->.k;
(
  node["place"~"^(city|town|village|hamlet)$"](area.k)(${minLat},${minLon},${maxLat},${maxLon});
  nwr["amenity"~"^(school|community_centre|townhall)$"](area.k)(${minLat},${minLon},${maxLat},${maxLon});
);
out center tags;`;
  const elements = await overpass(query, `${dataDir}places.${env.regionId}.json`, fromCache);
  if (elements.length === 0) throw new Error("Overpass returned nothing — check the query / region bbox.");

  // Villages
  const villages: (Village & { placeType: string; populationEstimated: boolean; districtApprox: boolean; elevationM?: number | null })[] = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const p = point(e);
    if (!t.place || !p || !t.name) continue;
    const name = t["name:ms"] ?? t["name:en"] ?? t.name;
    const alt = [t.name, t["name:en"], t["name:ms"], t.alt_name, t.old_name, t.official_name, t.short_name]
      .flatMap((v) => (v ? v.split(";") : []))
      .map((v) => v.trim())
      .filter((v) => v && v !== name && LATIN.test(v));
    const pop = Number.parseInt((t.population ?? "").replace(/[^\d]/g, ""), 10);
    villages.push({
      _id: `osm-${e.type}-${e.id}`,
      regionId: env.regionId,
      name,
      altNames: [...new Set(alt)],
      location: { type: "Point", coordinates: [p.lon, p.lat] },
      population: Number.isFinite(pop) && pop > 0 ? pop : POPULATION_ESTIMATE[t.place] ?? 500,
      populationEstimated: !(Number.isFinite(pop) && pop > 0),
      district: nearestDistrict(p.lon, p.lat),
      districtApprox: true,
      placeType: t.place,
    });
  }

  // Candidate evacuation centres
  const centres: (EvacCentre & { kind: string; capacityEstimated: boolean; source: string })[] = [];
  for (const e of elements) {
    const t = e.tags ?? {};
    const p = point(e);
    if (!t.amenity || !p || !t.name) continue;
    centres.push({
      _id: `osm-${e.type}-${e.id}`,
      regionId: env.regionId,
      name: t["name:ms"] ?? t.name,
      location: { type: "Point", coordinates: [p.lon, p.lat] },
      capacity: CAPACITY_ESTIMATE[t.amenity] ?? 150,
      capacityEstimated: true,
      headcount: 0,
      elevationM: 0,
      kind: t.amenity,
      source: "osm-candidate",
    });
  }

  // Official / hand-made list overrides OSM candidates
  const manualFile = `${dataDir}evac-centres.manual.json`;
  const manual = existsSync(manualFile) ? (JSON.parse(readFileSync(manualFile, "utf8")) as EvacCentre[]) : [];

  // Elevations
  const elevFile = `${dataDir}elevation-cache.json`;
  const villageElev = await elevations(villages.map((v) => ({ lon: v.location.coordinates[0], lat: v.location.coordinates[1] })), elevFile, fromCache);
  villages.forEach((v, i) => (v.elevationM = villageElev[i]));
  const allCentres = [...centres, ...manual.map((m) => ({ ...m, kind: "manual", capacityEstimated: false, source: "manual" }))];
  const centreElev = await elevations(allCentres.map((c) => ({ lon: c.location.coordinates[0], lat: c.location.coordinates[1] })), elevFile, fromCache);
  allCentres.forEach((c, i) => {
    const e = centreElev[i] ?? (c.source === "manual" ? c.elevationM : null);
    if (e === null || e === undefined) console.warn(`⚠️  no elevation for centre ${c.name}`);
    c.elevationM = e ?? -1; // -1 = unknown (never treat as sea level)
  });

  // Write (replace previous OSM-sourced docs for this region)
  const vColl = db.collection<Village>(COLLECTIONS.villages);
  const cColl = db.collection<EvacCentre>(COLLECTIONS.evacCentres);
  await vColl.deleteMany({ regionId: env.regionId, _id: { $regex: /^osm-/ } });
  await cColl.deleteMany({ regionId: env.regionId, $or: [{ _id: { $regex: /^osm-/ } }, { source: "manual" }] });
  if (villages.length) await vColl.insertMany(villages);
  if (allCentres.length) await cColl.insertMany(allCentres);

  const byType = villages.reduce<Record<string, number>>((acc, v) => ((acc[v.placeType] = (acc[v.placeType] ?? 0) + 1), acc), {});
  const withPop = villages.filter((v) => !v.populationEstimated).length;
  console.log(`✅ ${villages.length} villages (${Object.entries(byType).map(([k, n]) => `${n} ${k}`).join(", ")}; ${withPop} with real OSM population, rest estimated)`);
  console.log(`✅ ${allCentres.length} evacuation centres (${centres.filter((c) => c.kind === "school").length} schools, ${centres.filter((c) => c.kind !== "school").length} halls from OSM, ${manual.length} manual) — capacities ESTIMATED`);
  console.log(`   elevation: ${villageElev.filter((x) => x !== null).length}/${villages.length} villages, ${centreElev.filter((x) => x !== null).length}/${allCentres.length} centres`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
