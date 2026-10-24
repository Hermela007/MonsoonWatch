// NO Gemini calls. Loads the real situation from MongoDB at a moment and prints what the agent
// would see: risk events, flooded segments, landslide runouts, and routes from a village to its
// nearest centres (road vs boat). Use it to check the demo cases before spending credits.
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/inspect-situation.ts --mode=replay --at=2014-12-24T12:00:00+08:00 --village="Manek Urai"
//   … --at=2014-12-12T12:00:00+08:00   (same village, before the flood: routes should be dry)

import { closeDb } from "../db/client";
import { env } from "../env";
import { haversineKm } from "./geo";
import { buildRoadGraph, planRoute } from "./route";
import { loadSituationFromDb } from "./situation-db";
import { levelFromThresholds } from "./verify";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const mode = (arg("mode") ?? "live") as "live" | "replay";
const at = arg("at") ? new Date(arg("at")!) : new Date();
const villageQuery = arg("village")?.toLowerCase();
const regionId = arg("region") ?? env.regionId;

try {
  const t0 = Date.now();
  const s = await loadSituationFromDb(regionId, { mode, at });
  console.log(`${regionId} · ${mode} @ ${at.toISOString()} · loaded in ${Date.now() - t0} ms`);
  console.log(`stations ${s.stations.length} (${s.stations.filter((x) => x.latest).length} with a reading) · villages ${s.villages.length} · centres ${s.centres.length} · road segments ${s.roads.length}`);
  console.log(`risk events ${s.riskEvents.length}: ${Object.entries(s.riskEvents.reduce<Record<string, number>>((m, e) => ((m[`${e.type}/${e.level}`] = (m[`${e.type}/${e.level}`] ?? 0) + 1), m), {})).map(([k, n]) => `${k}×${n}`).join(", ") || "none"}`);
  console.log(`flooded road segments ${s.hazards.blockedRoadIds.length} · landslide cells ${s.hazards.landslide.cells.length}, runouts ${s.hazards.landslide.runouts.length}`);
  for (const e of s.riskEvents.filter((x) => x.type === "landslide_screen").slice(0, 5)) console.log(`  ⛰ ${e.message}`);
  const rivers = s.stations
    .filter((st) => st.kind === "river" && st.thresholds && st.latest)
    .map((st) => ({ st, level: levelFromThresholds(st.latest!.value, st.thresholds!) }))
    .filter((r) => r.level !== "normal");
  console.log(`river gauges at alert or above: ${rivers.length} (warning+ ${rivers.filter((r) => r.level !== "alert").length})`);
  for (const r of rivers.sort((x, y) => y.st.latest!.value - y.st.thresholds!.danger - (x.st.latest!.value - x.st.thresholds!.danger)).slice(0, 5)) {
    console.log(`  🌊 ${r.st.name}: ${r.st.latest!.value} m → ${r.level.toUpperCase()} (danger ${r.st.thresholds!.danger} m)`);
  }
  const withVulnerable = s.villages.filter((v) => v.vulnerable).length;
  console.log(`villages with vulnerable counts: ${withVulnerable}/${s.villages.length}`);

  if (villageQuery) {
    const v = s.villages.find((x) => x.name.toLowerCase().includes(villageQuery) || x.altNames.some((n) => n.toLowerCase().includes(villageQuery)));
    if (!v) throw new Error(`No village matching "${villageQuery}"`);
    console.log(`\n${v.name} (${v._id}) · population ${v.population} · vulnerable ${JSON.stringify(v.vulnerable ?? null)}`);
    const graph = buildRoadGraph(s.roads);
    const nearest = [...s.centres]
      .map((c) => ({ c, km: haversineKm(v.location.coordinates, c.location.coordinates) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, 5);
    for (const { c, km } of nearest) {
      const road = planRoute(graph, s.hazards.blockedRoadIds, v.location.coordinates, c.location.coordinates, "road");
      const boat = road.found ? null : planRoute(graph, s.hazards.blockedRoadIds, v.location.coordinates, c.location.coordinates, "boat");
      console.log(`  → ${c.name} (${km.toFixed(1)} km away, ${c.capacity - c.headcount} free): ` +
        (road.found ? `dry road ${road.lengthKm} km` : `NO dry road — ${road.note}${boat?.found ? `; boat ${boat.lengthKm} km` : ""}`));
    }
  }
} finally {
  await closeDb();
}
