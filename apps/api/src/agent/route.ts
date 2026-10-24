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
  /** How far the start / end points are from the road node they were snapped to (km). */
  startSnapKm?: number;
  endSnapKm?: number;
  /** The road segments used, in order (for directions and hazard coverage). */
  segments?: { id: string; name?: string; highway: string; lengthM: number; coords: LngLat[] }[];
}

export interface RouteOptions {
  /** OSM highway values this travel mode may not use (e.g. footways for cars). */
  excludeHighways?: ReadonlySet<string>;
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

// Grid of node ids (cell ≈ 1 km), built lazily per graph: nearestNode was a scan of every node,
// too slow when the rules planner snaps hundreds of villages and centres.
const GRID_DEG = 0.01;
const grids = new WeakMap<RoadGraph, Map<string, string[]>>();

function gridOf(graph: RoadGraph): Map<string, string[]> {
  let grid = grids.get(graph);
  if (grid) return grid;
  grid = new Map();
  for (const [id, c] of graph.nodeCoord) {
    const k = `${Math.floor(c[0] / GRID_DEG)},${Math.floor(c[1] / GRID_DEG)}`;
    const list = grid.get(k);
    if (list) list.push(id);
    else grid.set(k, [id]);
  }
  grids.set(graph, grid);
  return grid;
}

/** Exact nearest node: scans grid rings outward until no closer node can exist. */
export function nearestNode(graph: RoadGraph, p: LngLat): { id: string; km: number } | null {
  if (graph.nodeCoord.size === 0) return null;
  const grid = gridOf(graph);
  const cx = Math.floor(p[0] / GRID_DEG), cy = Math.floor(p[1] / GRID_DEG);
  // Lower bound on the km covered by one cell (longitude shrinks with latitude).
  const cellKm = GRID_DEG * 110 * Math.cos((Math.min(89, Math.abs(p[1]) + GRID_DEG) * Math.PI) / 180);
  let best = null as { id: string; km: number } | null; // (cast: TS narrows a null-initialised let to never across these loops)
  for (let r = 0; r <= 200; r++) {
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // ring only
        for (const id of grid.get(`${x},${y}`) ?? []) {
          const km = haversineKm(p, graph.nodeCoord.get(id)!);
          if (!best || km < best.km) best = { id, km };
        }
      }
    }
    // Every node not scanned yet is in ring ≥ r+1, at least r cells away.
    if (best && best.km <= r * cellKm) return best;
  }
  if (best) return best;
  for (const [id, c] of graph.nodeCoord) { // > 200 cells away: fall back to a full scan
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

function dijkstra(graph: RoadGraph, start: string, goal: string, skip: Set<string>, excludeHighways?: ReadonlySet<string>): Edge[] | null {
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
      if (excludeHighways?.has(e.seg.properties.highway)) continue;
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
  const segments = path.map((e) => ({
    id: e.seg.properties.id,
    ...(e.seg.properties.name ? { name: e.seg.properties.name } : {}),
    highway: e.seg.properties.highway,
    lengthM: e.seg.properties.lengthM,
    coords: e.forward ? e.seg.geometry.coordinates : [...e.seg.geometry.coordinates].reverse(),
  }));
  return {
    found, mode, coordinates, segmentIds, segments,
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
  opts: RouteOptions = {},
): RouteResult {
  const blocked = new Set(blockedRoadIds);
  const a = nearestNode(graph, from);
  const b = nearestNode(graph, to);
  if (!a || !b) return { found: false, mode, coordinates: [from, to], segmentIds: [], lengthKm: 0, crossesFlood: false, note: "No road data for this region" };
  const snap = { startSnapKm: Math.round(a.km * 100) / 100, endSnapKm: Math.round(b.km * 100) / 100 };
  const ex = opts.excludeHighways;
  const done = (res: RouteResult): RouteResult => ({ ...res, ...snap });

  if (mode === "road") {
    const dry = dijkstra(graph, a.id, b.id, blocked, ex);
    if (dry) return done(toResult(from, to, dry, mode, true, blocked, "Dry road route"));
    const any = dijkstra(graph, a.id, b.id, new Set(), ex);
    if (any) return done(toResult(from, to, any, mode, false, blocked, "No dry road route — every road path crosses a flooded segment; use a boat or another centre"));
    return done({ found: false, mode, coordinates: [from, to], segmentIds: [], lengthKm: 0, crossesFlood: false, note: "No road connection to this centre" });
  }

  const path = dijkstra(graph, a.id, b.id, new Set(), ex);
  if (!path) return done({ found: false, mode, coordinates: [from, to], segmentIds: [], lengthKm: 0, crossesFlood: false, note: "No connection to this centre" });
  const r = toResult(from, to, path, mode, true, blocked, "Boat route");
  return done({ ...r, note: r.crossesFlood ? "Boat route across flooded road segments" : "Boat route (roads also dry)" });
}

export interface RouteTarget { id: string; lngLat: LngLat }
/** Target (centre) snaps reused across calls on the same graph — the rules planner routes hundreds of villages to the same centres. */
const targetSnaps = new WeakMap<RoadGraph, Map<string, { id: string; km: number } | null>>();
export interface ReachedTarget { id: string; route: RouteResult }

/**
 * One Dijkstra from `from` to the nearest targets, in road-distance order (one search instead of
 * one per target). Stops when `enough(reached)` says so or beyond `maxKm` of road. Targets further
 * than `maxSnapKm` from the network are skipped. Routes follow roads only.
 *   mode "road" (default): flooded segments are never used — dry routes only.
 *   mode "boat": flooded segments may be used (roads as a stand-in for channels); `crossesFlood` says so.
 */
export function routesToNearestTargets(
  graph: RoadGraph,
  blockedRoadIds: ReadonlySet<string>,
  from: LngLat,
  targets: RouteTarget[],
  opts: { maxKm: number; maxSnapKm: number; enough: (reached: ReachedTarget[]) => boolean; excludeHighways?: ReadonlySet<string>; mode?: RouteMode },
): { startSnapKm: number | null; reached: ReachedTarget[] } {
  const a = nearestNode(graph, from);
  if (!a) return { startSnapKm: null, reached: [] };
  const startSnapKm = Math.round(a.km * 100) / 100;
  const atNode = new Map<string, { t: RouteTarget; snapKm: number }[]>();
  let snaps = targetSnaps.get(graph);
  if (!snaps) targetSnaps.set(graph, (snaps = new Map()));
  for (const t of targets) {
    const key = `${t.lngLat[0]},${t.lngLat[1]}`;
    let n = snaps.get(key);
    if (n === undefined) snaps.set(key, (n = nearestNode(graph, t.lngLat)));
    if (!n || n.km > opts.maxSnapKm) continue;
    const list = atNode.get(n.id);
    const entry = { t, snapKm: Math.round(n.km * 100) / 100 };
    if (list) list.push(entry);
    else atNode.set(n.id, [entry]);
  }
  const blocked = blockedRoadIds as Set<string>;
  const mode = opts.mode ?? "road";
  const dist = new Map<string, number>([[a.id, 0]]);
  const prev = new Map<string, { node: string; edge: Edge }>();
  const heap = new MinHeap();
  const reached: ReachedTarget[] = [];
  heap.push(0, a.id);
  while (heap.size) {
    const { k, id } = heap.pop();
    if (k > (dist.get(id) ?? Infinity)) continue;
    if (k > opts.maxKm * 1000) break;
    const here = atNode.get(id);
    if (here) {
      const path: Edge[] = [];
      for (let n = id; n !== a.id; ) {
        const p = prev.get(n)!;
        path.unshift(p.edge);
        n = p.node;
      }
      for (const { t, snapKm } of here) {
        const r = toResult(from, t.lngLat, path, mode, true, blocked, mode === "road" ? "Dry road route" : "Boat route");
        const note = mode === "road" ? r.note : r.crossesFlood ? "Boat route across flooded road segments" : "Boat route (roads also dry)";
        reached.push({ id: t.id, route: { ...r, note, startSnapKm, endSnapKm: snapKm } });
      }
      if (opts.enough(reached)) break;
    }
    for (const e of graph.adj.get(id) ?? []) {
      if (mode === "road" && blocked.has(e.seg.properties.id)) continue;
      if (opts.excludeHighways?.has(e.seg.properties.highway)) continue;
      const nd = k + e.seg.properties.lengthM;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { node: id, edge: e });
        heap.push(nd, e.to);
      }
    }
  }
  return { startSnapKm, reached };
}
