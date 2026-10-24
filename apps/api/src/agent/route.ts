// planRoute — deterministic evacuation routing over C's junction-split OSM road segments
// (§1.6 decision 4: one RoadFeature per segment, `from`/`to` = OSM node ids, `lengthM`).
// Dijkstra on segment length. No LLM: Gemini chooses the centre and the mode; this file finds
// the path, and verify.ts checks it.
//
//   mode "road": flooded segments (Hazards.blockedRoadIds) are removed. If no dry path exists,
//                the result is `found: false`, plus the shortest path ignoring floods as a
//                fallback so the plan can still be drawn — and the route check will fail it.
//   mode "boat": flooded segments are allowed (a boat goes over them); `crossesFlood` says so.

import type { LngLat, RoadFeature } from "@monsoonwatch/shared";
import { haversineKm } from "./geo";

export type RouteMode = "road" | "boat";

export interface RouteResult {
  /** A path that respects the mode (road mode: dry roads only). */
  found: boolean;
  mode: RouteMode;
  coordinates: LngLat[];
  segmentIds: string[];
  lengthKm: number;
  crossesFlood: boolean;
  note: string;
}

interface Edge { to: string; seg: RoadFeature; forward: boolean }

export interface RoadGraph {
  adj: Map<string, Edge[]>;
  nodeCoord: Map<string, LngLat>;
}

/** Build once per region and reuse (the real Kelantan road layer is large). */
export function buildRoadGraph(roads: RoadFeature[]): RoadGraph {
  const adj = new Map<string, Edge[]>();
  const nodeCoord = new Map<string, LngLat>();
  const add = (a: string, e: Edge) => {
    const list = adj.get(a);
    if (list) list.push(e);
    else adj.set(a, [e]);
  };
  for (const seg of roads) {
    const c = seg.geometry.coordinates;
    if (c.length < 2) continue;
    const { from, to } = seg.properties;
    nodeCoord.set(from, c[0]!);
    nodeCoord.set(to, c[c.length - 1]!);
    add(from, { to, seg, forward: true });
    add(to, { to: from, seg, forward: false });
  }
  return { adj, nodeCoord };
}

function nearestNode(graph: RoadGraph, p: LngLat): { id: string; km: number } | null {
  let best: { id: string; km: number } | null = null;
  for (const [id, c] of graph.nodeCoord) {
    const km = haversineKm(p, c);
    if (!best || km < best.km) best = { id, km };
  }
  return best;
}

/** Minimal binary heap keyed by distance. */
class MinHeap {
  private a: { k: number; id: string }[] = [];
  get size() { return this.a.length; }
  push(k: number, id: string) {
    const a = this.a; a.push({ k, id });
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p]!.k <= a[i]!.k) break; [a[p], a[i]] = [a[i]!, a[p]!]; i = p; }
  }
  pop(): { k: number; id: string } {
    const a = this.a; const top = a[0]!; const last = a.pop()!;
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l]!.k < a[m]!.k) m = l;
        if (r < a.length && a[r]!.k < a[m]!.k) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i]!, a[m]!]; i = m;
      }
    }
    return top;
  }
}

function dijkstra(graph: RoadGraph, start: string, goal: string, skip: Set<string>): Edge[] | null {
  const dist = new Map<string, number>([[start, 0]]);
  const prev = new Map<string, { node: string; edge: Edge }>();
  const heap = new MinHeap();
  heap.push(0, start);
  while (heap.size) {
    const { k, id } = heap.pop();
    if (id === goal) break;
    if (k > (dist.get(id) ?? Infinity)) continue;
    for (const e of graph.adj.get(id) ?? []) {
      if (skip.has(e.seg.properties.id)) continue;
      const nd = k + e.seg.properties.lengthM;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: id, edge: e });
        heap.push(nd, e.to);
      }
    }
  }
  if (!dist.has(goal)) return null;
  const path: Edge[] = [];
  for (let n = goal; n !== start; ) {
    const p = prev.get(n)!;
    path.unshift(p.edge);
    n = p.node;
  }
  return path;
}

function toResult(from: LngLat, to: LngLat, path: Edge[], mode: RouteMode, found: boolean, blocked: Set<string>, note: string): RouteResult {
  const coordinates: LngLat[] = [from];
  for (const e of path) {
    const c = e.seg.geometry.coordinates;
    coordinates.push(...(e.forward ? c : [...c].reverse()));
  }
  coordinates.push(to);
  const lengthM = path.reduce((s, e) => s + e.seg.properties.lengthM, 0);
  const segmentIds = path.map((e) => e.seg.properties.id);
  return {
    found, mode, coordinates, segmentIds,
    lengthKm: Math.round(lengthM / 100) / 10,
    crossesFlood: segmentIds.some((id) => blocked.has(id)),
    note,
  };
}

export function planRoute(
  graph: RoadGraph,
  blockedRoadIds: string[],
  from: LngLat,
  to: LngLat,
  mode: RouteMode,
): RouteResult {
  const blocked = new Set(blockedRoadIds);
  const a = nearestNode(graph, from);
  const b = nearestNode(graph, to);
  if (!a || !b) return { found: false, mode, coordinates: [from, to], segmentIds: [], lengthKm: 0, crossesFlood: false, note: "No road data for this region" };

  if (mode === "road") {
    const dry = dijkstra(graph, a.id, b.id, blocked);
    if (dry) return toResult(from, to, dry, mode, true, blocked, "Dry road route");
    const any = dijkstra(graph, a.id, b.id, new Set());
    if (any) return toResult(from, to, any, mode, false, blocked, "No dry road route — every road path crosses a flooded segment; use a boat or another centre");
    return { found: false, mode, coordinates: [from, to], segmentIds: [], lengthKm: 0, crossesFlood: false, note: "No road connection to this centre" };
  }

  const path = dijkstra(graph, a.id, b.id, new Set());
  if (!path) return { found: false, mode, coordinates: [from, to], segmentIds: [], lengthKm: 0, crossesFlood: false, note: "No connection to this centre" };
  const r = toResult(from, to, path, mode, true, blocked, "Boat route");
  return { ...r, note: r.crossesFlood ? "Boat route across flooded road segments" : "Boat route (roads also dry)" };
}
