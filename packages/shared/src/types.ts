// Shared contract — DRAFT copied from docs/IMPLEMENTATION.md §1.2.
// Agree changes with all three workstreams first, and update fixtures in the same change.
// Units: metres, mm, m³/s, ISO timestamps (UTC), GeoJSON [lon, lat].
// TODO (after contracts are agreed): add zod schemas and derive these types from them.

export type LngLat = [number, number];

export interface Region {
  _id: string; // "kelantan"
  name: string;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  languages: string[]; // ["ms", "en"]
  timezone: string; // "Asia/Kuala_Lumpur"
  terrain: { heightmapUrl: string; widthPx: number; heightPx: number; metresPerPx: number; minElev: number; maxElev: number };
  glofasCells: { id: string; lngLat: LngLat; label: string }[];
  replay?: { label: string; start: string; end: string }; // "Dec 2014"
}

export type StationKind = "river" | "rain";
export interface Station {
  _id: string; // JPS station id (or generated if blank)
  regionId: string;
  kind: StationKind;
  name: string;
  district: string;
  basin?: string;
  location: { type: "Point"; coordinates: LngLat };
  thresholds?: { normal: number; alert: number; warning: number; danger: number }; // river only, metres
}

export interface Reading {
  ts: string;
  meta: { stationId: string; kind: StationKind | "glofas"; source: "jps" | "glofas" | "openmeteo"; mode: "live" | "replay" };
  value: number; // m (river), mm (rain), m³/s (glofas)
  rain6d?: number[]; // rain stations: last 6 daily totals
}

export type RiskLevel = "normal" | "alert" | "warning" | "danger";
export interface RiskEvent {
  _id: string;
  regionId: string;
  ts: string;
  type: "river_threshold" | "rain_accumulation" | "landslide_screen" | "report_disagreement";
  stationId?: string;
  level: RiskLevel;
  value: number;
  threshold: number;
  message: string; // human-readable, shown in HUD
  source: "stream_processing" | "agent" | "report";
}

export interface Village {
  _id: string;
  regionId: string;
  name: string;
  altNames: string[];
  location: { type: "Point"; coordinates: LngLat };
  population: number;
  district: string;
}

export interface EvacCentre {
  _id: string;
  regionId: string;
  name: string;
  location: { type: "Point"; coordinates: LngLat };
  capacity: number;
  headcount: number;
  elevationM: number;
}

export interface Report {
  _id: string;
  regionId: string;
  ts: string;
  location: { type: "Point"; coordinates: LngLat };
  mediaUrl?: string;
  mediaType?: "image" | "video";
  text?: string;
  analysis?: { estDepthM: number; uncertaintyM: number; referenceObject: string; notes: string; model: string };
  // embeddings are added by Atlas automated embedding / Voyage — never sent to the client
}

export type CheckName = "threshold" | "route" | "capacity" | "freshness" | "language";
export interface VerificationResult {
  check: CheckName;
  passed: boolean;
  detail: string;
}

export interface Alert {
  _id: string;
  regionId: string;
  runId: string;
  villageId: string;
  level: RiskLevel;
  hazard: "flood" | "landslide";
  etaHours?: number;
  evacCentreId: string;
  route: { type: "LineString"; coordinates: LngLat[] };
  messages: { lang: string; text: string }[];
  verification: VerificationResult[];
  status: "draft" | "verified" | "approved" | "rejected" | "sent";
  approvedBy?: string;
  approvedAt?: string;
}

export interface AgentStep {
  // one line in the Tech HUD
  _id: string;
  runId: string;
  ts: string;
  actor: string; // "Gemini 4 Argon" | "Gemini 3.8 Flash" | "MongoDB Stream Processing" | "Voyage rerank" | "Verification" | "Saint" ...
  kind: "plan" | "subagent" | "tool" | "verify" | "replan" | "db" | "saint" | "info";
  summary: string; // one line, shown in HUD
  status: "running" | "ok" | "fail";
  latencyMs?: number;
  tokens?: number;
}

export interface SaintTask {
  _id: string;
  alertId: string;
  ts: string;
  type: "send_alert" | "chase_reply" | "log_checkin" | "supply_order" | "sitrep";
  status: "queued" | "in_progress" | "awaiting_approval" | "done" | "failed";
  detail: string;
}

export interface Hazards {
  // what the 3D scene draws for a given time
  regionId: string;
  ts: string;
  mode: "live" | "replay";
  water: { likelyLevelM: number; worstLevelM: number; byCell?: { id: string; levelM: number }[] };
  landslide: { cells: { lngLat: LngLat; risk: number }[]; runouts: { type: "LineString"; coordinates: LngLat[]; risk: number }[] };
  blockedRoads: { type: "MultiLineString"; coordinates: LngLat[][] };
}
