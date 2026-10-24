// Bake the frontend's full-state bounds without changing C's model or database.
// Run once with network; the resulting PNG and manifest ship with the app.
import { PNG } from '../../../scripts/node_modules/pngjs/lib/png.js';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const bbox = [101.3, 4.53, 102.7, 6.27], z = 10, cols = 600;
const rows = Math.round(cols * (bbox[3] - bbox[1]) * 110.57 / ((bbox[2] - bbox[0]) * 111.32 * Math.cos((bbox[1] + bbox[3]) / 2 * Math.PI / 180)));
const tileX = lon => (lon + 180) / 360 * 2 ** z;
const tileY = lat => (1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z;
const cache = '/private/tmp/monsoonwatch-terrain';
mkdirSync(cache, { recursive: true });
const tiles = new Map();
for (let y = Math.floor(tileY(bbox[3])); y <= Math.floor(tileY(bbox[1])); y++) {
  for (let x = Math.floor(tileX(bbox[0])); x <= Math.floor(tileX(bbox[2])); x++) {
    const file = `${cache}/${z}-${x}-${y}.png`;
    if (!existsSync(file)) {
      const res = await fetch(`https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Tile ${x}/${y}: ${res.status}`);
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    }
    tiles.set(`${x},${y}`, PNG.sync.read(readFileSync(file)));
  }
}
function pixel(x, y) {
  const tile = tiles.get(`${Math.floor(x / 256)},${Math.floor(y / 256)}`);
  if (!tile) throw new Error('Tile outside bake bounds');
  const i = ((y % 256) * 256 + x % 256) * 4;
  return tile.data[i] * 256 + tile.data[i + 1] + tile.data[i + 2] / 256 - 32768;
}
const png = new PNG({ width: cols, height: rows });
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const lon = bbox[0] + c / (cols - 1) * (bbox[2] - bbox[0]);
  const lat = bbox[3] - r / (rows - 1) * (bbox[3] - bbox[1]);
  const x = tileX(lon) * 256 - .5, y = tileY(lat) * 256 - .5;
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const e = (pixel(ix, iy) * (1 - fx) + pixel(ix + 1, iy) * fx) * (1 - fy) + (pixel(ix, iy + 1) * (1 - fx) + pixel(ix + 1, iy + 1) * fx) * fy + 32768;
  const i = (r * cols + c) * 4;
  png.data[i] = Math.floor(e / 256); png.data[i + 1] = Math.floor(e) % 256; png.data[i + 2] = Math.floor((e % 1) * 256); png.data[i + 3] = 255;
}
const dir = new URL('../public/terrain/', import.meta.url);
writeFileSync(new URL('kelantan-scene.png', dir), PNG.sync.write(png));
writeFileSync(new URL('kelantan-scene.json', dir), JSON.stringify({ bbox, cols, rows, url: '/terrain/kelantan-scene.png', source: 'AWS Terrarium z10; bilinear samples at grid nodes; row 0 north' }, null, 2) + '\n');
console.log(`Baked ${cols} × ${rows} full-state terrain from ${tiles.size} tiles`);
