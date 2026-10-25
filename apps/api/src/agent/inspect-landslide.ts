// Diagnostic, NO Gemini: what rain the landslide screen sees in the 2014 replay, day by day, and
// what it produces (runout levels, nearest village). Read-only.
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/inspect-landslide.ts
//   … --from=2014-12-16 --to=2014-12-28 --mode=replay
import { COLLECTIONS, type Village } from "@monsoonwatch/shared";
import { closeDb, getDb } from "../db/client";
import { env } from "../env";
import { loadElevationGrid } from "../hazards/terrain";
import { pointToLineKm } from "./geo";
import { levelFromRisk, loadLandslideConfig, rainLevel, rainOverDays, screenLandslides } from "./landslide";
import { rainAt } from "./landslide-provider";

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const mode = (arg("mode") ?? "replay") as "live" | "replay";
const from = new Date(`${arg("from") ?? "2014-12-16"}T12:00:00+08:00`);
const to = new Date(`${arg("to") ?? "2014-12-28"}T12:00:00+08:00`);
const regionId = arg("region") ?? env.regionId;

try {
  const grid = loadElevationGrid(regionId);
  const cfg = loadLandslideConfig(regionId);
  const villages = await (await getDb()).collection<Village>(COLLECTIONS.villages).find({ regionId }, { projection: { name: 1, location: 1 } }).toArray();
  console.log(`Landslide screen · ${regionId} · ${mode} · thresholds: ${cfg.levels.map((l) => `${l.level} ${l.mm} mm/${l.days} d`).join(", ")} · slope ≥ ${cfg.slopeMinDeg}°`);
  const rows: Record<string, unknown>[] = [];
  for (let t = from.getTime(); t <= to.getTime(); t += 24 * 3600 * 1000) {
    const ts = new Date(t);
    const rain = await rainAt(regionId, ts, mode);
    const d1 = rain.map((p) => rainOverDays(p, 1)), d3 = rain.map((p) => rainOverDays(p, 3));
    const lv = rain.map((p) => rainLevel(p, cfg)?.level ?? "none");
    const { landslide } = screenLandslides(grid, rain, cfg, { focus: villages.map((v) => v.location.coordinates) });
    const byLevel = landslide.runouts.reduce<Record<string, number>>((m, r) => ((m[levelFromRisk(r.risk)] = (m[levelFromRisk(r.risk)] ?? 0) + 1), m), {});
    const nearest = Math.min(...villages.flatMap((v) => landslide.runouts.map((r) => pointToLineKm(v.location.coordinates, r.coordinates))));
    rows.push({
      day: ts.toISOString().slice(0, 10), stations: rain.length,
      max1dMm: d1.length ? Math.max(...d1) : null, max3dMm: d3.length ? Math.max(...d3) : null,
      stationsAlert: lv.filter((x) => x === "alert").length, stationsWarning: lv.filter((x) => x === "warning").length, stationsDanger: lv.filter((x) => x === "danger").length,
      runouts: landslide.runouts.length, runoutLevels: JSON.stringify(byLevel), nearestVillageKm: Number.isFinite(nearest) ? Math.round(nearest * 10) / 10 : null,
      villagesWithin1km: villages.filter((v) => landslide.runouts.some((r) => pointToLineKm(v.location.coordinates, r.coordinates) <= 1)).length,
    });
  }
  console.table(rows);
} finally {
  await closeDb();
}
