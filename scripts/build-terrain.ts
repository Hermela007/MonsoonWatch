// `pnpm build:terrain` — elevation for the region from AWS Terrain Tiles (Terrarium PNGs, z11).
//   in:  https://s3.amazonaws.com/elevation-tiles-prod/terrarium/11/{x}/{y}.png
//        elevation_m = R·256 + G + B/256 − 32768 (Web Mercator tiles, ~76 m/px at z11 here)
//        tiles cached in scripts/data/terrain/tiles/ (git-ignored; outputs below are committed)
//   out: 1. apps/web/public/terrain/<region>.png — heightmap for the 3D scene (A), ~150 m/px.
//           Encoding = Terrarium: elevation_m = R·256 + G + B/256 − 32768 (lossless, 1/256 m steps).
//           Regular lon/lat grid over Region.bbox (NOT Mercator): pixel (col,row) centre is
//           lon = minLon + (col+0.5)·(maxLon−minLon)/width, lat = maxLat − (row+0.5)·(maxLat−minLat)/height.
//        2. apps/api/data/terrain/<region>.elev.{json,i16.gz} — 75 m grid for the hazards model
//           (format in apps/api/src/hazards/terrain.ts; Int16 whole metres).
//        3. Region.terrain in scripts/data/regions/<region>.json, then upserted like `pnpm seed:region`.
// Why z11: native ~76 m/px matches a 75 m model grid; z12 would quadruple tiles and file sizes for
// detail the SRTM-derived data (several metres vertical error) can't really support.
// Offline: pnpm build:terrain --from-cache
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { COLLECTIONS, type Region } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";

const Z = 11;
const GRID_M = 75; // API grid resolution
const HEIGHTMAP_M = 150; // web heightmap resolution
const NODATA = -32768;
// The tiles have a few voids (values down to −1,820 m inland). The sea off Kelantan is shallow, so
// anything below this is treated as a void and filled from neighbouring pixels.
const VOID_BELOW_M = -50;
const fromCache = process.argv.includes("--from-cache");
const tileDir = fileURLToPath(new URL("./data/terrain/tiles/", import.meta.url));
const webDir = fileURLToPath(new URL("../apps/web/public/terrain/", import.meta.url));
const apiDir = fileURLToPath(new URL("../apps/api/data/terrain/", import.meta.url));
const regionDir = fileURLToPath(new URL("./data/regions/", import.meta.url));

const lonToX = (lon: number) => ((lon + 180) / 360) * 2 ** Z * 256;
const latToY = (lat: number) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** Z * 256;

async function tile(x: number, y: number): Promise<PNG> {
  const file = `${tileDir}${Z}_${x}_${y}.png`;
  if (!existsSync(file)) {
    if (fromCache) throw new Error(`tile ${Z}/${x}/${y} not cached`);
    const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`tile ${Z}/${x}/${y}: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return PNG.sync.read(readFileSync(file));
}

try {
  mkdirSync(tileDir, { recursive: true });
  mkdirSync(webDir, { recursive: true });
  mkdirSync(apiDir, { recursive: true });
  const db = await getDb();
  const region = await db.collection<Region>(COLLECTIONS.regions).findOne({ _id: env.regionId });
  if (!region) throw new Error(`Region "${env.regionId}" not found — run \`pnpm seed:region\` first.`);
  const [minLon, minLat, maxLon, maxLat] = region.bbox;

  // 1. Tiles covering the bbox → one Mercator mosaic of elevations
  const tx0 = Math.floor(lonToX(minLon) / 256), tx1 = Math.floor(lonToX(maxLon) / 256);
  const ty0 = Math.floor(latToY(maxLat) / 256), ty1 = Math.floor(latToY(minLat) / 256);
  const mw = (tx1 - tx0 + 1) * 256, mh = (ty1 - ty0 + 1) * 256;
  const mosaic = new Float32Array(mw * mh);
  let fetched = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const png = await tile(tx, ty);
      fetched++;
      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const i = (py * 256 + px) * 4;
          const elev = png.data[i]! * 256 + png.data[i + 1]! + png.data[i + 2]! / 256 - 32768;
          mosaic[((ty - ty0) * 256 + py) * mw + (tx - tx0) * 256 + px] = elev;
        }
      }
    }
  }
  console.log(`tiles: ${fetched} at z${Z} (x ${tx0}–${tx1}, y ${ty0}–${ty1})`);

  // Bilinear sample of the mosaic at a lon/lat
  const sample = (lon: number, lat: number) => {
    const fx = lonToX(lon) - tx0 * 256 - 0.5, fy = latToY(lat) - ty0 * 256 - 0.5;
    const x0 = Math.max(0, Math.min(mw - 2, Math.floor(fx))), y0 = Math.max(0, Math.min(mh - 2, Math.floor(fy)));
    const ax = Math.max(0, Math.min(1, fx - x0)), ay = Math.max(0, Math.min(1, fy - y0));
    const v = (x: number, y: number) => mosaic[y * mw + x]!;
    return (v(x0, y0) * (1 - ax) + v(x0 + 1, y0) * ax) * (1 - ay) + (v(x0, y0 + 1) * (1 - ax) + v(x0 + 1, y0 + 1) * ax) * ay;
  };

  // Square-ish pixels in metres at the bbox's middle latitude
  const midLat = (minLat + maxLat) / 2;
  const grid = (metres: number) => {
    const dLat = metres / 111_320, dLon = metres / (111_320 * Math.cos((midLat * Math.PI) / 180));
    const width = Math.round((maxLon - minLon) / dLon), height = Math.round((maxLat - minLat) / dLat);
    return { width, height, dLon: (maxLon - minLon) / width, dLat: (maxLat - minLat) / height };
  };

  // Fill voids in the mosaic: repeatedly average valid 8-neighbours until none are left.
  let voids = 0;
  for (let i = 0; i < mosaic.length; i++) if (!(mosaic[i]! >= VOID_BELOW_M)) { mosaic[i] = NaN; voids++; }
  for (let pass = 0, left = voids; left > 0 && pass < 50; pass++) {
    left = 0;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      if (!Number.isNaN(mosaic[y * mw + x]!)) continue;
      let sum = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = mosaic[(y + dy) * mw + x + dx];
        if (y + dy >= 0 && y + dy < mh && x + dx >= 0 && x + dx < mw && v !== undefined && !Number.isNaN(v)) { sum += v; n++; }
      }
      if (n) mosaic[y * mw + x] = sum / n; else left++;
    }
  }
  console.log(`voids filled: ${voids} px (< ${VOID_BELOW_M} m)`);

  // 2. API grid (75 m, Int16 whole metres: the source is SRTM-derived, so finer steps would only store
  //    interpolation noise and make the file ~50% bigger)
  const g = grid(GRID_M);
  const data = Buffer.alloc(g.width * g.height * 2);
  let minElev = Infinity, maxElev = -Infinity;
  for (let row = 0; row < g.height; row++) {
    const lat = maxLat - (row + 0.5) * g.dLat;
    for (let col = 0; col < g.width; col++) {
      const e = sample(minLon + (col + 0.5) * g.dLon, lat);
      const m = Number.isFinite(e) ? Math.max(-32767, Math.min(32767, Math.round(e))) : NODATA;
      data.writeInt16LE(m, (row * g.width + col) * 2);
      if (m !== NODATA) { minElev = Math.min(minElev, m); maxElev = Math.max(maxElev, m); }
    }
  }
  const header = {
    regionId: env.regionId, bbox: region.bbox, width: g.width, height: g.height, dLon: g.dLon, dLat: g.dLat,
    metresPerPx: GRID_M, scale: 1, nodata: NODATA, minElev, maxElev,
    source: `AWS Terrain Tiles (Terrarium) z${Z}, resampled to a ${GRID_M} m lon/lat grid`,
  };
  const gz = gzipSync(data, { level: 9 });
  writeFileSync(`${apiDir}${env.regionId}.elev.i16.gz`, gz);
  writeFileSync(`${apiDir}${env.regionId}.elev.json`, JSON.stringify(header, null, 2) + "\n");
  console.log(`grid: ${g.width}×${g.height} @ ${GRID_M} m → ${(gz.length / 1e6).toFixed(2)} MB gz; elevation ${minElev}…${maxElev} m`);

  // 3. Web heightmap (150 m, Terrarium RGB)
  const h = grid(HEIGHTMAP_M);
  const png = new PNG({ width: h.width, height: h.height, colorType: 2 });
  for (let row = 0; row < h.height; row++) {
    const lat = maxLat - (row + 0.5) * h.dLat;
    for (let col = 0; col < h.width; col++) {
      const v = Math.max(0, sample(minLon + (col + 0.5) * h.dLon, lat) + 32768);
      const i = (row * h.width + col) * 4;
      png.data[i] = Math.floor(v / 256);
      png.data[i + 1] = Math.floor(v) % 256;
      png.data[i + 2] = Math.floor((v - Math.floor(v)) * 256);
      png.data[i + 3] = 255;
    }
  }
  const pngBuf = PNG.sync.write(png, { colorType: 2 });
  writeFileSync(`${webDir}${env.regionId}.png`, pngBuf);
  console.log(`heightmap: ${h.width}×${h.height} @ ${HEIGHTMAP_M} m → ${(pngBuf.length / 1e6).toFixed(2)} MB (apps/web/public/terrain/${env.regionId}.png)`);

  // 4. Region.terrain — patch the JSON's terrain block in place (keeps the file's formatting), then upsert
  const terrain = {
    heightmapUrl: `/terrain/${env.regionId}.png`,
    widthPx: h.width,
    heightPx: h.height,
    metresPerPx: HEIGHTMAP_M,
    minElev: Math.floor(minElev),
    maxElev: Math.ceil(maxElev),
    encoding: "terrarium: elevation_m = R*256 + G + B/256 - 32768; regular lon/lat grid over bbox, row 0 = north, pixel centres",
  };
  const regionFile = `${regionDir}${env.regionId}.json`;
  const text = readFileSync(regionFile, "utf8");
  const block = `"terrain": ${JSON.stringify(terrain, null, 2).replace(/\n/g, "\n  ")}`;
  const patched = text.replace(/"terrain":\s*\{[^}]*\}/, block);
  if (patched === text && !text.includes(block)) throw new Error(`Could not find the "terrain" block in ${regionFile}`);
  writeFileSync(regionFile, patched);
  await db.collection<Region>(COLLECTIONS.regions).updateOne({ _id: env.regionId }, { $set: { terrain } });
  console.log(`Region.terrain updated: ${JSON.stringify(terrain)}`);

  // 5. Spot checks
  const at = (lon: number, lat: number) => {
    const fx = Math.floor((lon - minLon) / g.dLon), fy = Math.floor((maxLat - lat) / g.dLat);
    return data.readInt16LE((fy * g.width + fx) * 2);
  };
  console.log(`spot: Kota Bharu (102.239, 6.125) = ${at(102.2386, 6.1254)} m`);
  console.log(`spot: Gua Musang town (101.969, 4.882) = ${at(101.9686, 4.8823)} m`);
  console.log(`spot: Kuala Krai (102.201, 5.531) = ${at(102.2011, 5.5309)} m`);
  let peak = { e: -Infinity, lon: 0, lat: 0 };
  for (let lat = 4.62; lat <= 4.95; lat += 0.002) for (let lon = 102.4; lon <= 102.649; lon += 0.002) { const e = at(lon, lat); if (e > peak.e) peak = { e, lon, lat }; }
  console.log(`spot: Gunung Gagau area (4.62–4.95 N, 102.40–102.65 E) max = ${peak.e} m at (${peak.lon.toFixed(3)}, ${peak.lat.toFixed(3)})`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
