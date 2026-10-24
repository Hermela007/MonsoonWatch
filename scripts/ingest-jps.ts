// `pnpm ingest:jps` — fetch live JPS river levels + rainfall for Kelantan, upsert `stations`,
// insert new readings (mode "live") into `raw_readings` (time series, full history) AND `reading_events`
// (normal collection, 7-day TTL — the live feed that change streams / Stream Processing watch, since time
// series collections can't be watched). Safe to re-run: readings already in raw_readings are skipped.
//   pnpm ingest:jps                  fetch once (falls back to the saved snapshot if JPS is down)
//   pnpm ingest:jps --watch          fetch every 15 minutes until stopped (Ctrl+C)
//   pnpm ingest:jps --from-snapshot  use scripts/data/jps/*.latest.html only (offline)
//
// Stored shapes (see @monsoonwatch/shared Reading / Station):
// - river reading: value = water level (m)
// - rain reading:  value = rainfall since local midnight (mm); rain6d = last 6 daily totals, oldest
//   first, null where JPS reported -9999 (missing)
// - ts is a BSON Date (time series); the API returns it as an ISO string
// - station.location is NOT set here (JPS has no coordinates) — scripts/geocode-stations.ts adds it
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AnyBulkWriteOperation } from "mongodb";
import { COLLECTIONS } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";
import { fetchJpsHtml, type JpsKind } from "./lib/jps";
import { parseRainHtml, parseRiverHtml } from "./lib/jps-parse";

const WATCH_MS = 15 * 60 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000;
const snapshotDir = fileURLToPath(new URL("./data/jps/", import.meta.url));
const args = new Set(process.argv.slice(2));

async function getHtml(kind: JpsKind): Promise<{ html: string; from: "live" | "snapshot" }> {
  const snapshot = `${snapshotDir}${kind}.latest.html`;
  if (!args.has("--from-snapshot")) {
    try {
      const html = await fetchJpsHtml(kind);
      writeFileSync(snapshot, html); // keep the latest copy as an offline fallback
      return { html, from: "live" };
    } catch (err) {
      console.warn(`⚠️  ${kind}: JPS fetch failed (${err instanceof Error ? err.message : err}) — using saved snapshot`);
    }
  }
  return { html: readFileSync(snapshot, "utf8"), from: "snapshot" };
}

interface ReadingDoc {
  ts: Date;
  meta: { stationId: string; kind: "river" | "rain"; source: "jps"; mode: "live" };
  value: number;
  rain6d?: (number | null)[];
}

async function ingestOnce() {
  const started = Date.now();
  const db = await getDb();
  const [river, rain] = await Promise.all([getHtml("river"), getHtml("rain")]);
  const riverRows = parseRiverHtml(river.html);
  const rainRows = parseRainHtml(rain.html);
  if (riverRows.length === 0 && rainRows.length === 0) throw new Error("Parsed 0 stations — has the JPS page layout changed?");

  // 1. Stations (upsert; never touch `location`, which geocoding owns)
  type StationDoc = { _id: string };
  const stationOps: AnyBulkWriteOperation<StationDoc>[] = [
    ...riverRows.map((r) => ({
      updateOne: {
        filter: { _id: r.stationId },
        update: {
          $set: {
            regionId: env.regionId, kind: "river", name: r.name, district: r.district,
            basin: r.subBasin, mainBasin: r.mainBasin, ...(r.thresholds ? { thresholds: r.thresholds } : {}),
            jps: { generatedId: r.generatedId, lastUpdated: r.lastUpdated },
          },
        },
        upsert: true,
      },
    })),
    ...rainRows.map((r) => ({
      updateOne: {
        filter: { _id: r.stationId },
        update: {
          $set: {
            regionId: env.regionId, kind: "rain", name: r.name, district: r.district,
            jps: { generatedId: r.generatedId, lastUpdated: r.lastUpdated, dailyDates: r.dailyMm.map((d) => d.date) },
          },
        },
        upsert: true,
      },
    })),
  ];
  const stationRes = await db.collection<StationDoc>(COLLECTIONS.stations).bulkWrite(stationOps, { ordered: false });

  // 2. Readings (skip missing values and readings we already have)
  const candidates: ReadingDoc[] = [
    ...riverRows.filter((r) => r.levelM !== null).map((r): ReadingDoc => ({
      ts: r.lastUpdated, meta: { stationId: r.stationId, kind: "river", source: "jps", mode: "live" }, value: r.levelM!,
    })),
    ...rainRows.filter((r) => r.sinceMidnightMm !== null).map((r): ReadingDoc => ({
      ts: r.lastUpdated, meta: { stationId: r.stationId, kind: "rain", source: "jps", mode: "live" },
      value: r.sinceMidnightMm!, rain6d: r.dailyMm.map((d) => d.mm),
    })),
  ];
  const readings = db.collection<ReadingDoc>(COLLECTIONS.rawReadings);
  const existing = await readings
    .find(
      { "meta.stationId": { $in: candidates.map((c) => c.meta.stationId) }, ts: { $in: [...new Set(candidates.map((c) => c.ts.getTime()))].map((t) => new Date(t)) } },
      { projection: { _id: 0, "meta.stationId": 1, ts: 1 } },
    )
    .toArray();
  const have = new Set(existing.map((e) => `${e.meta.stationId}|${e.ts.getTime()}`));
  const fresh = candidates.filter((c) => !have.has(`${c.meta.stationId}|${c.ts.getTime()}`));
  if (fresh.length) {
    await readings.insertMany(fresh.map((d) => ({ ...d })), { ordered: false });
    // Same docs to the live feed → change stream → SSE `reading.new` (and Stream Processing).
    await db.collection<ReadingDoc>(COLLECTIONS.readingEvents).insertMany(fresh.map((d) => ({ ...d })), { ordered: false });
  }

  // 3. Summary
  const now = Date.now();
  const stale = [...riverRows, ...rainRows].filter((r) => now - r.lastUpdated.getTime() > STALE_MS).length;
  const aboveAlert = riverRows.filter((r) => r.levelM !== null && r.thresholds && r.levelM >= r.thresholds.alert);
  console.log(
    `✅ JPS ${new Date().toISOString()} — river ${riverRows.length} (${river.from}), rain ${rainRows.length} (${rain.from}); ` +
      `stations +${stationRes.upsertedCount} new / ${stationRes.modifiedCount} updated; ` +
      `readings +${fresh.length} new (raw_readings + reading_events), ${candidates.length - fresh.length} already stored; ${stale} stations stale (>2 h); ${Date.now() - started} ms`,
  );
  for (const r of aboveAlert) {
    const t = r.thresholds!;
    const level = r.levelM! >= t.danger ? "DANGER" : r.levelM! >= t.warning ? "WARNING" : "ALERT";
    console.log(`   ⚠️  ${level}: ${r.name} — ${r.levelM} m (alert ${t.alert}, warning ${t.warning}, danger ${t.danger})`);
  }
}

async function main() {
  try {
    await ingestOnce();
    if (!args.has("--watch")) return;
    console.log(`Watching: next fetch every ${WATCH_MS / 60000} min. Ctrl+C to stop.`);
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => ingestOnce().catch((e) => console.error(`❌ ${e instanceof Error ? e.message : e}`)), WATCH_MS);
      process.once("SIGINT", () => { clearInterval(timer); resolve(); });
    });
  } catch (err) {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}

await main();
