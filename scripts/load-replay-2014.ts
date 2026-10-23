// `pnpm load:replay` — loads the reconstructed Dec 2014 Kelantan flood into raw_readings (mode "replay").
//   - River: GloFAS daily discharge (m³/s) via the Open-Meteo Flood API, for main-channel cells
//   - Rain:  Open-Meteo archive (reanalysis) daily precipitation, per JPS rain station, sampled at the
//            station's district centre (JPS has no coordinates; the reanalysis grid is coarse anyway)
// Everything here is RECONSTRUCTED data and must be labelled so in the UI (GUIDELINES §2).
// Safe to re-run: replaces previous replay readings. Raw API responses are cached in
// scripts/data/replay-2014/ so it also works offline:   pnpm load:replay --from-cache
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLLECTIONS } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";

const START = "2014-12-10";
const END = "2015-01-10";
const cacheDir = fileURLToPath(new URL("./data/replay-2014/", import.meta.url));
const fromCache = process.argv.includes("--from-cache");

// Main Kelantan channel, upstream → downstream. The river bends east towards the coast, so for each
// latitude we probe a few longitudes and keep the cell with the highest discharge (off-channel GloFAS
// cells return tiny values). Chosen ids ("glofas-<lat>-<lon>") are printed; Region.glofasCells must use them.
const CHANNEL_LATS = [
  { lat: 5.775, label: "Main channel near Kuala Krai" },
  { lat: 5.875, label: "Main channel near Tanah Merah" },
  { lat: 5.975, label: "Main channel near Pasir Mas" },
  { lat: 6.075, label: "Main channel near Kota Bharu" },
];
const CANDIDATE_LONS = [102.075, 102.125, 102.175, 102.225, 102.275];

// Approximate district centres (APPROXIMATION — used only to sample coarse reanalysis rainfall).
const DISTRICT_CENTRES: Record<string, { lat: number; lon: number }> = {
  "Gua Musang": { lat: 4.88, lon: 101.97 },
  "Kuala Krai": { lat: 5.53, lon: 102.2 },
  Jeli: { lat: 5.7, lon: 101.84 },
  "Tanah Merah": { lat: 5.8, lon: 102.15 },
  Machang: { lat: 5.76, lon: 102.22 },
  "Pasir Mas": { lat: 6.05, lon: 102.14 },
  "Kota Bharu": { lat: 6.13, lon: 102.24 },
  Tumpat: { lat: 6.2, lon: 102.17 },
  Bachok: { lat: 6.07, lon: 102.4 },
  "Pasir Puteh": { lat: 5.84, lon: 102.4 },
};

interface DailySeries { daily: { time: string[]; [k: string]: (number | null)[] | string[] } }

async function getJson(name: string, url: string): Promise<DailySeries[]> {
  const file = `${cacheDir}${name}.json`;
  if (!fromCache) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const text = await res.text();
      writeFileSync(file, text);
      const json = JSON.parse(text);
      return Array.isArray(json) ? json : [json];
    } catch (err) {
      console.warn(`⚠️  ${name}: fetch failed (${err instanceof Error ? err.message : err}) — trying cache`);
    }
  }
  if (!existsSync(file)) throw new Error(`${name}: no cached copy at scripts/data/replay-2014/${name}.json`);
  const json = JSON.parse(readFileSync(file, "utf8"));
  return Array.isArray(json) ? json : [json];
}

/** "2014-12-24" → end of that day in Malaysia time (23:59:59 +08:00), when the daily total is complete. */
const endOfDayMyt = (date: string) => new Date(`${date}T23:59:59+08:00`);

interface ReadingDoc {
  ts: Date;
  meta: { stationId: string; kind: "rain" | "glofas"; source: "glofas" | "openmeteo"; mode: "replay" };
  value: number;
  rain6d?: (number | null)[];
}

try {
  const db = await getDb();
  const readings = db.collection<ReadingDoc>(COLLECTIONS.rawReadings);
  const docs: ReadingDoc[] = [];

  // 1. River discharge (GloFAS) — probe candidate cells, keep the on-channel one per latitude
  const probes = CHANNEL_LATS.flatMap((c) => CANDIDATE_LONS.map((lon) => ({ ...c, lon })));
  const glofas = await getJson(
    "glofas-discharge",
    `https://flood-api.open-meteo.com/v1/flood?latitude=${probes.map((p) => p.lat).join(",")}` +
      `&longitude=${probes.map((p) => p.lon).join(",")}&daily=river_discharge&start_date=${START}&end_date=${END}`,
  );
  const peakOf = (vals: (number | null)[]) => Math.max(0, ...vals.filter((v): v is number => v !== null));
  for (const { lat, label } of CHANNEL_LATS) {
    const options = probes
      .map((p, i) => ({ ...p, d: glofas[i]?.daily }))
      .filter((p) => p.lat === lat && p.d)
      .map((p) => ({ ...p, peak: peakOf(p.d!.river_discharge as (number | null)[]) }))
      .sort((a, b) => b.peak - a.peak);
    const best = options[0];
    if (!best) { console.warn(`⚠️  no GloFAS data near lat ${lat}`); continue; }
    const id = `glofas-${lat.toFixed(3)}-${best.lon.toFixed(3)}`;
    const values = best.d!.river_discharge as (number | null)[];
    best.d!.time.forEach((date, j) => {
      const v = values[j];
      if (v === null || v === undefined) return;
      docs.push({ ts: endOfDayMyt(date), meta: { stationId: id, kind: "glofas", source: "glofas", mode: "replay" }, value: v });
    });
    console.log(`  GloFAS ${id} (${label}): peak ${best.peak.toFixed(0)} m³/s on ${best.d!.time[values.indexOf(best.peak)]}` +
      `  [other lons: ${options.slice(1).map((o) => `${o.lon}→${o.peak.toFixed(0)}`).join(", ")}]`);
  }

  // 2. Rainfall (reanalysis) per JPS rain station, via its district centre
  const rainStations = await db
    .collection<{ _id: string; district: string }>(COLLECTIONS.stations)
    .find({ kind: "rain" }, { projection: { district: 1 } })
    .toArray();
  if (rainStations.length === 0) throw new Error("No rain stations in the database yet — run `pnpm ingest:jps` first.");
  const districts = Object.keys(DISTRICT_CENTRES);
  const rain = await getJson(
    "openmeteo-rain",
    `https://archive-api.open-meteo.com/v1/archive?latitude=${districts.map((k) => DISTRICT_CENTRES[k]!.lat).join(",")}` +
      `&longitude=${districts.map((k) => DISTRICT_CENTRES[k]!.lon).join(",")}` +
      `&start_date=${START}&end_date=${END}&daily=precipitation_sum&timezone=Asia%2FKuala_Lumpur`,
  );
  const byDistrict = new Map(districts.map((k, i) => [k, rain[i]?.daily]));
  const skipped = new Set<string>();
  for (const station of rainStations) {
    const d = byDistrict.get(station.district);
    if (!d) { skipped.add(station.district); continue; }
    const mm = d.precipitation_sum as (number | null)[];
    d.time.forEach((date, j) => {
      const v = mm[j];
      if (v === null || v === undefined) return;
      docs.push({
        ts: endOfDayMyt(date),
        meta: { stationId: station._id, kind: "rain", source: "openmeteo", mode: "replay" },
        value: v, // that day's total (= "since midnight" at end of day, same meaning as live)
        rain6d: Array.from({ length: 6 }, (_, k) => (j - 6 + k >= 0 ? (mm[j - 6 + k] ?? null) : null)), // 6 days before, oldest first
      });
    });
  }
  for (const [district, d] of byDistrict) {
    if (!d) continue;
    const mm = d.precipitation_sum as (number | null)[];
    const peak = Math.max(...mm.filter((v): v is number => v !== null));
    console.log(`  Rain ${district}: peak ${peak.toFixed(0)} mm/day on ${d.time[mm.indexOf(peak)]}`);
  }
  if (skipped.size) console.warn(`⚠️  rain stations skipped (unknown district): ${[...skipped].join(", ")}`);

  // 3. Replace previous replay readings
  const del = await readings.deleteMany({ "meta.mode": "replay", "meta.source": { $in: ["glofas", "openmeteo"] } });
  if (docs.length) await readings.insertMany(docs, { ordered: false });
  console.log(`✅ Replay ${START} → ${END}: ${docs.length} readings loaded (${del.deletedCount} old replay readings replaced). Label: "Reconstructed (GloFAS / reanalysis)".`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
