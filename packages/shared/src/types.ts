// Shared contract — docs/IMPLEMENTATION.md §1.2, plus the decisions in §1.6.
// This file is the source of truth. Agree changes with all three workstreams first,
// and update fixtures in the same change.
// Units: metres, mm, m³/s, ISO timestamps (UTC), GeoJSON [lon, lat].
// TODO (after contracts are agreed): add zod schemas and derive these types from them.

export type LngLat = [number, number];

// Minimal GeoJSON (no extra dependency). Always [lon, lat].
export interface PointGeom { type: "Point"; coordinates: LngLat }
export interface LineStringGeom { type: "LineString"; coordinates: LngLat[] }
export interface PolygonGeom { type: "Polygon"; coordinates: LngLat[][] }
export interface Feature<G, P> { type: "Feature"; id: string; geometry: G; properties: P }
export interface FeatureCollection<G, P> { type: "FeatureCollection"; features: Feature<G, P>[] }

export interface Region {
  _id: string; // "kelantan"
  name: string;
  bbox: [number, number, number, number]; // minLon, minLat, maxLon, maxLat
  languages: string[]; // ["ms", "en"]
  timezone: string; // "Asia/Kuala_Lumpur"
  terrain: { heightmapUrl: string; widthPx: number; heightPx: number; metresPerPx: number; minElev: number; maxElev: number };
  glofasCells: { id: string; lngLat: LngLat; label: string }[];
  replay?: { label: string; start: string; end: string }; // "Dec 2014"
  // Landslide screening config (B fills from Deep Research, §1.6 decision 6).
  // Risk is raised when slope ≥ slopeMinDeg AND rain over `days` ≥ mm for any entry.
  landslide?: {
    slopeMinDeg: number;
    rainThresholdsMm: { days: number; mm: number }[];
    citations: { title: string; url: string }[];
  };
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

// One alert = one group of people from one village going to one centre.
// If a village must be split across centres, the agent creates one Alert per centre
// (same runId + villageId), each with its own `people` count (§1.6 decision 5).
export interface Alert {
  _id: string;
  regionId: string;
  runId: string;
  villageId: string;
  level: RiskLevel;
  hazard: "flood" | "landslide";
  etaHours?: number;
  evacCentreId: string;
  people: number; // how many people this alert sends to evacCentreId (capacity check uses this)
  route: { type: "LineString"; coordinates: LngLat[] };
  messages: { lang: string; text: string }[];
  verification: VerificationResult[];
  status: "draft" | "verified" | "approved" | "rejected" | "sent";
  approvedBy?: string;
  approvedAt?: string;
}

// One agent run (collection `agent_runs`). Its HUD lines are AgentSteps in `agent_steps`.
export interface AgentRun {
  _id: string; // = runId
  regionId: string;
  trigger: { type: "risk_event" | "manual"; riskEventId?: string };
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
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
  blockedRoads: { type: "MultiLineString"; coordinates: LngLat[][] }; // for drawing
  blockedRoadIds: string[]; // RoadFeature ids, for B's route planner + route check
}

// ---- Map data from OSM: GET /regions/:id/geo (§1.6 decision 4) ----
// Roads are split at junctions by scripts/load-osm.ts: one feature = one segment between
// two junction nodes, so B can build a routing graph directly from `from`/`to`.
export interface RoadProps {
  id: string; // "<osmWayId>:<segmentIndex>", stable across reloads; same as Feature.id
  from: string; // OSM node id at the start of the segment
  to: string; // OSM node id at the end of the segment
  name?: string;
  highway: string; // OSM highway tag: "primary", "residential", ...
  lengthM: number;
}
export type RoadFeature = Feature<LineStringGeom, RoadProps>;
export type RiverFeature = Feature<LineStringGeom, { id: string; name?: string; waterway: string }>;
export type BuildingFeature = Feature<PointGeom, { id: string; kind?: string }>; // centroid only, to keep it small

export interface GeoLayers {
  regionId: string;
  roads: FeatureCollection<LineStringGeom, RoadProps>;
  rivers: FeatureCollection<LineStringGeom, RiverFeature["properties"]>;
  buildings: FeatureCollection<PointGeom, BuildingFeature["properties"]>;
}

// ---- Knowledge chunks (collection `knowledge`): post-mortems, plans, Deep Research briefs ----
export interface KnowledgeChunk {
  _id: string;
  regionId: string;
  kind: "postmortem" | "plan" | "deep_research" | "other";
  title: string;
  sourceUrl?: string;
  chunk: string; // the text that gets embedded
  // embeddings are added by Atlas automated embedding / Voyage — never sent to the client
}
