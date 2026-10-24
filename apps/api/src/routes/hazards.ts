// C6: GET /regions/:id/hazards?ts=<ISO>&mode=live|replay — shared `Hazards` (+ approximate, notes,
// gauges, worst). Defaults: ts = now, mode = live. A date-only ts ("2014-12-24") means the END of that
// day in Malaysia time (UTC+8), matching replay.tick timestamps (end-of-day MYT).
import type { FastifyInstance } from "fastify";
import { HttpError } from "../errors";
import { getHazards, RegionNotFoundError, type HazardsResult } from "../hazards";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseHazardsTs(raw: string | undefined): Date {
  if (!raw) return new Date();
  const ts = new Date(DATE_ONLY.test(raw) ? `${raw}T23:59:59+08:00` : raw);
  if (Number.isNaN(ts.getTime())) throw new HttpError(400, "bad_request", `ts must be an ISO date or date-time, got "${raw}"`);
  return ts;
}

export async function hazardsRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { ts?: string; mode?: string } }>("/regions/:id/hazards", async (req): Promise<HazardsResult> => {
    const mode = req.query.mode ?? "live";
    if (mode !== "live" && mode !== "replay") throw new HttpError(400, "bad_request", `mode must be "live" or "replay", got "${mode}"`);
    const ts = parseHazardsTs(req.query.ts);
    try {
      return await getHazards(req.params.id, ts, mode);
    } catch (err) {
      if (err instanceof RegionNotFoundError) throw new HttpError(404, "not_found", err.message);
      throw err;
    }
  });
}
