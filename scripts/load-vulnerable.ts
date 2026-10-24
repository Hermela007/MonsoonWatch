// `pnpm load:vulnerable` — sets Village.vulnerable (counts only, §1.7 decision 3) for every village
// in the region from the rates in scripts/data/vulnerable/rates.json (each with its source),
// plus clearly-labelled demo-scenario values from demo-scenario.json.
// Run AFTER `pnpm load:places` (which recreates villages). Safe to re-run.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COLLECTIONS, type Village, type VulnerableCategory, type VulnerableCounts } from "@monsoonwatch/shared";
import { closeDb, getDb } from "@monsoonwatch/api/db";
import { env } from "@monsoonwatch/api/env";

const dir = fileURLToPath(new URL("./data/vulnerable/", import.meta.url));
type Rate = { rate: number; official: boolean; label: string };
const rates = JSON.parse(readFileSync(`${dir}rates.json`, "utf8")) as Record<VulnerableCategory, Rate>;
const demo = JSON.parse(readFileSync(`${dir}demo-scenario.json`, "utf8")) as Record<string, Partial<Record<VulnerableCategory, number>> & { name?: string }>;
const CATEGORIES: VulnerableCategory[] = ["bedridden", "disabled", "elderly", "noTransport"];

try {
  const db = await getDb();
  const villages = db.collection<Village>(COLLECTIONS.villages);
  const all = await villages.find({ regionId: env.regionId }, { projection: { name: 1, population: 1 } }).toArray();
  if (all.length === 0) throw new Error("No villages — run `pnpm load:places` first.");

  const baseSource = CATEGORIES.filter((c) => rates[c].rate > 0).map((c) => rates[c].label).join("; ");
  let demoCount = 0;
  const ops = all.map((v) => {
    const counts = Object.fromEntries(CATEGORIES.map((c) => [c, Math.round(v.population * rates[c].rate)])) as Record<VulnerableCategory, number>;
    const d = demo[v._id];
    let source = `Estimated from population × rates. ${baseSource}. ${rates.bedridden.label}.`;
    if (d) {
      demoCount++;
      for (const c of CATEGORIES) if (typeof d[c] === "number") counts[c] = d[c]!;
      source += ` DEMO SCENARIO: ${CATEGORIES.filter((c) => typeof d[c] === "number").join(", ")} set for the demo (illustrative, not real data).`;
    }
    const vulnerable: VulnerableCounts = { ...counts, source, estimated: true };
    return { updateOne: { filter: { _id: v._id }, update: { $set: { vulnerable } } } };
  });
  await villages.bulkWrite(ops, { ordered: false });

  const missingDemo = Object.keys(demo).filter((id) => !id.startsWith("_") && !all.some((v) => v._id === id));
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<VulnerableCategory, number>;
  const after = await villages.find({ regionId: env.regionId }, { projection: { vulnerable: 1 } }).toArray();
  for (const v of after) for (const c of CATEGORIES) totals[c] += v.vulnerable?.[c] ?? 0;
  console.log(`✅ vulnerable counts set on ${all.length} villages (${demoCount} demo-scenario). Totals: ${CATEGORIES.map((c) => `${c} ${totals[c]}`).join(", ")}`);
  for (const id of Object.keys(demo).filter((k) => !k.startsWith("_"))) {
    const v = after.find((x) => x._id === id);
    if (v) console.log(`   demo: ${demo[id]!.name ?? id} → ${CATEGORIES.map((c) => `${c} ${v.vulnerable?.[c]}`).join(", ")}`);
  }
  if (missingDemo.length) console.warn(`⚠️  demo-scenario ids not found: ${missingDemo.join(", ")}`);
} catch (err) {
  console.error(`❌ ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
