// Live events sent on GET /api/stream (Server-Sent Events) — docs/IMPLEMENTATION.md §1.4.
// One push path: everything is written to MongoDB and relayed from change streams.
import type { AgentStep, Alert, AreaWarning, EvacCentre, Hazards, Reading, Report, RiskEvent, SaintTask } from "./types";

export interface StreamEvents {
  "reading.new": { reading: Reading };
  "risk.event": { riskEvent: RiskEvent };
  "hazards.update": { hazards: Hazards };
  "agent.step": { step: AgentStep };
  "alert.updated": { alert: Alert };
  "area_warning.updated": { areaWarning: AreaWarning };
  "report.new": { report: Report };
  "evac.updated": { evacCentre: EvacCentre };
  "saint.task": { task: SaintTask };
  "replay.tick": { ts: string };
}

export type StreamEventName = keyof StreamEvents;

export const STREAM_EVENT_NAMES = [
  "reading.new",
  "risk.event",
  "hazards.update",
  "agent.step",
  "alert.updated",
  "area_warning.updated",
  "report.new",
  "evac.updated",
  "saint.task",
  "replay.tick",
] as const satisfies readonly StreamEventName[];

// Compile-time check that STREAM_EVENT_NAMES lists every event.
type MissingEventNames = Exclude<StreamEventName, (typeof STREAM_EVENT_NAMES)[number]>;
const allEventNamesListed: [MissingEventNames] extends [never] ? true : false = true;
void allEventNamesListed;
