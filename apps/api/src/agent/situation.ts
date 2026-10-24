// Everything the agent knows about a region at one moment. Loaded from MongoDB (situation-db.ts)
// or from the labelled TEST scenario (sample/kelantan-test.ts).

import type { EvacCentre, Hazards, KnowledgeChunk, LngLat, Reading, Region, RiskEvent, RoadFeature, StationWithLatest, Village } from "@monsoonwatch/shared";

export interface Situation {
  region: Region;
  mode: "live" | "replay";
  now: Date;
  stations: StationWithLatest[];
  riskEvents: RiskEvent[];
  villages: Village[];
  centres: EvacCentre[];
  roads: RoadFeature[];
  hazards: Pick<Hazards, "blockedRoads" | "blockedRoadIds" | "landslide">;
  knowledge: KnowledgeChunk[];
  /** GloFAS main-channel cells (discharge m³/s, reconstructed) — the river evidence in the 2014 replay. */
  glofas?: { id: string; label: string; lngLat: LngLat; latest: Reading | null }[];
  /** Road segments the flood model assessed (others are unknown, not safe). Not sent to Gemini. */
  assessedRoadIds?: ReadonlySet<string>;
  /** Caveats from the hazard models (approximate flood model, screening landslide model). */
  hazardNotes?: string[];
  /** True for the sample scenario: shown in HUD summaries so test output is never mistaken for real. */
  isTestData: boolean;
}

/** Compact view for Gemini prompts: no road geometry (Argon doesn't route; planRoute does). */
export function situationForPrompt(s: Situation) {
  return {
    testData: s.isTestData,
    region: { id: s.region._id, name: s.region.name, languages: s.region.languages, timezone: s.region.timezone },
    mode: s.mode,
    now: s.now.toISOString(),
    stations: s.stations.map((st) => ({
      id: st._id, name: st.name, kind: st.kind, district: st.district, basin: st.basin,
      lngLat: st.location.coordinates, thresholdsM: st.thresholds,
      latest: st.latest ? { ts: st.latest.ts, value: st.latest.value, rain6dMm: st.latest.rain6d } : null,
    })),
    riskEvents: s.riskEvents.map((e) => ({ id: e._id, ts: e.ts, type: e.type, stationId: e.stationId, level: e.level, value: e.value, threshold: e.threshold, message: e.message })),
    villages: s.villages.map((v) => ({ id: v._id, name: v.name, district: v.district, lngLat: v.location.coordinates, population: v.population, vulnerable: v.vulnerable })),
    evacCentres: s.centres.map((c) => ({ id: c._id, name: c.name, lngLat: c.location.coordinates, capacity: c.capacity, headcount: c.headcount, elevationM: c.elevationM })),
    glofasCells: (s.glofas ?? []).map((g) => ({
      id: g.id, label: g.label, lngLat: g.lngLat,
      latestDischargeM3s: g.latest ? { ts: g.latest.ts, value: g.latest.value } : null,
      note: "Reconstructed GloFAS discharge (m³/s), not a water level; thresholds approximate",
    })),
    floodedRoadSegments: s.hazards.blockedRoadIds.length,
    hazardNotes: s.hazardNotes ?? [],
    landslideRunouts: s.hazards.landslide.runouts.length,
    knowledge: s.knowledge.map((k) => ({ title: k.title, kind: k.kind, sourceUrl: k.sourceUrl, text: k.chunk })),
  };
}
