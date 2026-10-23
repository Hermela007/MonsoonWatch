import type { BBox } from '../geo/region';
import type { Heightmap } from './heightmap';

// Public AWS Terrain Tiles (Terrarium encoding). CORS: Access-Control-Allow-Origin: *.
// Until Workstream C's scripts/build-terrain.ts bakes a heightmap, we decode tiles in the browser.
const TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const TILE_PX = 256;

const lonToTileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToTileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
};

async function fetchTile(z: number, x: number, y: number): Promise<Float32Array> {
  const res = await fetch(`${TILE_URL}/${z}/${x}/${y}.png`);
  if (!res.ok) throw new Error(`Terrain tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(TILE_PX, TILE_PX);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let i = 0; i < out.length; i++) {
    out[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** Fetch Terrarium tiles covering `bbox` and resample to a regular lon/lat grid. */
export async function loadTerrariumGrid(
  bbox: BBox,
  zoom: number,
  cols: number,
  rows: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Heightmap> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const tx0 = Math.floor(lonToTileX(minLon, zoom));
  const tx1 = Math.floor(lonToTileX(maxLon, zoom));
  const ty0 = Math.floor(latToTileY(maxLat, zoom));
  const ty1 = Math.floor(latToTileY(minLat, zoom));
  const nx = tx1 - tx0 + 1;
  const ny = ty1 - ty0 + 1;
  const mw = nx * TILE_PX;
  const mosaic = new Float32Array(mw * ny * TILE_PX);

  let done = 0;
  const jobs: Promise<void>[] = [];
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      jobs.push(
        fetchTile(zoom, tx, ty).then((tile) => {
          const ox = (tx - tx0) * TILE_PX;
          const oy = (ty - ty0) * TILE_PX;
          for (let r = 0; r < TILE_PX; r++) {
            mosaic.set(tile.subarray(r * TILE_PX, (r + 1) * TILE_PX), (oy + r) * mw + ox);
          }
          onProgress?.(++done, nx * ny);
        }),
      );
    }
  }
  await Promise.all(jobs);

  const mh = ny * TILE_PX;
  const sample = (px: number, py: number) => {
    const x0 = Math.max(0, Math.min(mw - 2, Math.floor(px)));
    const y0 = Math.max(0, Math.min(mh - 2, Math.floor(py)));
    const fx = Math.min(1, Math.max(0, px - x0));
    const fy = Math.min(1, Math.max(0, py - y0));
    const i = y0 * mw + x0;
    return (
      (mosaic[i] * (1 - fx) + mosaic[i + 1] * fx) * (1 - fy) +
      (mosaic[i + mw] * (1 - fx) + mosaic[i + mw + 1] * fx) * fy
    );
  };

  const elevM = new Float32Array(cols * rows);
  const colPx = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const lon = minLon + (c / (cols - 1)) * (maxLon - minLon);
    colPx[c] = (lonToTileX(lon, zoom) - tx0) * TILE_PX - 0.5;
  }
  for (let r = 0; r < rows; r++) {
    const lat = maxLat - (r / (rows - 1)) * (maxLat - minLat);
    const py = (latToTileY(lat, zoom) - ty0) * TILE_PX - 0.5;
    for (let c = 0; c < cols; c++) elevM[r * cols + c] = sample(colPx[c], py);
  }

  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  return {
    cols,
    rows,
    bbox,
    elevM,
    cellXM: ((maxLon - minLon) / (cols - 1)) * 111320 * Math.cos(midLat),
    cellYM: ((maxLat - minLat) / (rows - 1)) * 110570,
  };
}
