// `pnpm seed` entry point. Loads stations, villages, evac centres and the Dec 2014 replay.
// Workstream C adds the real steps here: ingest-jps.ts, load-replay-2014.ts, load-osm.ts, build-terrain.ts.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

console.log("pnpm seed: no seed steps yet.");
