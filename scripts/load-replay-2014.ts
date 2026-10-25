// `pnpm load:replay` — loads the reconstructed Dec 2014 Kelantan flood into raw_readings (mode "replay").
//   - River: GloFAS daily discharge (m³/s) via the Open-Meteo Flood API, for main-channel cells
//   - Rain:  Open-Meteo archive (ERA5 reanalysis) daily precipitation, per JPS rain station, sampled at the
//            station's district centre (JPS has no coordinates; the reanalysis grid is coarse anyway),
//            CALIBRATED by default: per district, 20–25 Dec scaled to the published JPS station totals
//            (scripts/data/replay-2014/rain-calibration-2014.json, lib/rain-calibration.ts). Label
//            "Calibrated reanalysis, approximate" — a scaling to published totals, not observed station data.
// Everything here is RECONSTRUCTED data and must be labelled so in the UI (GUIDELINES §2).
// Safe to re-run: replaces previous replay readings. Raw API responses are cached in
// scripts/data/replay-2014/ so it also works offline:   pnpm load:replay --from-cache
//   --no-calibrate   raw ERA5 rain (no scaling)
//   --dry-run        print raw vs calibrated rain per district from the cache; no network, no MongoDB
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLLECTIONS } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { calibrateSeries, loadRainCalibration, rain6dAt, windowTotal } from "./lib/rain-calibration";

const START = "2014-12-10";
const END = "2015-01-10";
const cacheDir = fileURLToPath(new URL("./data/replay-2014/", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
const fromCache = dryRun || process.argv.includes("--from-cache"); // a dry run never fetches (or rewrites the cache)
const calibrate = !process.argv.includes("--no-calibrate");

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
  // Extra fields on replay rain docs (not in the shared Reading type):
  calibrated?: boolean;
  calibrationLabel?: string;
  calibrationFactor?: number | null;
}

const RAW_LABEL = "Reanalysis (ERA5), not calibrated";

try {
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

  // 2. Rainfall (ERA5 reanalysis, calibrated per district) per JPS rain station, via its district centre
  const districts = Object.keys(DISTRICT_CENTRES);
  const rain = await getJson(
    "openmeteo-rain",
    `https://archive-api.open-meteo.com/v1/archive?latitude=${districts.map((k) => DISTRICT_CENTRES[k]!.lat).join(",")}` +
      `&longitude=${districts.map((k) => DISTRICT_CENTRES[k]!.lon).join(",")}` +
      `&start_date=${START}&end_date=${END}&daily=precipitation_sum&timezone=Asia%2FKuala_Lumpur`,
  );
  const cal = loadRainCalibration();
  const series = new Map<string, { time: string[]; raw: (number | null)[]; mm: (number | null)[]; factor: number | null; label: string }>();
  districts.forEach((k, i) => {
    const d = rain[i]?.daily;
    if (!d) return;
    const raw = d.precipitation_sum as (number | null)[];
    const f = calibrate ? (cal.districts.find((c) => c.district === k)?.factor ?? null) : null;
    const label = f === null ? (calibrate ? `${RAW_LABEL} (no published station for ${k})` : RAW_LABEL) : cal.label;
    series.set(k, { time: d.time, raw, mm: f === null ? raw : calibrateSeries(d.time, raw, f, cal.window), factor: f, label });
  });
  const peak = (t: string[], mm: (number | null)[]) => {
    const vals = mm.map((v) => v ?? -1);
    const m = Math.max(...vals);
    return `${m.toFixed(1)} (${t[vals.indexOf(m)]?.slice(5)})`;
  };
  console.log(`\n  Rain ${calibrate ? `calibrated per district, window ${cal.window.start} → ${cal.window.end}` : "RAW ERA5 (--no-calibrate)"}:`);
  console.log(`  ${"district".padEnd(12)} ${"factor".padStart(7)}  ${"peak mm/day raw → calibrated (date)".padEnd(40)} window total raw → calibrated`);
  for (const [k, sr] of series) {
    console.log(`  ${k.padEnd(12)} ${(sr.factor === null ? "—" : sr.factor.toFixed(3)).padStart(7)}  ${`${peak(sr.time, sr.raw)} → ${peak(sr.time, sr.mm)}`.padEnd(40)} ${windowTotal(sr.time, sr.raw, cal.window).toFixed(1)} → ${windowTotal(sr.time, sr.mm, cal.window).toFixed(1)} mm`);
  }
  if (dryRun) {
    console.log(`\n(dry run: ${docs.length} GloFAS readings and the rain above were computed from the cache; nothing written)`);
    process.exit(0);
  }

  const db = await getDb();
  const readings = db.collection<ReadingDoc>(COLLECTIONS.rawReadings);
  const rainStations = await db
    .collection<{ _id: string; district: string }>(COLLECTIONS.stations)
    .find({ kind: "rain" }, { projection: { district: 1 } })
    .toArray();
  if (rainStations.length === 0) throw new Error("No rain stations in the database yet — run `pnpm ingest:jps` first.");
  const skipped = new Set<string>();
  for (const station of rainStations) {
    const sr = series.get(station.district);
    if (!sr) { skipped.add(station.district); continue; }
    sr.time.forEach((date, j) => {
      const v = sr.mm[j];
      if (v === null || v === undefined) return;
      docs.push({
        ts: endOfDayMyt(date),
        meta: { stationId: station._id, kind: "rain", source: "openmeteo", mode: "replay" },
        value: v, // that day's total (= "since midnight" at end of day, same meaning as live)
        rain6d: rain6dAt(sr.mm, j), // 6 days before, oldest first — same (calibrated) series as value
        calibrated: sr.factor !== null,
        calibrationLabel: sr.label,
        calibrationFactor: sr.factor,
      });
    });
  }
  if (skipped.size) console.warn(`⚠️  rain stations skipped (unknown district): ${[...skipped].join(", ")}`);

  // 3. Replace previous replay readings
  const del = await readings.deleteMany({ "meta.mode": "replay", "meta.source": { $in: ["glofas", "openmeteo"] } });
  if (docs.length) await readings.insertMany(docs, { ordered: false });
  console.log(`✅ Replay ${START} → ${END}: ${docs.length} readings loaded (${del.deletedCount} old replay readings replaced). Label: "Reconstructed (GloFAS / ${calibrate ? "calibrated reanalysis, approximate" : "reanalysis"})".`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
