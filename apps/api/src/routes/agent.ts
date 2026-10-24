// B: POST /agent/run → { runId } (work continues in the background)
//    GET  /agent/runs/:id → AgentRunDetail { run, steps (oldest first), alerts }
// Data source: the labelled TEST scenario when MOCK=1 or body.source = "sample"; otherwise MongoDB
// (body.mode "live" | "replay", body.at = replay clock ISO time). Runs also start automatically
// from Stream Processing risk events (agent/auto-trigger.ts).

import type { FastifyInstance } from "fastify";
import type { AgentRunDetail, AgentRunStarted } from "@monsoonwatch/shared";
import { startAutoTrigger } from "../agent/auto-trigger";
import { startAgentRun } from "../agent/orchestrator";
import { makeSampleSituation } from "../agent/sample/kelantan-test";
import { loadSituationFromDb } from "../agent/situation-db";
import { defaultStore } from "../agent/store";
import { env } from "../env";
import { HttpError } from "../errors";

interface RunBody { regionId?: string; riskEventId?: string; source?: "sample" | "db"; mode?: "live" | "replay"; at?: string }

export async function agentRoutes(app: FastifyInstance) {
  // Real mode: start runs automatically from Stream Processing risk events (AGENT_AUTO_RUN=0 to disable).
  if (!env.mock && !env.publicDemo) startAutoTrigger();

  app.post<{ Body: RunBody }>("/agent/run", async (req, reply): Promise<AgentRunStarted> => {
    const regionId = req.body?.regionId ?? env.regionId;
    const useSample = env.mock || req.body?.source === "sample";
    let situation;
    try {
      const at = req.body?.at ? new Date(req.body.at) : undefined;
      situation = useSample ? makeSampleSituation() : await loadSituationFromDb(regionId, { mode: req.body?.mode ?? "live", at });
    } catch (err) {
      throw new HttpError(404, "not_found", (err as Error).message);
    }
    const trigger = req.body?.riskEventId
      ? { type: "risk_event" as const, riskEventId: req.body.riskEventId }
      : { type: "manual" as const };
    const runId = startAgentRun({ situation, trigger });
    reply.status(202);
    return { runId };
  });

  app.get<{ Params: { id: string } }>("/agent/runs/:id", async (req): Promise<AgentRunDetail> => {
    const store = defaultStore();
    const run = await store.getRun(req.params.id);
    if (!run) throw new HttpError(404, "not_found", `Agent run "${req.params.id}" not found`);
    const [steps, alerts] = await Promise.all([store.stepsForRun(run._id), store.alertsForRun(run._id)]);
    return { run, steps, alerts };
  });
}
