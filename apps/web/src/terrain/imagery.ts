import type { BBox } from '../geo/region';

// Sentinel-2 cloudless 2021 by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2021), CC BY-NC-SA 4.0.
// WMTS REST order is {z}/{row}/{col}. Should be cached server-side (Workstream C) before the final demo.
const URL = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible';
export const IMAGERY_CREDIT = 'Sentinel-2 cloudless 2021 by EOX (Copernicus Sentinel data)';
const TILE = 256;

const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const latToY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
};

async function loadTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(`${URL}/${z}/${y}/${x}.jpg`);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/** Satellite image of `bbox`, resampled to a lon/lat-linear canvas (row 0 = north) to match the heightmap grid. */
export async function loadImagery(bbox: BBox, zoom: number, outW: number, outH: number): Promise<HTMLCanvasElement | null> {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const x0 = Math.floor(lonToX(minLon, zoom));
  const x1 = Math.floor(lonToX(maxLon, zoom));
  const y0 = Math.floor(latToY(maxLat, zoom));
  const y1 = Math.floor(latToY(minLat, zoom));
  const mosaic = document.createElement('canvas');
  mosaic.width = (x1 - x0 + 1) * TILE;
  mosaic.height = (y1 - y0 + 1) * TILE;
  const mctx = mosaic.getContext('2d')!;
  const jobs: Promise<boolean>[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      jobs.push(
        loadTile(zoom, x, y).then((bmp) => {
          if (!bmp) return false;
          mctx.drawImage(bmp, (x - x0) * TILE, (y - y0) * TILE);
          bmp.close();
          return true;
        }),
      );
    }
  }
  const ok = (await Promise.all(jobs)).filter(Boolean).length;
  if (ok < jobs.length * 0.8) return null;

  // Longitude is linear in Web Mercator x; resample latitude row by row.
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const octx = out.getContext('2d')!;
  const sx = (lonToX(minLon, zoom) - x0) * TILE;
  const sw = (lonToX(maxLon, zoom) - x0) * TILE - sx;
  for (let r = 0; r < outH; r++) {
    const lat = maxLat - ((r + 0.5) / outH) * (maxLat - minLat);
    const sy = (latToY(lat, zoom) - y0) * TILE;
    octx.drawImage(mosaic, sx, sy, sw, 1, 0, r, outW, 1);
  }
  return out;
}
