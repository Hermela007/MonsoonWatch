// Place search (C7): Atlas Search over the `places` indexes on villages and stations
// (apps/api/src/db/indexes/places.*.json) — autocomplete + fuzzy text on name (and altNames for villages),
// filtered to the region. The two collections are queried in parallel and merged by score.
// Scores come from two indexes with the same query shape, so they are comparable enough to merge for a
// search bar, not in absolute terms.
import type { Document } from "mongodb";
import { COLLECTIONS, type LngLat, type SearchHit } from "@monsoonwatch/shared";
import { getDb } from "../db/client";
import { env } from "../env";
import { newSearchRunId, recordSearchSteps } from "./steps";

export interface SearchPlacesOptions {
  limit?: number; // default 8
  regionId?: string; // default env.regionId
  runId?: string; // HUD run to attach the step to (default: a new "search-…" run)
}

export interface PlaceSearchResult {
  hits: SearchHit[];
  latencyMs: number;
  runId: string;
}

// prefixLength 1: the first letter must match, so short typos don't drag in every place in the region.
const FUZZY = { maxEdits: 1, prefixLength: 1 };

// Field weights. compound `should` clauses add up, so a village whose alt name repeats its name
// ("Kampung Kuala Besar" / "Kg Kuala Besar") would otherwise outscore the exact place on a shared word.
const NAME = { path: "name", weight: 1 };
const ALT_NAMES = { path: "altNames", weight: 0.5 };

function placesPipeline(q: string, fields: { path: string; weight: number }[], regionId: string, limit: number): Document[] {
  return [
    {
      $search: {
        index: "places",
        compound: {
          filter: [{ equals: { path: "regionId", value: regionId } }],
          should: fields.flatMap(({ path, weight }) => [
            // Typing a prefix ("kuala kr") → autocomplete; boosted so the place being typed ranks first.
            { autocomplete: { query: q, path, fuzzy: FUZZY, score: { boost: { value: 2 * weight } } } },
            // Whole words with typos or other spellings ("manik urai", "kuala kri") → fuzzy text.
            { text: { query: q, path, fuzzy: FUZZY, score: { boost: { value: weight } } } },
          ]),
          minimumShouldMatch: 1,
        },
      },
    },
    { $limit: limit },
    { $project: { name: 1, location: 1, score: { $meta: "searchScore" } } },
  ];
}

type PlaceDoc = { _id: string; name: string; location: { coordinates: LngLat }; score: number };

export async function searchPlaces(q: string, opts: SearchPlacesOptions = {}): Promise<PlaceSearchResult> {
  const limit = opts.limit ?? 8;
  const regionId = opts.regionId ?? env.regionId;
  const runId = opts.runId ?? newSearchRunId();
  const db = await getDb();
  const t0 = performance.now();
  const [villages, stations] = await Promise.all([
    db.collection(COLLECTIONS.villages).aggregate<PlaceDoc>(placesPipeline(q, [NAME, ALT_NAMES], regionId, limit)).toArray(),
    db.collection(COLLECTIONS.stations).aggregate<PlaceDoc>(placesPipeline(q, [NAME], regionId, limit)).toArray(),
  ]);
  const toHit = (kind: "village" | "station") => (d: PlaceDoc): SearchHit => ({
    kind,
    id: d._id,
    title: d.name,
    lngLat: d.location.coordinates,
    score: Math.round(d.score * 1000) / 1000,
  });
  const hits = [...villages.map(toHit("village")), ...stations.map(toHit("station"))].sort((a, b) => b.score - a.score).slice(0, limit);
  const latencyMs = Math.round(performance.now() - t0);
  await recordSearchSteps(runId, [
    {
      key: "place",
      actor: "MongoDB Atlas Search",
      summary: `Place search "${q}": ${hits.length} hits (autocomplete + fuzzy over villages + stations)${hits[0] ? ` — top: ${hits[0].title}` : ""}`,
      status: "ok",
      latencyMs,
    },
  ]);
  return { hits, latencyMs, runId };
}
