// C7: GET /search?q=&type=place|hybrid[&limit=] → SearchResponse (default type: place).
//     GET /knowledge/:id/similar[?limit=] → passages similar to one passage (Vector Search alone).
// Logic lives in ../search (also called in-process by B's agent).
import type { FastifyInstance } from "fastify";
import type { SearchHit, SearchResponse } from "@monsoonwatch/shared";
import { HttpError } from "../errors";
import { searchKnowledge, searchPlaces, similarKnowledge } from "../search";

const MIN_Q = 2;
const MAX_Q = 200;

function parseLimit(raw: string | undefined, def: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new HttpError(400, "bad_request", `limit must be an integer 1–20, got "${raw}"`);
  return n;
}

export async function searchRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; type?: string; limit?: string } }>("/search", async (req): Promise<SearchResponse> => {
    const q = (req.query.q ?? "").trim();
    if (q.length < MIN_Q) throw new HttpError(400, "bad_request", `q must be at least ${MIN_Q} characters`);
    if (q.length > MAX_Q) throw new HttpError(400, "bad_request", `q must be at most ${MAX_Q} characters`);
    const type = req.query.type ?? "place";
    if (type === "place") {
      const { hits } = await searchPlaces(q, { limit: parseLimit(req.query.limit, 8) });
      return { query: q, type, reranked: false, hits };
    }
    if (type === "hybrid") {
      const { hits, reranked } = await searchKnowledge(q, { limit: parseLimit(req.query.limit, 5) });
      return { query: q, type, reranked, hits };
    }
    throw new HttpError(400, "bad_request", `type must be "place" or "hybrid", got "${type}"`);
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/knowledge/:id/similar",
    async (req): Promise<{ id: string; title: string; hits: SearchHit[] }> => {
      const res = await similarKnowledge(req.params.id, { limit: parseLimit(req.query.limit, 5) });
      if (!res) throw new HttpError(404, "not_found", `Knowledge passage ${req.params.id} not found`);
      return { id: res.id, title: res.title, hits: res.hits };
    },
  );
}
