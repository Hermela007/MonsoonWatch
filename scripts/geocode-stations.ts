// `pnpm geocode` — gives every station a location. JPS publishes no coordinates, so we:
//   1. use a manual override if present (scripts/data/geocode/overrides.json: { "<stationId>": [lon, lat] })
//   2. geocode the place name with OpenStreetMap Nominatim (results cached in scripts/data/geocode/cache.json)
//   3. share coordinates between co-located river + rain gauges (same JPS id prefix, e.g. 0730851WL / 0730851RF)
//   4. fall back to the district centre, marked locationSource "district" (APPROXIMATE — label it in the UI)
// Nominatim policy: max 1 request/second, identifying User-Agent. Re-runs only query new names.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLLECTIONS } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { DISTRICT_CENTRES, placeCandidates } from "./lib/geocode";

const dataDir = fileURLToPath(new URL("./data/geocode/", import.meta.url));
const cacheFile = `${dataDir}cache.json`;
const overrides = JSON.parse(readFileSync(`${dataDir}overrides.json`, "utf8")) as Record<string, [number, number]>;
const cache: Record<string, { lon: number; lat: number; label: string } | null> = existsSync(cacheFile)
  ? JSON.parse(readFileSync(cacheFile, "utf8"))
  : {};

// Kelantan bounds, to reject matches elsewhere in Malaysia
const BOUNDS = { minLon: 101.2, maxLon: 102.75, minLat: 4.5, maxLat: 6.35 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

async function nominatim(query: string) {
  if (query in cache) return cache[query];
  await sleep(Math.max(0, 1100 - (Date.now() - lastCall)));
  lastCall = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=my&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "User-Agent": "MonsoonWatch/0.1 (Encode London 2026 hackathon; flood early warning)" } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const hits = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  const inside = hits
    .map((h) => ({ lon: +h.lon, lat: +h.lat, label: h.display_name }))
    .find((h) => h.lon >= BOUNDS.minLon && h.lon <= BOUNDS.maxLon && h.lat >= BOUNDS.minLat && h.lat <= BOUNDS.maxLat);
  cache[query] = inside ?? null;
  return cache[query];
}

type Source = "manual" | "nominatim" | "shared" | "district";
interface StationRow { _id: string; name: string; district: string; kind: string }

try {
  const db = await getDb();
  const stations = await db.collection<StationRow>(COLLECTIONS.stations).find({}, { projection: { name: 1, district: 1, kind: 1 } }).toArray();
  const found = new Map<string, { coords: [number, number]; source: Source; label: string }>();

  for (const s of stations) {
    const manual = overrides[s._id];
    if (manual) { found.set(s._id, { coords: manual, source: "manual", label: "manual override" }); continue; }
    // Only accept a match whose OSM address contains the station's own district — otherwise common
    // names ("Kampung Pulai", "Lembaga") match the wrong place elsewhere in Kelantan.
    const inDistrict = <T extends { label: string }>(hit: T | null | undefined): T | null => (hit && hit.label.toLowerCase().includes(s.district.toLowerCase()) ? hit : null);
    for (const place of placeCandidates(s.name)) {
      const hit = inDistrict(await nominatim(`${place}, ${s.district}, Kelantan`)) ?? inDistrict(await nominatim(`${place}, Kelantan`));
      if (hit) { found.set(s._id, { coords: [hit.lon, hit.lat], source: "nominatim", label: hit.label }); break; }
    }
    process.stdout.write(found.has(s._id) ? "." : "x");
  }
  writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  console.log();

  // Share between co-located gauges (same 7-digit JPS prefix)
  const prefix = (id: string) => id.match(/^(\d{7})(WL|RF)/)?.[1];
  for (const s of stations) {
    if (found.has(s._id)) continue;
    const p = prefix(s._id);
    const twin = p && stations.find((o) => o._id !== s._id && prefix(o._id) === p && found.get(o._id)?.source !== undefined);
    if (twin) { const t = found.get(twin._id)!; found.set(s._id, { coords: t.coords, source: "shared", label: `same site as ${twin._id}` }); }
  }

  // Write
  const counts: Record<Source, number> = { manual: 0, nominatim: 0, shared: 0, district: 0 };
  const approximate: string[] = [];
  for (const s of stations) {
    let f = found.get(s._id);
    if (!f) {
      const c = DISTRICT_CENTRES[s.district];
      if (!c) { console.warn(`⚠️  ${s._id} ${s.name}: unknown district "${s.district}", no location`); continue; }
      f = { coords: c, source: "district", label: `${s.district} district centre (approximate)` };
      approximate.push(`${s._id}  ${s.name}  (${s.district})`);
    }
    counts[f.source]++;
    await db.collection<StationRow>(COLLECTIONS.stations).updateOne(
      { _id: s._id },
      { $set: { location: { type: "Point", coordinates: f.coords }, locationSource: f.source, locationLabel: f.label } },
    );
  }
  console.log(`✅ ${stations.length} stations: ${counts.nominatim} geocoded, ${counts.shared} shared with a co-located gauge, ${counts.manual} manual, ${counts.district} at district centre (approximate)`);
  if (approximate.length) console.log(`   Approximate (add to scripts/data/geocode/overrides.json as [lon, lat] to fix):\n   ${approximate.join("\n   ")}`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
