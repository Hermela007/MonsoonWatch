// C: GET /stations/:id/readings?from&to&mode — readings for one station (or GloFAS cell id), oldest first.
// Defaults: mode=live, last 7 days. Replay example: ?mode=replay&from=2014-12-10&to=2015-01-11
import type { FastifyInstance } from "fastify";
import { COLLECTIONS, type Reading } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { toReading, type ReadingDoc } from "../db/readings";
import { HttpError } from "../errors";

const MAX_READINGS = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, "bad_request", `"${name}" is not a valid date: ${value}`);
  return d;
}

export async function stationRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string; mode?: string } }>(
    "/stations/:id/readings",
    async (req): Promise<Reading[]> => {
      const mode = req.query.mode ?? "live";
      if (mode !== "live" && mode !== "replay") throw new HttpError(400, "bad_request", `"mode" must be live or replay`);
      const to = parseDate(req.query.to, "to") ?? (mode === "live" ? new Date() : new Date("2015-01-11T00:00:00+08:00"));
      const from = parseDate(req.query.from, "from") ?? new Date(to.getTime() - (mode === "live" ? 7 : 32) * DAY_MS);
      const docs = await (await getDb())
        .collection<ReadingDoc>(COLLECTIONS.rawReadings)
        .find({ "meta.stationId": req.params.id, "meta.mode": mode, ts: { $gte: from, $lte: to } })
        .sort({ ts: 1 })
        .limit(MAX_READINGS)
        .toArray();
      return docs.map(toReading);
    },
  );
}
