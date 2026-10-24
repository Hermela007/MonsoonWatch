// Travel restrictions for a road segment, copied from its OSM way tags (used by load-osm.ts).
import type { RoadProps } from "@monsoonwatch/shared";

/** Optional RoadProps from OSM way tags. Only explicit tags are copied (roundabouts imply oneway). */
export function restrictions(tags: Record<string, string> = {}): Pick<RoadProps, "oneway" | "bridge" | "access" | "maxweightT" | "surface"> {
  const out: Pick<RoadProps, "oneway" | "bridge" | "access" | "maxweightT" | "surface"> = {};
  const ow = tags.oneway;
  if (ow === "yes" || ow === "1" || ow === "true") out.oneway = "forward";
  else if (ow === "-1" || ow === "reverse") out.oneway = "reverse";
  else if (ow === "no" || ow === "0" || ow === "false") out.oneway = "no";
  else if (tags.junction === "roundabout" || tags.junction === "circular") out.oneway = "forward";
  if (tags.bridge && tags.bridge !== "no") out.bridge = true;
  if (tags.access) out.access = tags.access;
  // "15", "15 t", "15t", "15.5" → tonnes; other units (lbs, st) are skipped rather than guessed.
  const mw = /^\s*(\d+(?:\.\d+)?)\s*(t)?\s*$/i.exec(tags.maxweight ?? "");
  if (mw) out.maxweightT = Number(mw[1]);
  if (tags.surface) out.surface = tags.surface;
  return out;
}
