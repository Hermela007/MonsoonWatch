// REST response shapes not covered by a single domain type (§1.6 decisions 2, 3, 7, 8).
import type { AgentRun, AgentStep, Alert, LngLat, Report, Station, Reading } from "./types";

// GET /regions/:id/stations — latest is null when the station has no readings yet.
export type StationWithLatest = Station & { latest: Reading | null };

// GET /search?q&type=place|hybrid
export type SearchType = "place" | "hybrid";
export interface SearchHit {
  kind: "village" | "station" | "evac_centre" | "report" | "knowledge";
  id: string;
  title: string; // village/station name, report text start, knowledge title
  snippet?: string; // matched text (hybrid)
  lngLat?: LngLat; // where to fly the camera (places, reports)
  sourceUrl?: string; // knowledge citations
  score: number; // final score after fusion/rerank (higher = better)
  rankBeforeRerank?: number; // 1-based position before Voyage rerank (hybrid only), for the before/after view
}
export interface SearchResponse {
  query: string;
  type: SearchType;
  reranked: boolean; // true when Voyage reranked the hits
  hits: SearchHit[];
}

// GET /reports/:id/similar — Vector Search, within 5 km by default
export interface SimilarReportsResponse {
  reportId: string;
  hits: { report: Report; score: number; distanceM: number }[];
}

// POST /agent/run → { runId }; GET /agent/runs/:id → AgentRunDetail
export interface AgentRunStarted { runId: string }
export interface AgentRunDetail {
  run: AgentRun;
  steps: AgentStep[]; // oldest first
  alerts: Alert[];
}

// Every non-2xx response from the API has this body.
export type ApiErrorCode = "bad_request" | "not_found" | "conflict" | "unavailable" | "internal";
export interface ApiError {
  error: { code: ApiErrorCode; message: string };
}
