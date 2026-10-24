// ⚠️ TEST DATA — a small, made-up scenario near Kuala Krai for exercising the agent before the
// real data (vulnerable counts, centre capacities, flooded segments) is in MongoDB.
// Coordinates are approximate, numbers are invented, and the knowledge note is NOT a real
// document. Every HUD line from a run on this data is marked "[TEST DATA]".
//
// Built to produce genuine verification failures:
//   - Kg. Manik Urai (300 people, 12 bedridden): the nearest centre has only 50 places free, and
//     every road to the big centre crosses a flooded segment → needs a split + a boat.
//   - Kg. Tualang: has a dry road route to a centre with room → should pass first time.

import type { EvacCentre, KnowledgeChunk, LngLat, Region, RiskEvent, RoadFeature, StationWithLatest, Village } from "@monsoonwatch/shared";
import { haversineKm } from "../geo";
import type { Situation } from "../situation";

const N: Record<string, LngLat> = {
  manikUrai: [102.2, 5.3],
  junctionA: [102.21, 5.31],
  skManikUrai: [102.215, 5.315],
  junctionB: [102.2, 5.4],
  smkKualaKrai: [102.19, 5.53],
  tualang: [102.26, 5.27],
  junctionC: [102.24, 5.3],
  dewanTualang: [102.27, 5.29],
};

function road(id: string, from: string, to: string, name: string, highway = "secondary"): RoadFeature {
  const a = N[from]!, b = N[to]!;
  return {
    type: "Feature", id,
    geometry: { type: "LineString", coordinates: [a, b] },
    properties: { id, from, to, name, highway, lengthM: Math.round(haversineKm(a, b) * 1000) },
  };
}

const ROADS: RoadFeature[] = [
  road("t1:0", "manikUrai", "junctionA", "Jalan Manik Urai"),
  road("t1:1", "junctionA", "skManikUrai", "Jalan Sekolah", "residential"),
  road("t2:0", "manikUrai", "junctionB", "Jalan Kuala Krai (low section)"),
  road("t2:1", "junctionB", "smkKualaKrai", "Jalan Kuala Krai"),
  road("t3:0", "skManikUrai", "junctionB", "Jalan Bukit (river crossing)"),
  road("t4:0", "tualang", "junctionC", "Jalan Tualang"),
  road("t4:1", "junctionC", "dewanTualang", "Jalan Dewan", "residential"),
  road("t5:0", "tualang", "dewanTualang", "Jalan Tepi Sungai", "tertiary"),
];
const FLOODED = ["t2:0", "t3:0", "t5:0"];
/** The gauge that floods each segment (as C's flood model records it in hazard.gaugeId). */
const FLOOD_GAUGE = new Map([["t2:0", "test-galas-dabong"], ["t3:0", "test-galas-dabong"], ["t5:0", "test-lebir-tualang"]]);

export function makeSampleSituation(now = new Date()): Situation {
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

  const region: Region = {
    _id: "kelantan",
    name: "Kelantan River Valley, Malaysia [TEST DATA]",
    bbox: [101.6, 4.6, 102.65, 6.3],
    languages: ["ms", "en"],
    timezone: "Asia/Kuala_Lumpur",
    terrain: { heightmapUrl: "", widthPx: 0, heightPx: 0, metresPerPx: 0, minElev: 0, maxElev: 0 },
    glofasCells: [],
  };

  const stations: StationWithLatest[] = [
    {
      _id: "test-galas-dabong", regionId: "kelantan", kind: "river", name: "Sg. Galas @ Dabong (test)", district: "Kuala Krai",
      location: { type: "Point", coordinates: [102.02, 5.38] }, thresholds: { normal: 38, alert: 40, warning: 42, danger: 44 },
      latest: { ts: minsAgo(10), value: 44.3, meta: { stationId: "test-galas-dabong", kind: "river", source: "jps", mode: "live" } },
    },
    {
      _id: "test-lebir-tualang", regionId: "kelantan", kind: "river", name: "Sg. Lebir @ Kg. Tualang (test)", district: "Kuala Krai",
      location: { type: "Point", coordinates: [102.25, 5.26] }, thresholds: { normal: 30, alert: 32, warning: 34, danger: 35 },
      latest: { ts: minsAgo(12), value: 34.6, meta: { stationId: "test-lebir-tualang", kind: "river", source: "jps", mode: "live" } },
    },
  ];

  const riskEvents: RiskEvent[] = [
    { _id: "test-re-galas", regionId: "kelantan", ts: minsAgo(10), type: "river_threshold", stationId: "test-galas-dabong", level: "danger", value: 44.3, threshold: 44, message: "Sg. Galas @ Dabong crossed DANGER (44.30 m > 44.00 m) [TEST DATA]", source: "stream_processing" },
    { _id: "test-re-lebir", regionId: "kelantan", ts: minsAgo(12), type: "river_threshold", stationId: "test-lebir-tualang", level: "warning", value: 34.6, threshold: 34, message: "Sg. Lebir @ Kg. Tualang crossed WARNING (34.60 m > 34.00 m) [TEST DATA]", source: "stream_processing" },
  ];

  const est = { source: "Invented for testing", estimated: true };
  const villages: Village[] = [
    { _id: "test-kg-manik-urai", regionId: "kelantan", name: "Kg. Manik Urai", altNames: ["Manik Urai"], location: { type: "Point", coordinates: N.manikUrai! }, population: 300, district: "Kuala Krai",
      vulnerable: { bedridden: 12, disabled: 8, elderly: 40, noTransport: 25, ...est } },
    { _id: "test-kg-tualang", regionId: "kelantan", name: "Kg. Tualang", altNames: ["Tualang"], location: { type: "Point", coordinates: N.tualang! }, population: 180, district: "Kuala Krai",
      vulnerable: { bedridden: 4, disabled: 3, elderly: 20, noTransport: 10, ...est } },
    { _id: "test-kg-bukit-raja", regionId: "kelantan", name: "Kg. Bukit Raja", altNames: [], location: { type: "Point", coordinates: [102.45, 5.9] }, population: 220, district: "Machang" },
  ];

  const centres: EvacCentre[] = [
    { _id: "test-sk-manik-urai", regionId: "kelantan", name: "SK Manik Urai (test)", location: { type: "Point", coordinates: N.skManikUrai! }, capacity: 250, headcount: 200, elevationM: 62 },
    { _id: "test-smk-kuala-krai", regionId: "kelantan", name: "SMK Kuala Krai (test)", location: { type: "Point", coordinates: N.smkKualaKrai! }, capacity: 600, headcount: 50, elevationM: 75 },
    { _id: "test-dewan-tualang", regionId: "kelantan", name: "Dewan Orang Ramai Tualang (test)", location: { type: "Point", coordinates: N.dewanTualang! }, capacity: 300, headcount: 0, elevationM: 58 },
  ];

  const knowledge: KnowledgeChunk[] = [
    { _id: "test-k1", regionId: "kelantan", kind: "other", title: "Test note (not a real document)",
      chunk: "TEST NOTE: In this test scenario, low sections of Jalan Kuala Krai flood first when Sg. Galas is above danger level; residents who cannot move themselves need boats once that happens." },
  ];

  return {
    region, mode: "live", now, stations, riskEvents, villages, centres, roads: ROADS, floodGaugeByRoadId: FLOOD_GAUGE,
    hazards: {
      blockedRoadIds: FLOODED,
      blockedRoads: { type: "MultiLineString", coordinates: ROADS.filter((r) => FLOODED.includes(r.properties.id)).map((r) => r.geometry.coordinates) },
      landslide: { cells: [], runouts: [] },
    },
    knowledge,
    isTestData: true,
  };
}
