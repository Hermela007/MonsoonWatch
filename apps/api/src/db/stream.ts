// `pnpm db:stream` — idempotent: applies the Atlas Stream Processing processors defined in
// ./stream-processors/*.js to the workspace in STREAM_PROCESSING_URI.
//   missing          → create + start
//   definition same  → leave it alone (start it if it isn't running)
//   definition changed → stop, drop, recreate, start
// Then prints state and stats. `pnpm db:stream --stop` stops them all (they bill per hour while running).
//
// Uses the database commands behind mongosh's sp.* helpers (createStreamProcessor, startStreamProcessor,
// stopStreamProcessor, dropStreamProcessor, listStreamProcessors, getStreamProcessorStats), run on
// `admin` exactly as mongosh does. The DB user (from MONGODB_URI) needs the atlasAdmin role.
import { createHash } from "node:crypto";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BSON, MongoClient, type Document } from "mongodb";
import { env } from "../env";

const { EJSON } = BSON;

interface ProcessorDef { name: string; pipeline: Document[]; options?: Document }
interface Listed { name: string; state: string; pipeline?: Document[]; errorMsg?: string; error_msg?: string }

const stopAll = process.argv.includes("--stop");

/** Order-independent JSON for comparing definitions. */
function canonical(value: unknown): string {
  return JSON.stringify(EJSON.serialize(value), (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
  );
}
const hash = (pipeline: Document[]) => createHash("sha256").update(canonical(pipeline)).digest("hex").slice(0, 12);

async function loadDefs(): Promise<ProcessorDef[]> {
  const dir = fileURLToPath(new URL("./stream-processors/", import.meta.url));
  const defs: ProcessorDef[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
    const mod = (await import(pathToFileURL(dir + file).href)) as { default: ProcessorDef[]; SUMMARY?: string[] };
    defs.push(...mod.default);
    for (const line of mod.SUMMARY ?? []) console.log(line);
  }
  return defs;
}

function connect(): MongoClient {
  if (!env.streamProcessingUri) throw new Error("STREAM_PROCESSING_URI is not set (see .env.example).");
  // The workspace URI has no credentials: reuse the MONGODB_URI user. Never logged.
  const creds = new URL(env.mongodbUri.replace(/^mongodb(\+srv)?:/, "http:"));
  if (!creds.username) throw new Error("MONGODB_URI has no username to reuse for Stream Processing.");
  return new MongoClient(env.streamProcessingUri, {
    auth: { username: decodeURIComponent(creds.username), password: decodeURIComponent(creds.password) },
    authSource: "admin",
    tls: true,
    serverSelectionTimeoutMS: 15_000,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const client = connect();
try {
  await client.connect();
  const admin = client.db("admin");
  const run = (cmd: Document) => admin.command(cmd);
  const list = async () => ((await run({ listStreamProcessors: 1, filter: {} })).streamProcessors ?? []) as Listed[];

  const defs = await loadDefs();
  const before = new Map((await list()).map((p) => [p.name, p]));

  for (const def of defs) {
    const current = before.get(def.name);
    if (stopAll) {
      if (current?.state === "STARTED") { await run({ stopStreamProcessor: def.name }); console.log(`■ ${def.name}: stopped`); }
      else console.log(`· ${def.name}: ${current?.state ?? "not created"}`);
      continue;
    }
    const want = hash(def.pipeline);
    const have = current?.pipeline ? hash(current.pipeline) : null;
    if (current && have === want) {
      if (current.state !== "STARTED") { await run({ startStreamProcessor: def.name }); console.log(`▶ ${def.name}: unchanged (${want}), was ${current.state} → started`); }
      else console.log(`✓ ${def.name}: unchanged (${want}), already STARTED — left alone`);
      continue;
    }
    if (current) {
      if (current.state === "STARTED") await run({ stopStreamProcessor: def.name });
      await run({ dropStreamProcessor: def.name });
      console.log(`↻ ${def.name}: definition changed (${have} → ${want}) — dropped`);
    }
    await run({ createStreamProcessor: def.name, pipeline: def.pipeline, ...(def.options ? { options: def.options } : {}) });
    await run({ startStreamProcessor: def.name });
    console.log(`+ ${def.name}: created (${want}) and started`);
  }

  // Wait for every processor to settle (PROVISIONING can take a few minutes), then report.
  const names = new Set(defs.map((d) => d.name));
  const deadline = Date.now() + 5 * 60_000;
  let listed = (await list()).filter((p) => names.has(p.name));
  while (!stopAll && listed.some((p) => p.state !== "STARTED" && p.state !== "FAILED") && Date.now() < deadline) {
    await sleep(5_000);
    listed = (await list()).filter((p) => names.has(p.name));
  }
  console.log("\nProcessors:");
  for (const p of listed) {
    const line = `  ${p.name}: ${p.state}${p.errorMsg || p.error_msg ? ` — ${p.errorMsg ?? p.error_msg}` : ""}`;
    console.log(line);
    if (p.state === "FAILED") process.exitCode = 1;
    if (p.state !== "STARTED") continue;
    try {
      const { stats } = await run({ getStreamProcessorStats: p.name });
      const pick = ["status", "inputMessageCount", "outputMessageCount", "dlqMessageCount", "stateSize", "watermark"];
      console.log(`    stats: ${pick.filter((k) => k in stats).map((k) => `${k}=${EJSON.stringify(stats[k], { relaxed: true })}`).join(" ")}`);
    } catch (err) {
      console.log(`    stats unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
} catch (err) {
  const e = err as Error & { codeName?: string; code?: number };
  console.error(`❌ ${e.codeName ?? e.name}${e.code ? ` (${e.code})` : ""}: ${e.message}`);
  if (e.code === 13 || /not authorized|unauthorized/i.test(e.message)) {
    console.error("   The MONGODB_URI user needs the atlasAdmin role for Stream Processing (Atlas → Database Access → Edit user → Built-in role: Atlas admin).");
  }
  process.exitCode = 1;
} finally {
  await client.close();
}
