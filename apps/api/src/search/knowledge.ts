// Knowledge search (C7) over `knowledge` (2014 post-mortems, plans, Deep Research briefs):
//   searchKnowledge — hybrid: $rankFusion of autoEmbed $vectorSearch (knowledge_vec, Voyage embeddings made
//     by Atlas automated embedding) + $search (knowledge_text), top FUSED_LIMIT, then MongoDB native
//     reranking ($rerank, Voyage). Rerank runs as a second query on the fused ids, because $rerank can't sit
//     inside $rankFusion and a separate query gives each HUD step its own latency. If $rerank fails the
//     fused order is returned with reranked: false — rerank never fails the search.
//   similarKnowledge — Vector Search on its own: passages similar to one passage.
import type { Document } from "mongodb";
import { COLLECTIONS, type KnowledgeChunk, type SearchHit } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { env } from "../env";
import { snippet } from "./snippet";
import { newSearchRunId, recordSearchSteps, type SearchStep } from "./steps";

/** Candidates fused before rerank. */
export const FUSED_LIMIT = 20;
/** Voyage reranker. rerank-2.5 is multilingual (Malay + English passages) and runs on any cluster tier;
 *  rerank-3 is Preview and needs M10+. */
export const RERANK_MODEL = "rerank-2.5";
const WEIGHTS = { vector: 0.6, text: 0.4 };
/** Rerank is optional: past this the search returns the fused order (a failing $rerank once took 15 s). */
export const RERANK_TIMEOUT_MS = 3000;

export interface SearchKnowledgeOptions {
  limit?: number; // hits returned after rerank (default 5)
  regionId?: string; // default env.regionId
  runId?: string; // HUD run to attach the steps to (default: a new "search-…" run)
  rerankModel?: string; // override for tests (e.g. an invalid model to exercise the fallback)
}

export interface KnowledgeSearchResult {
  hits: SearchHit[]; // kind "knowledge"; rankBeforeRerank = 1-based fused position
  reranked: boolean;
  fused: { count: number; vector: number; text: number; latencyMs: number };
  rerank: { latencyMs: number; model: string; error?: string } | null;
  runId: string;
}

type FusedDoc = Pick<KnowledgeChunk, "_id" | "title" | "sourceUrl" | "chunk"> & {
  fusedScore: number;
  details: { details: { inputPipelineName: string }[] };
};

function fusionPipeline(q: string, regionId: string): Document[] {
  return [
    {
      // VERIFY: $rankFusion + autoEmbed $vectorSearch `query` text — same shape as the working smoke test in
      // scripts/load-knowledge.ts; scoreDetails shape confirmed against Atlas output (details[].inputPipelineName).
      $rankFusion: {
        input: {
          pipelines: {
            vector: [{ $vectorSearch: { index: "knowledge_vec", path: "chunk", query: q, numCandidates: 100, limit: FUSED_LIMIT, filter: { regionId } } }],
            text: [
              {
                $search: {
                  index: "knowledge_text",
                  compound: {
                    filter: [{ equals: { path: "regionId", value: regionId } }],
                    should: [{ text: { query: q, path: ["title", "chunk"], fuzzy: {} } }],
                    minimumShouldMatch: 1,
                  },
                },
              },
              { $limit: FUSED_LIMIT },
            ],
          },
        },
        combination: { weights: WEIGHTS },
        scoreDetails: true,
      },
    },
    { $limit: FUSED_LIMIT },
    { $project: { title: 1, sourceUrl: 1, chunk: 1, fusedScore: { $meta: "score" }, details: { $meta: "scoreDetails" } } },
  ];
}

function rerankPipeline(q: string, ids: string[], model: string): Document[] {
  return [
    { $match: { _id: { $in: ids } } },
    // Keep the fused order going in (docs: $rerank takes documents in pipeline order).
    { $addFields: { _fusedRank: { $indexOfArray: [ids, "$_id"] } } },
    { $sort: { _fusedRank: 1 } },
    // Syntax from docs: vector-search/query/aggregation-stages/rerank (MongoDB 9.0+, Native Reranking
    // project setting). $rerank replaces $meta "score" with the rerank score. title + chunk always exist
    // (load-knowledge rejects rows without them), which $rerank requires.
    { $rerank: { query: { text: q }, path: ["title", "chunk"], numDocsToRerank: ids.length, model } },
    { $project: { _id: 1, rerankScore: { $meta: "score" } } },
  ];
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

export async function searchKnowledge(q: string, opts: SearchKnowledgeOptions = {}): Promise<KnowledgeSearchResult> {
  const limit = opts.limit ?? 5;
  const regionId = opts.regionId ?? env.regionId;
  const runId = opts.runId ?? newSearchRunId();
  const model = opts.rerankModel ?? RERANK_MODEL;
  const coll = (await getDb()).collection<KnowledgeChunk>(COLLECTIONS.knowledge);

  const t0 = performance.now();
  const fusedDocs = await coll.aggregate<FusedDoc>(fusionPipeline(q, regionId)).toArray();
  const fusedMs = Math.round(performance.now() - t0);
  const from = (name: string) => fusedDocs.filter((d) => d.details?.details?.some((x) => x.inputPipelineName === name)).length;
  const fused = { count: fusedDocs.length, vector: from("vector"), text: from("text"), latencyMs: fusedMs };
  const steps: SearchStep[] = [
    {
      key: "hybrid",
      actor: "MongoDB Hybrid Search",
      summary: `Fused ${fused.count} vector + text results ($rankFusion: ${fused.vector} from Vector Search, ${fused.text} from Atlas Search) for "${q}"`,
      status: "ok",
      latencyMs: fusedMs,
    },
  ];

  const toHit = (d: FusedDoc, i: number, score: number): SearchHit => ({
    kind: "knowledge",
    id: d._id,
    title: d.title,
    snippet: snippet(d.chunk, q),
    ...(d.sourceUrl ? { sourceUrl: d.sourceUrl } : {}),
    score: round(score),
    rankBeforeRerank: i + 1,
  });

  let hits: SearchHit[] = fusedDocs.slice(0, limit).map((d, i) => toHit(d, i, d.fusedScore));
  let reranked = false;
  let rerank: KnowledgeSearchResult["rerank"] = null;
  if (fusedDocs.length > 0) {
    const t1 = performance.now();
    try {
      const ids = fusedDocs.map((d) => d._id);
      const order = await coll
        .aggregate<{ _id: string; rerankScore: number }>(rerankPipeline(q, ids, model), { maxTimeMS: RERANK_TIMEOUT_MS })
        .toArray();
      const rank = new Map(ids.map((id, i) => [id, i]));
      hits = order.slice(0, limit).map((r) => {
        const i = rank.get(r._id)!;
        return toHit(fusedDocs[i]!, i, r.rerankScore);
      });
      reranked = true;
      rerank = { latencyMs: Math.round(performance.now() - t1), model };
      steps.push({ key: "rerank", actor: "Voyage rerank", summary: `Reranked ${ids.length} → ${hits.length} (${model}, MongoDB native $rerank)`, status: "ok", latencyMs: rerank.latencyMs });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rerank = { latencyMs: Math.round(performance.now() - t1), model, error: msg };
      console.warn(`search: $rerank failed (${model}), returning fused order: ${msg}`);
      steps.push({ key: "rerank", actor: "Voyage rerank", summary: `Rerank failed — showing fused order (${model})`, status: "fail", latencyMs: rerank.latencyMs });
    }
  }
  await recordSearchSteps(runId, steps);
  return { hits, reranked, fused, rerank, runId };
}

export interface SimilarKnowledgeResult {
  id: string;
  title: string;
  hits: SearchHit[];
  latencyMs: number;
  runId: string;
}

/** Vector Search on its own: passages whose meaning is closest to passage `id`. null if `id` doesn't exist. */
export async function similarKnowledge(id: string, opts: { limit?: number; runId?: string } = {}): Promise<SimilarKnowledgeResult | null> {
  const limit = opts.limit ?? 5;
  const runId = opts.runId ?? newSearchRunId();
  const coll = (await getDb()).collection<KnowledgeChunk>(COLLECTIONS.knowledge);
  const doc = await coll.findOne({ _id: id }, { projection: { title: 1, chunk: 1, regionId: 1 } });
  if (!doc) return null;
  const t0 = performance.now();
  // autoEmbed: the passage text is the query; Atlas embeds it with the index's Voyage model.
  const rows = await coll
    .aggregate<FusedDoc & { vectorScore: number }>([
      { $vectorSearch: { index: "knowledge_vec", path: "chunk", query: doc.chunk, numCandidates: 100, limit: limit + 1, filter: { regionId: doc.regionId } } },
      { $match: { _id: { $ne: id } } },
      { $limit: limit },
      { $project: { title: 1, sourceUrl: 1, chunk: 1, vectorScore: { $meta: "vectorSearchScore" } } },
    ])
    .toArray();
  const latencyMs = Math.round(performance.now() - t0);
  const hits = rows.map((r): SearchHit => ({
    kind: "knowledge",
    id: r._id,
    title: r.title,
    snippet: snippet(r.chunk, doc.title),
    ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}),
    score: round(r.vectorScore),
  }));
  await recordSearchSteps(runId, [
    { key: "similar", actor: "MongoDB Vector Search", summary: `${hits.length} passages similar to "${doc.title}"`, status: "ok", latencyMs },
  ]);
  return { id, title: doc.title, hits, latencyMs, runId };
}
