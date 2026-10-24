// Builds apps/web/public/data/kelantan.json from Workstream C's committed data (scripts/data/**):
//   - villages / towns and candidate evacuation centres (OpenStreetMap, via C's load-places cache)
//   - Dec 2014 daily rainfall (Open-Meteo historical) and river discharge (GloFAS)
// Run: node apps/web/scripts/build-real-data.mjs   (no network, no database)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const data = (p) => JSON.parse(readFileSync(`${root}scripts/data/${p}`, 'utf8'));
const r6 = (n) => Math.round(n * 1e6) / 1e6;

// Same capacity estimates as C's load-places.ts (Malaysia opens schools and halls as relief centres).
const CAPACITY_ESTIMATE = { school: 400, community_centre: 150, townhall: 200 };

const places = data('osm/places.kelantan.json').elements;
const villages = [];
const centres = [];
for (const e of places) {
  const t = e.tags ?? {};
  const lat = e.lat ?? e.center?.lat;
  const lon = e.lon ?? e.center?.lon;
  if (lat == null || lon == null || !t.name) continue;
  if (t.place && ['city', 'town', 'village', 'hamlet'].includes(t.place)) {
    villages.push({ name: t.name, lngLat: [r6(lon), r6(lat)], kind: t.place });
  } else if (t.amenity && CAPACITY_ESTIMATE[t.amenity]) {
    centres.push({ name: t.name, lngLat: [r6(lon), r6(lat)], kind: t.amenity, capacityEstimate: CAPACITY_ESTIMATE[t.amenity] });
  }
}
const rank = { city: 0, town: 1, village: 2, hamlet: 3 };
villages.sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name));

const rain = data('replay-2014/openmeteo-rain.json').map((p) => ({
  lngLat: [r6(p.longitude), r6(p.latitude)],
  dailyMm: p.daily.precipitation_sum.map((x) => x ?? 0),
}));
const rainStart = data('replay-2014/openmeteo-rain.json')[0].daily.time[0];
const discharge = data('replay-2014/glofas-discharge.json').map((p) => ({
  lngLat: [r6(p.longitude), r6(p.latitude)],
  dailyM3s: p.daily.river_discharge,
}));
const dischargeStart = data('replay-2014/glofas-discharge.json')[0].daily.time[0];

// Main named rivers (OSM waterway=river) for drawing and labels: the longest few in the region.
const geo = JSON.parse(gunzipSync(readFileSync(`${root}scripts/data/osm/geo.kelantan.json.gz`)).toString('utf8')).elements;
const nodes = new Map();
for (const e of geo) if (e.type === 'node') nodes.set(e.id, [r6(e.lon), r6(e.lat)]);
const byName = new Map();
const lenKm = (line) => line.slice(1).reduce((s, p, i) => s + Math.hypot((p[0] - line[i][0]) * 110.9, (p[1] - line[i][1]) * 110.6), 0);
for (const e of geo) {
  if (e.type !== 'way' || e.tags?.waterway !== 'river' || !e.tags?.name) continue;
  const line = (e.nodes ?? []).map((n) => nodes.get(n)).filter(Boolean);
  if (line.length < 2) continue;
  const r = byName.get(e.tags.name) ?? { name: e.tags.name, lines: [], km: 0 };
  r.lines.push(line.filter((_, k) => k % 3 === 0 || k === line.length - 1));
  r.km += lenKm(line);
  byName.set(e.tags.name, r);
}
const rivers = [...byName.values()].sort((a, b) => b.km - a.km).slice(0, 10).map((r) => ({ name: r.name, km: Math.round(r.km), lines: r.lines }));

// Peak of the real 2014 discharge on the main channel (for the headline).
const mainCell = discharge.filter((c) => Math.max(...c.dailyM3s) > 1000).sort((a, b) => Math.hypot(a.lngLat[0] - 102.2, a.lngLat[1] - 5.53) - Math.hypot(b.lngLat[0] - 102.2, b.lngLat[1] - 5.53))[0];
const peakIdx = mainCell.dailyM3s.indexOf(Math.max(...mainCell.dailyM3s));
const peak = { m3s: Math.round(mainCell.dailyM3s[peakIdx]), date: new Date(Date.parse(`${dischargeStart}T00:00:00Z`) + peakIdx * 86400000).toISOString().slice(0, 10) };

const out = {
  source: {
    places: 'OpenStreetMap contributors (ODbL), via Workstream C scripts/data/osm/places.kelantan.json',
    rain: 'Open-Meteo historical weather API (daily precipitation), via scripts/data/replay-2014/openmeteo-rain.json',
    discharge: 'GloFAS river discharge (Copernicus), via scripts/data/replay-2014/glofas-discharge.json',
  },
  villages,
  centres,
  rain: { start: rainStart, points: rain },
  discharge: { start: dischargeStart, cells: discharge },
  rivers,
  peak,
};
writeFileSync(fileURLToPath(new URL('../public/data/kelantan.json', import.meta.url)), JSON.stringify(out));
console.log(`villages ${villages.length}, centres ${centres.length}, rain points ${rain.length}, discharge cells ${discharge.length}, rivers ${rivers.map((r) => r.name + ' ' + r.km + 'km').join(', ')}, peak ${peak.m3s} m3/s on ${peak.date}`);

// Peninsular Malaysia state outlines (geoBoundaries gbOpen MYS ADM1, CC BY 4.0) for the opening zoom
// and locator map. Pass the downloaded file: node build-real-data.mjs <geoBoundaries-MYS-ADM1_simplified.geojson>
const gbPath = process.argv[2];
if (gbPath && existsSync(gbPath)) {
  const gb = JSON.parse(readFileSync(gbPath, 'utf8'));
  const r4 = (n) => Math.round(n * 1e4) / 1e4;
  const states = gb.features
    .filter((f) => !['Sabah', 'Sarawak', 'Labuan'].includes(f.properties.shapeName))
    .map((f) => {
      const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      return {
        name: f.properties.shapeName,
        polygons: polys
          .map((poly) => poly[0].filter((_, k) => k % 2 === 0).map(([x, y]) => [r4(x), r4(y)]))
          .filter((ring) => ring.length > 8),
      };
    });
  writeFileSync(fileURLToPath(new URL('../public/data/malaysia.json', import.meta.url)), JSON.stringify({ source: 'geoBoundaries gbOpen MYS ADM1 (CC BY 4.0)', states }));
  console.log('states', states.map((s) => s.name).join(', '));
}
