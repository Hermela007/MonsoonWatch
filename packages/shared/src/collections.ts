// MongoDB collection names — import these instead of typing strings (§1.6 decision 1).
export const COLLECTIONS = {
  regions: "regions",
  stations: "stations",
  rawReadings: "raw_readings", // time series
  readingEvents: "reading_events", // live feed: new readings, 7-day TTL — change streams watch this (time series can't be watched)
  riskEvents: "risk_events",
  villages: "villages",
  evacCentres: "evac_centres",
  geo: "geo",
  reports: "reports",
  knowledge: "knowledge",
  alerts: "alerts",
  agentRuns: "agent_runs", // one doc per run (AgentRun)
  agentSteps: "agent_steps", // one doc per HUD line (AgentStep) — change stream → `agent.step`
  saintTasks: "saint_tasks",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
