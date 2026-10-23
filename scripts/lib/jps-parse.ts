// Pure parsers for the JPS river-level and rainfall HTML tables (no I/O, easy to test).
// The HTML is malformed (missing <tr> starts, stray </tr>), so we walk every <td> in
// document order and start a new row at each "No." cell instead of trusting <tr>.
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export const JPS_MISSING = -9999;

export interface JpsRiverRow {
  stationId: string;
  generatedId: boolean; // true when JPS left Station ID blank and we hashed the name
  name: string;
  district: string;
  mainBasin: string;
  subBasin: string;
  lastUpdated: Date;
  levelM: number | null;
  thresholds: { normal: number; alert: number; warning: number; danger: number } | null;
}

export interface JpsRainRow {
  stationId: string;
  generatedId: boolean;
  name: string;
  district: string;
  lastUpdated: Date;
  dailyMm: { date: string; mm: number | null }[]; // 6 days, oldest first, date = YYYY-MM-DD (MYT)
  sinceMidnightMm: number | null;
  lastHourMm: number | null;
}

/** "24/10/2026 06:00" or "24/10/2026 06:00:00" in Malaysia time (UTC+8) → Date. */
export function parseMytDateTime(text: string): Date | null {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, d, mo, y, h, mi, s] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h! - 8, +mi!, s ? +s : 0));
}

/** "18/10/2026" → "2026-10-18" */
function ddmmyyyyToIso(text: string): string {
  const m = text.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : text.trim();
}

function num(text: string): number | null {
  const v = Number.parseFloat(text.replace(/,/g, "").trim());
  if (!Number.isFinite(v) || v <= JPS_MISSING) return null;
  return v;
}

function stationIdFor(rawId: string, name: string, kind: "WL" | "RF"): { id: string; generated: boolean } {
  const id = rawId.trim();
  if (id) return { id, generated: false };
  const hash = createHash("sha1").update(`${kind}:${name.trim().toLowerCase()}`).digest("hex").slice(0, 10);
  return { id: `gen-${kind}-${hash}`, generated: true };
}

/** Split all <td>s of the table into rows, each starting at a cell with data-th="No". */
function cellRows($: cheerio.CheerioAPI, tableSelector: string): string[][] {
  const rows: string[][] = [];
  $(`${tableSelector} td`).each((_, el) => {
    const td = $(el);
    if (td.attr("data-th") === "No") rows.push([]);
    rows.at(-1)?.push(td.text().replace(/\s+/g, " ").trim());
  });
  return rows;
}

export function parseRiverHtml(html: string): JpsRiverRow[] {
  const $ = cheerio.load(html);
  const out: JpsRiverRow[] = [];
  for (const c of cellRows($, "#normaltable1")) {
    // No, ID, Name, District, Main basin, Sub basin, Last updated, Level, Normal, Alert, Warning, Danger
    if (c.length < 12) continue;
    const lastUpdated = parseMytDateTime(c[6]!);
    if (!lastUpdated) continue;
    const { id, generated } = stationIdFor(c[1]!, c[2]!, "WL");
    const [normal, alert, warning, danger] = [num(c[8]!), num(c[9]!), num(c[10]!), num(c[11]!)];
    out.push({
      stationId: id,
      generatedId: generated,
      name: c[2]!,
      district: c[3]!,
      mainBasin: c[4]!,
      subBasin: c[5]!,
      lastUpdated,
      levelM: num(c[7]!),
      thresholds:
        normal !== null && alert !== null && warning !== null && danger !== null ? { normal, alert, warning, danger } : null,
    });
  }
  return dedupeIds(out);
}

export function parseRainHtml(html: string): JpsRainRow[] {
  const $ = cheerio.load(html);
  // Daily column dates come from the second header row, e.g. 18/10/2026 … 23/10/2026.
  const dates = $("#normaltable1 thead th")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t))
    .map(ddmmyyyyToIso);
  const out: JpsRainRow[] = [];
  for (const c of cellRows($, "#normaltable1")) {
    // No, ID, Station, District, Last updated, 6 × daily, Since midnight, Last 1 hour
    if (c.length < 13) continue;
    const lastUpdated = parseMytDateTime(c[4]!);
    if (!lastUpdated) continue;
    const { id, generated } = stationIdFor(c[1]!, c[2]!, "RF");
    out.push({
      stationId: id,
      generatedId: generated,
      name: c[2]!,
      district: c[3]!,
      lastUpdated,
      dailyMm: c.slice(5, 11).map((v, i) => ({ date: dates[i] ?? `day-${i + 1}`, mm: num(v) })),
      sinceMidnightMm: num(c[11]!),
      lastHourMm: num(c[12]!),
    });
  }
  return dedupeIds(out);
}

/** JPS occasionally lists two gauges under one Station ID (e.g. Bukit Kwong dam, F1 + RHN).
 *  Keep the first as-is and give later ones a stable suffix from their name. */
function dedupeIds<T extends { stationId: string; name: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!seen.has(r.stationId)) {
      seen.add(r.stationId);
      return r;
    }
    const suffix = createHash("sha1").update(r.name.trim().toLowerCase()).digest("hex").slice(0, 6);
    const id = `${r.stationId}-${suffix}`;
    seen.add(id);
    return { ...r, stationId: id };
  });
}
