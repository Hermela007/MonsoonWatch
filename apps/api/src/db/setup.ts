// `pnpm db:setup` — idempotent: creates collections, normal indexes and Atlas Search /
// Vector Search indexes (definitions in ./indexes/*.json). Safe to run any number of times.
//   pnpm db:setup            create anything missing
//   pnpm db:setup --update   also push changed search index definitions
//
// Note: raw_readings is a time series collection, so `ts` is stored as a BSON Date.
// reading_events gets the same docs (new readings only, 7-day TTL) because time series collections
// can't be watched by change streams or Stream Processing.
// The API converts it to an ISO string when returning a Reading.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db, IndexSpecification, CreateIndexesOptions } from "mongodb";
import { COLLECTIONS } from "@monsoonwatch/shared";
import { closeDb, getDb } from "./client";

const update = process.argv.includes("--update");

// `reports` is intentionally absent: dropped with photo/video uploads (IMPLEMENTATION.md §1.7).
const NORMAL_COLLECTIONS = [
  COLLECTIONS.regions,
  COLLECTIONS.stations,
  COLLECTIONS.readingEvents,
  COLLECTIONS.riskEvents,
  COLLECTIONS.villages,
  COLLECTIONS.evacCentres,
  COLLECTIONS.geo,
  COLLECTIONS.knowledge,
  COLLECTIONS.alerts,
  COLLECTIONS.agentRuns,
  COLLECTIONS.agentSteps,
  COLLECTIONS.saintTasks,
];

const INDEXES: [string, IndexSpecification, CreateIndexesOptions?][] = [
  [COLLECTIONS.stations, { location: "2dsphere" }],
  [COLLECTIONS.stations, { regionId: 1, kind: 1 }],
  [COLLECTIONS.villages, { location: "2dsphere" }],
  [COLLECTIONS.villages, { regionId: 1 }],
  [COLLECTIONS.evacCentres, { location: "2dsphere" }],
  [COLLECTIONS.evacCentres, { regionId: 1 }],
  [COLLECTIONS.rawReadings, { "meta.stationId": 1, ts: -1 }],
  // reading_events: the live copy of new readings. raw_readings is time series, which supports neither
  // change streams nor being a Stream Processing source, so those watch this collection instead.
  [COLLECTIONS.readingEvents, { ts: 1 }, { expireAfterSeconds: 7 * 24 * 3600 }],
  [COLLECTIONS.readingEvents, { "meta.stationId": 1, ts: -1 }],
  [COLLECTIONS.riskEvents, { regionId: 1, ts: -1 }],
  [COLLECTIONS.alerts, { runId: 1 }],
  [COLLECTIONS.alerts, { regionId: 1, status: 1 }],
  [COLLECTIONS.agentRuns, { regionId: 1, startedAt: -1 }],
  [COLLECTIONS.agentSteps, { runId: 1, ts: 1 }],
  [COLLECTIONS.saintTasks, { alertId: 1 }],
  [COLLECTIONS.geo, { regionId: 1, layer: 1 }],
  [COLLECTIONS.geo, { geometry: "2dsphere" }], // route check: $geoIntersects on road segments
];

interface SearchIndexFile {
  collection: string;
  name: string;
  type: "search" | "vectorSearch";
  definition: Record<string, unknown>;
}

async function ensureCollections(db: Db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));

  if (!existing.has(COLLECTIONS.rawReadings)) {
    await db.createCollection(COLLECTIONS.rawReadings, {
      timeseries: { timeField: "ts", metaField: "meta", granularity: "minutes" },
    });
    console.log(`  + ${COLLECTIONS.rawReadings} (time series)`);
  }
  for (const name of NORMAL_COLLECTIONS) {
    if (existing.has(name)) continue;
    await db.createCollection(name);
    console.log(`  + ${name}`);
  }
}

async function ensureIndexes(db: Db) {
  for (const [collection, spec, options] of INDEXES) {
    const name = await db.collection(collection).createIndex(spec, options); // no-op if it exists
    console.log(`  ✓ ${collection}.${name}${options?.expireAfterSeconds !== undefined ? ` (TTL ${options.expireAfterSeconds} s)` : ""}`);
  }
}

async function ensureSearchIndexes(db: Db) {
  const dir = fileURLToPath(new URL("./indexes/", import.meta.url));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const spec = JSON.parse(readFileSync(dir + file, "utf8")) as SearchIndexFile;
    const coll = db.collection(spec.collection);
    const [current] = (await coll.listSearchIndexes(spec.name).toArray()) as { name: string; status?: string }[];
    try {
      if (!current) {
        await coll.createSearchIndex({ name: spec.name, type: spec.type, definition: spec.definition });
        console.log(`  + ${spec.collection}.${spec.name} (${spec.type}) — building in Atlas`);
      } else if (update) {
        await coll.updateSearchIndex(spec.name, spec.definition);
        console.log(`  ↻ ${spec.collection}.${spec.name} (${spec.type}) — updated`);
      } else {
        console.log(`  ✓ ${spec.collection}.${spec.name} (${spec.type}) — ${current.status ?? "exists"}`);
      }
    } catch (err) {
      console.error(`  ✗ ${spec.collection}.${spec.name} (${file}): ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
}

try {
  const db = await getDb();
  console.log(`Setting up database "${db.databaseName}"`);
  console.log("Collections:");
  await ensureCollections(db);
  console.log("Indexes:");
  await ensureIndexes(db);
  console.log("Search indexes (Atlas Search / Vector Search):");
  await ensureSearchIndexes(db);
  console.log(process.exitCode ? "Done, with errors above." : "✅ Done.");
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
