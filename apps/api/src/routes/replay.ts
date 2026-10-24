// C3: replay of the reconstructed Dec 2014 flood (engine: ../replay/engine.ts).
//   POST /replay/start { regionId, secondsPerDay? = 30, from? = Region.replay.start } → 202 ReplayStatus
//   POST /replay/stop  → 202 ReplayStatus
//   GET  /replay/status → ReplayStatus { running, replayId?, ts?, secondsPerDay?, ... }
// The replay clock arrives on GET /api/stream as `replay.tick { ts }`.
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HttpError } from "../errors";
import { ReplayError, start, status, stop, type ReplayStatus } from "../replay/engine";

const StartBody = z.object({
  regionId: z.string().min(1),
  secondsPerDay: z.number().min(1).max(600).default(30),
  from: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date").optional(),
});

export async function replayRoutes(app: FastifyInstance) {
  app.post("/replay/start", async (req, reply): Promise<ReplayStatus> => {
    const parsed = StartBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, "bad_request", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    try {
      const result = await start(parsed.data, req.log);
      reply.status(202);
      return result;
    } catch (err) {
      if (err instanceof ReplayError) {
        throw new HttpError(err.kind === "not_found" ? 404 : err.kind === "conflict" ? 409 : 400, err.kind, err.message);
      }
      throw err;
    }
  });

  app.post("/replay/stop", async (_req, reply): Promise<ReplayStatus> => {
    reply.status(202);
    return stop();
  });

  app.get("/replay/status", async (): Promise<ReplayStatus> => status());
}
