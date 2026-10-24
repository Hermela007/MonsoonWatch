// `pnpm load:knowledge` — loads sourced passages from scripts/data/knowledge/*.csv into `knowledge`.
// CSV columns: title | sourceUrl | kind (postmortem|plan|deep_research|other) | language (en|ms) | chunk
// Atlas automated embedding (knowledge_vec, Voyage) embeds `chunk` on insert — no embedding code here.
// Safe to re-run: upserts by a stable id and removes CSV rows that were deleted from the files.
//   pnpm load:knowledge           load + show index status + smoke-test search
//   pnpm load:knowledge --check   only show index status + smoke-test search
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Document } from "mongodb";
import { COLLECTIONS, type KnowledgeChunk } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";
import { parseCsvObjects } from "./lib/csv";

const dir = fileURLToPath(new URL("./data/knowledge/", import.meta.url));
const KINDS = new Set(["postmortem", "plan", "deep_research", "other"]);
const checkOnly = process.argv.includes("--check");
type Doc = KnowledgeChunk & { language: string; origin: string };

function loadRows(): Doc[] {
  const docs: Doc[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".csv")).sort()) {
    parseCsvObjects(readFileSync(dir + file, "utf8")).forEach((r, i) => {
      const where = `${file} row ${i + 2}`;
      for (const col of ["title", "sourceUrl", "kind", "chunk"]) if (!r[col]) throw new Error(`${where}: missing ${col}`);
      if (!KINDS.has(r.kind!)) throw new Error(`${where}: kind "${r.kind}" must be one of ${[...KINDS].join(", ")}`);
      if (!/^https?:\/\//.test(r.sourceUrl!)) throw new Error(`${where}: sourceUrl must be a link`);
      docs.push({
        _id: `kb-${createHash("sha1").update(`${r.title}|${r.sourceUrl}`).digest("hex").slice(0, 12)}`,
        regionId: env.regionId,
        kind: r.kind as KnowledgeChunk["kind"],
        title: r.title!,
        sourceUrl: r.sourceUrl!,
        chunk: r.chunk!,
        language: r.language || "en",
        origin: `csv:${file}`,
      });
    });
  }
  return docs;
}

async function smokeTest(coll: ReturnType<Awaited<ReturnType<typeof getDb>>["collection"]>) {
  const indexes = (await coll.listSearchIndexes().toArray()) as { name: string; status?: string; queryable?: boolean }[];
  for (const ix of indexes) console.log(`   index ${ix.name}: ${ix.status ?? "?"}${ix.queryable ? " (queryable)" : " (not queryable yet)"}`);
  const run = async (label: string, pipeline: Document[]) => {
    try {
      const hits = await coll.aggregate(pipeline).toArray();
      console.log(`   ${label}: ${hits.length ? hits.map((h) => `"${h.title}"`).join(" | ") : "(no hits)"}`);
    } catch (err) {
      console.log(`   ${label}: ✗ ${err instanceof Error ? err.message : err}`);
    }
  };
  const q = "Where did villagers shelter when the river overflowed?";
  // VERIFY: autoEmbed $vectorSearch takes `query` text (docs: vector-search/crud-embeddings/automated-embedding)
  const vector = [{ $vectorSearch: { index: "knowledge_vec", path: "chunk", query: q, numCandidates: 50, limit: 3, filter: { regionId: env.regionId } } }];
  const text = [{ $search: { index: "knowledge_text", text: { query: "Kuala Krai hospital generator", path: ["title", "chunk"], fuzzy: {} } } }, { $limit: 3 }];
  await run("Atlas Search  'Kuala Krai hospital generator'", [...text, { $project: { title: 1 } }]);
  await run(`Vector Search '${q}'`, [...vector, { $project: { title: 1 } }]);
  await run("Vector Search (Malay) 'Di mana penduduk berlindung semasa banjir?'", [
    { $vectorSearch: { index: "knowledge_vec", path: "chunk", query: "Di mana penduduk berlindung semasa banjir?", numCandidates: 50, limit: 3 } },
    { $project: { title: 1 } },
  ]);
  // VERIFY: $rankFusion shape (docs: vector-search/hybrid-search)
  await run("Hybrid ($rankFusion) 'jalan ditutup Kuala Krai'", [
    {
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: { index: "knowledge_vec", path: "chunk", query: "jalan ditutup Kuala Krai", numCandidates: 50, limit: 10 } }],
            text: [{ $search: { index: "knowledge_text", text: { query: "jalan ditutup Kuala Krai", path: ["title", "chunk"], fuzzy: {} } } }, { $limit: 10 }],
          },
        },
        combination: { weights: { vector: 0.6, text: 0.4 } },
      },
    },
    { $limit: 3 },
    { $project: { title: 1 } },
  ]);
}

try {
  const db = await getDb();
  const coll = db.collection<Doc>(COLLECTIONS.knowledge);
  if (!checkOnly) {
    const docs = loadRows();
    const ids = docs.map((d) => d._id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate title+sourceUrl in the CSV files");
    await coll.bulkWrite(docs.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })), { ordered: false });
    const removed = await coll.deleteMany({ regionId: env.regionId, origin: { $regex: /^csv:/ }, _id: { $nin: ids } });
    const byLang = docs.reduce<Record<string, number>>((a, d) => ((a[d.language] = (a[d.language] ?? 0) + 1), a), {});
    console.log(`✅ ${docs.length} knowledge passages loaded (${Object.entries(byLang).map(([k, n]) => `${n} ${k}`).join(", ")}); ${removed.deletedCount} removed`);
    console.log("   Automated embedding runs in Atlas after insert — vector results can take a minute to appear.");
  }
  await smokeTest(coll as never);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
