// Builds apps/web/public/data/kelantan.json from Workstream C's committed data (scripts/data/**):
//   - villages / towns and candidate evacuation centres (OpenStreetMap, via C's load-places cache)
//   - Dec 2014 daily rainfall (Open-Meteo historical) and river discharge (GloFAS)
// Run: node apps/web/scripts/build-real-data.mjs   (no network, no database)
import { readFileSync, writeFileSync } from 'node:fs';
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
};
writeFileSync(fileURLToPath(new URL('../public/data/kelantan.json', import.meta.url)), JSON.stringify(out));
console.log(`villages ${villages.length}, centres ${centres.length}, rain points ${rain.length}, discharge cells ${discharge.length}`);
