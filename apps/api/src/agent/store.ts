// Persistence for agent runs, alerts and the Saint handoff — MongoDB in real mode
// (MOCK≠1 and MONGODB_URI set), memory otherwise. Writes to `alerts` / `area_warnings` / `saint_tasks` /
// `agent_runs` are relayed to the UI by C's change streams (alert.updated, area_warning.updated,
// saint.task) — the one push path.

import { COLLECTIONS, type AgentRun, type AgentStep, type Alert, type AreaWarning, type SaintTask } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { env } from "../env";
import { getMemorySteps } from "./steps";

export interface AgentStore {
  saveRun(run: AgentRun): Promise<void>;
  getRun(id: string): Promise<AgentRun | null>;
  saveAlert(alert: Alert): Promise<void>;
  getAlert(id: string): Promise<Alert | null>;
  alertsForRun(runId: string): Promise<Alert[]>;
  saveAreaWarning(w: AreaWarning): Promise<void>;
  getAreaWarning(id: string): Promise<AreaWarning | null>;
  areaWarningsForRun(runId: string): Promise<AreaWarning[]>;
  stepsForRun(runId: string): Promise<AgentStep[]>;
  saveSaintTask(task: SaintTask): Promise<void>;
}

export function memoryStore(): AgentStore & { saintTasks: SaintTask[] } {
  const runs = new Map<string, AgentRun>();
  const alerts = new Map<string, Alert>();
  const areaWarnings = new Map<string, AreaWarning>();
  const saintTasks: SaintTask[] = [];
  return {
    saintTasks,
    async saveRun(r) { runs.set(r._id, structuredClone(r)); },
    async getRun(id) { return runs.get(id) ?? null; },
    async saveAlert(a) { alerts.set(a._id, structuredClone(a)); },
    async getAlert(id) { return alerts.get(id) ?? null; },
    async alertsForRun(runId) { return [...alerts.values()].filter((a) => a.runId === runId); },
    async saveAreaWarning(w) { areaWarnings.set(w._id, structuredClone(w)); },
    async getAreaWarning(id) { return areaWarnings.get(id) ?? null; },
    async areaWarningsForRun(runId) { return [...areaWarnings.values()].filter((w) => w.runId === runId); },
    async stepsForRun(runId) { return getMemorySteps(runId); },
    async saveSaintTask(t) { saintTasks.push(structuredClone(t)); },
  };
}

export const mongoStore: AgentStore = {
  async saveRun(r) {
    await (await getDb()).collection<AgentRun>(COLLECTIONS.agentRuns).replaceOne({ _id: r._id }, r, { upsert: true });
  },
  async getRun(id) {
    return (await getDb()).collection<AgentRun>(COLLECTIONS.agentRuns).findOne({ _id: id });
  },
  async saveAlert(a) {
    await (await getDb()).collection<Alert>(COLLECTIONS.alerts).replaceOne({ _id: a._id }, a, { upsert: true });
  },
  async getAlert(id) {
    return (await getDb()).collection<Alert>(COLLECTIONS.alerts).findOne({ _id: id });
  },
  async alertsForRun(runId) {
    return (await getDb()).collection<Alert>(COLLECTIONS.alerts).find({ runId }).toArray();
  },
  async saveAreaWarning(w) {
    await (await getDb()).collection<AreaWarning>(COLLECTIONS.areaWarnings).replaceOne({ _id: w._id }, w, { upsert: true });
  },
  async getAreaWarning(id) {
    return (await getDb()).collection<AreaWarning>(COLLECTIONS.areaWarnings).findOne({ _id: id });
  },
  async areaWarningsForRun(runId) {
    return (await getDb()).collection<AreaWarning>(COLLECTIONS.areaWarnings).find({ runId }).toArray();
  },
  async stepsForRun(runId) {
    return (await getDb()).collection<AgentStep>(COLLECTIONS.agentSteps).find({ runId }).sort({ ts: 1 }).toArray();
  },
  async saveSaintTask(t) {
    await (await getDb()).collection<SaintTask>(COLLECTIONS.saintTasks).insertOne(t);
  },
};

const sharedMemory = memoryStore();

/** The store the API uses: MongoDB in real mode, memory in mock mode. */
export function defaultStore(): AgentStore {
  return !env.mock && env.mongodbUri ? mongoStore : sharedMemory;
}
