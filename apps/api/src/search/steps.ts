// Tech HUD lines for search calls. Written to agent_steps; the change stream turns them into `agent.step`.
// A failed HUD write is logged, never thrown: search results matter more than the HUD line.
import { randomUUID } from "node:crypto";
import { COLLECTIONS, type AgentStep } from "@monsoonwatch/shared";
import { getDb } from "../db/client";

export const newSearchRunId = () => `search-${randomUUID().slice(0, 8)}`;

export type SearchStep = Pick<AgentStep, "actor" | "summary" | "status" | "latencyMs"> & { key: string };

export async function recordSearchSteps(runId: string, steps: SearchStep[]): Promise<void> {
  const ts = new Date().toISOString();
  const docs: AgentStep[] = steps.map(({ key, ...s }) => ({ _id: `${runId}-${key}`, runId, ts, kind: "db", ...s }));
  try {
    await (await getDb()).collection<AgentStep>(COLLECTIONS.agentSteps).insertMany(docs, { ordered: true });
  } catch (err) {
    console.warn(`search: could not write HUD steps for ${runId}: ${err instanceof Error ? err.message : err}`);
  }
}
