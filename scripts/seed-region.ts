// `pnpm seed:region` — upserts every region config in scripts/data/regions/*.json into `regions`.
// Region switch = another JSON file here. Terrain fields are filled in by build-terrain.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLLECTIONS, type Region } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";

const dir = fileURLToPath(new URL("./data/regions/", import.meta.url));
try {
  const db = await getDb();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const region = JSON.parse(readFileSync(dir + file, "utf8")) as Region;
    const { _id, ...rest } = region;
    await db.collection<Region>(COLLECTIONS.regions).updateOne({ _id }, { $set: rest }, { upsert: true });
    console.log(`✅ region ${_id} (${region.name})`);
  }
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
