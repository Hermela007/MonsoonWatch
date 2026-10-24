import type { BBox } from '../geo/region';
import { cleanInlandLows } from './terrarium';
import { sampleField, type Heightmap } from './heightmap';

/** Local, same-origin asset: no external terrain requests during startup. */
export async function loadBakedTerrain(bbox: BBox, cols: number, rows: number): Promise<Heightmap> {
  const manifestRes = await fetch('/terrain/kelantan-scene.json');
  if (!manifestRes.ok) throw new Error('Baked terrain manifest missing');
  const manifest = await manifestRes.json() as { bbox: BBox; cols: number; rows: number; url: string };
  if (manifest.bbox.some((n, i) => Math.abs(n - bbox[i]) > 1e-6)) throw new Error('Baked terrain bounds do not match the scene');
  const res = await fetch(manifest.url);
  if (!res.ok) throw new Error('Baked terrain image missing');
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width; canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(bitmap, 0, 0); bitmap.close();
  if (canvas.width !== manifest.cols || canvas.height !== manifest.rows) throw new Error('Baked terrain dimensions do not match');
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const source = new Float32Array(manifest.cols * manifest.rows);
  for (let i = 0; i < source.length; i++) source[i] = pixels[i * 4] * 256 + pixels[i * 4 + 1] + pixels[i * 4 + 2] / 256 - 32768;
  const elevM = new Float32Array(cols * rows);
  const original = { cols: manifest.cols, rows: manifest.rows } as Heightmap;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) elevM[r * cols + c] = sampleField(original, source, c / (cols - 1) * (manifest.cols - 1), r / (rows - 1) * (manifest.rows - 1));
  cleanInlandLows(elevM, cols, rows);
  return { bbox, cols, rows, elevM, cellXM: (bbox[2] - bbox[0]) / (cols - 1) * 111320 * Math.cos((bbox[1] + bbox[3]) / 2 * Math.PI / 180), cellYM: (bbox[3] - bbox[1]) / (rows - 1) * 110570 };
}
