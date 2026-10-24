// Elevation grid for the hazards model, written by `pnpm build:terrain` (scripts/build-terrain.ts).
// Files: apps/api/data/terrain/<regionId>.elev.json (header) + <regionId>.elev.i16.gz (data).
//   data: gzipped little-endian Int16, row-major, row 0 = north edge, column 0 = west edge;
//         value × scale = elevation in metres above sea level (scale 1 = whole metres); nodata = -32768.
//   grid: regular lon/lat grid over Region.bbox; pixel (col,row) centre is
//         lon = minLon + (col + 0.5) · dLon,  lat = maxLat − (row + 0.5) · dLat.
// Source: AWS Terrain Tiles (Terrarium, mostly SRTM 30 m here), resampled — vertical error several metres.
import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export interface ElevationHeader {
  regionId: string;
  bbox: [number, number, number, number];
  width: number;
  height: number;
  dLon: number;
  dLat: number;
  metresPerPx: number;
  scale: number;
  nodata: number;
  minElev: number;
  maxElev: number;
  source: string;
}

export interface ElevationGrid extends ElevationHeader {
  data: Int16Array;
}

export const terrainDir = fileURLToPath(new URL("../../data/terrain/", import.meta.url));

const cache = new Map<string, ElevationGrid>();

/** Load (once) the elevation grid for a region. Throws if `pnpm build:terrain` hasn't been run. */
export function loadElevationGrid(regionId: string): ElevationGrid {
  const hit = cache.get(regionId);
  if (hit) return hit;
  const headerFile = `${terrainDir}${regionId}.elev.json`;
  if (!existsSync(headerFile)) throw new Error(`No elevation grid for "${regionId}" — run \`pnpm build:terrain\``);
  const header = JSON.parse(readFileSync(headerFile, "utf8")) as ElevationHeader;
  const buf = gunzipSync(readFileSync(`${terrainDir}${regionId}.elev.i16.gz`));
  const data = new Int16Array(header.width * header.height);
  for (let i = 0; i < data.length; i++) data[i] = buf.readInt16LE(i * 2);
  const grid = { ...header, data };
  cache.set(regionId, grid);
  return grid;
}

/** Elevation (m) at a point, bilinear between pixel centres; null outside the grid or on nodata. */
export function elevationAt(grid: ElevationGrid, lon: number, lat: number): number | null {
  const [minLon, , , maxLat] = grid.bbox;
  const fx = (lon - minLon) / grid.dLon - 0.5;
  const fy = (maxLat - lat) / grid.dLat - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > grid.width - 0.5 || fy > grid.height - 0.5) return null;
  const x0 = Math.max(0, Math.min(grid.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(grid.height - 1, Math.floor(fy)));
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const v = (x: number, y: number) => grid.data[y * grid.width + x]!;
  const corners = [v(x0, y0), v(x1, y0), v(x0, y1), v(x1, y1)];
  if (corners.some((c) => c === grid.nodata)) return null;
  const top = corners[0]! * (1 - tx) + corners[1]! * tx;
  const bottom = corners[2]! * (1 - tx) + corners[3]! * tx;
  return (top * (1 - ty) + bottom * ty) * grid.scale;
}
