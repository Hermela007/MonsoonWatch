// Small helpers for OpenStreetMap (Overpass) and Open-Meteo elevation, with on-disk caching
// so the demo never depends on these services being up.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const UA = "MonsoonWatch/0.1 (Encode London 2026 hackathon; flood early warning)";

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Run an Overpass query, caching the raw JSON at `cacheFile`. With `fromCache`, never hits the network. */
export async function overpass(query: string, cacheFile: string, fromCache = false): Promise<OsmElement[]> {
  if (!fromCache) {
    try {
      const res = await fetch(OVERPASS_URL, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const text = await res.text();
      writeFileSync(cacheFile, text);
      return (JSON.parse(text) as { elements: OsmElement[] }).elements;
    } catch (err) {
      console.warn(`⚠️  Overpass failed (${err instanceof Error ? err.message : err}) — trying cache`);
    }
  }
  if (!existsSync(cacheFile)) throw new Error(`No cached Overpass result at ${cacheFile}`);
  return (JSON.parse(readFileSync(cacheFile, "utf8")) as { elements: OsmElement[] }).elements;
}

/** Ground elevation (m) for many points via the Open-Meteo elevation API (Copernicus 90 m DEM), cached by "lat,lon". */
export async function elevations(points: { lat: number; lon: number }[], cacheFile: string, fromCache = false): Promise<(number | null)[]> {
  const cache: Record<string, number | null> = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, "utf8")) : {};
  const key = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
  const missing = [...new Map(points.filter((p) => !(key(p) in cache)).map((p) => [key(p), p])).values()];
  if (!fromCache) {
    for (let i = 0; i < missing.length; i += 100) {
      const batch = missing.slice(i, i + 100);
      const url = `https://api.open-meteo.com/v1/elevation?latitude=${batch.map((p) => p.lat.toFixed(5)).join(",")}&longitude=${batch.map((p) => p.lon.toFixed(5)).join(",")}`;
      let done = false;
      for (let attempt = 1; attempt <= 4 && !done; attempt++) {
        try {
          const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
          if (res.status === 429) {
            // Free tier counts each location; wait for the per-minute window to reset.
            console.log(`   elevation: rate-limited, waiting 65 s (batch ${i / 100 + 1}/${Math.ceil(missing.length / 100)}, attempt ${attempt})`);
            writeFileSync(cacheFile, JSON.stringify(cache));
            await new Promise((r) => setTimeout(r, 65_000));
            continue;
          }
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const { elevation } = (await res.json()) as { elevation: (number | null)[] };
          batch.forEach((p, j) => (cache[key(p)] = elevation[j] ?? null));
          done = true;
        } catch (err) {
          console.warn(`⚠️  elevation batch ${i / 100 + 1} failed (${err instanceof Error ? err.message : err})`);
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return points.map((p) => cache[key(p)] ?? null);
}
