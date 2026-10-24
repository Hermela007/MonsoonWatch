// Everything the agent knows about a region at one moment. Loaded from MongoDB (situation-db.ts)
// or from the labelled TEST scenario (sample/kelantan-test.ts).

import type { EvacCentre, Hazards, KnowledgeChunk, LngLat, Reading, Region, RiskEvent, RoadFeature, StationWithLatest, Village } from "@monsoonwatch/shared";
import { SHORTLIST, shortlistForArgon, type Shortlist } from "./shortlist";

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
  /** Flooded/assessed road segment id → the gauge C's flood model uses for it (hazard.gaugeId). Not sent to Gemini. */
  floodGaugeByRoadId?: ReadonlyMap<string, string>;
  /** Caveats from the hazard models (approximate flood model, screening landslide model). */
  hazardNotes?: string[];
  /** True for the sample scenario: shown in HUD summaries so test output is never mistaken for real. */
  isTestData: boolean;
}

const round = (c: LngLat, dp: number): LngLat => {
  const f = 10 ** dp;
  return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
};

/**
 * Compact view for Argon's prompt: no road geometry (Argon doesn't route; planRoute does).
 * Shortlisted by default (shortlist.ts); `{ full: true }` sends everything (used by --dry-run for comparison).
 */
export function situationForPrompt(s: Situation, opts: { full?: boolean; shortlist?: Shortlist } = {}) {
  const dp = SHORTLIST.coordDecimals;
  const sl = opts.full ? null : (opts.shortlist ?? shortlistForArgon(s));
  const villages = sl ? sl.villages.map((r) => ({ village: r.village, level: r.level as string | undefined, signals: r.signals.map((x) => x.text) })) : s.villages.map((village) => ({ village, level: undefined, signals: [] as string[] }));
  const centres = sl ? sl.centres : s.centres;
  const stations = sl ? sl.stations : s.stations;
  const knowledge = sl ? sl.knowledge : s.knowledge;
  return {
    testData: s.isTestData,
    region: { id: s.region._id, name: s.region.name, languages: s.region.languages, timezone: s.region.timezone },
    mode: s.mode,
    now: s.now.toISOString(),
    ...(sl && {
      shortlist:
        `Villages listed: the ${sl.villages.length} most at risk by a deterministic screen (flooded road near the village, landslide runout, ` +
        `or a warning gauge where the flood model has no data), most at risk first. The others are summarised per district in notSentByDistrict ` +
        `(not checked as safe): at-risk villages over the cap get a deterministic area-wide warning; "watch" = gauge at alert+ nearby but no flooding or runout at the village.`,
      notSentByDistrict: sl.notSent,
    }),
    stations: stations.map((st) => ({
      id: st._id, name: st.name, kind: st.kind, district: st.district, basin: st.basin,
      lngLat: round(st.location.coordinates, dp), thresholdsM: st.thresholds,
      latest: st.latest ? { ts: st.latest.ts, value: st.latest.value, rain6dMm: st.latest.rain6d } : null,
    })),
    riskEvents: s.riskEvents.map((e) => ({ id: e._id, ts: e.ts, type: e.type, stationId: e.stationId, level: e.level, value: e.value, threshold: e.threshold, message: e.message })),
    villages: villages.map(({ village: v, level, signals }) => ({
      id: v._id, name: v.name, district: v.district, lngLat: round(v.location.coordinates, dp), population: v.population, vulnerable: v.vulnerable,
      ...(level && { screenLevel: level, riskSignals: signals }),
    })),
    evacCentres: centres.map((c) => ({ id: c._id, name: c.name, lngLat: round(c.location.coordinates, dp), capacity: c.capacity, headcount: c.headcount, elevationM: c.elevationM })),
    glofasCells: (s.glofas ?? []).map((g) => ({
      id: g.id, label: g.label, lngLat: round(g.lngLat, dp),
      latestDischargeM3s: g.latest ? { ts: g.latest.ts, value: g.latest.value } : null,
      note: "Reconstructed GloFAS discharge (m³/s), not a water level; thresholds approximate",
    })),
    floodedRoadSegments: s.hazards.blockedRoadIds.length,
    hazardNotes: s.hazardNotes ?? [],
    landslideRunouts: s.hazards.landslide.runouts.length,
    knowledge: knowledge.map((k) => ({ title: k.title, kind: k.kind, sourceUrl: k.sourceUrl, text: k.chunk })),
  };
}
