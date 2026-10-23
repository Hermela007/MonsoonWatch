// `pnpm jps:snapshot` — saves the current JPS river + rain pages to scripts/data/jps/
// (used to write/test the parser, and as an offline fallback if JPS is down).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchJpsHtml, type JpsKind } from "./lib/jps";

const dir = fileURLToPath(new URL("./data/jps/", import.meta.url));

for (const kind of ["river", "rain"] as JpsKind[]) {
  try {
    const html = await fetchJpsHtml(kind);
    writeFileSync(`${dir}${kind}.latest.html`, html);
    console.log(`✅ ${kind}: saved ${(html.length / 1024).toFixed(0)} KB → scripts/data/jps/${kind}.latest.html`);
  } catch (err) {
    console.error(`❌ ${kind}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
}
