// Atlas Stream Processing: new readings → risk_events. Applied by `pnpm db:stream` (src/db/stream.ts).
//
// Source: change stream on monsoonwatch.reading_events (inserts). Not raw_readings: time series
// collections can't be a Stream Processing source. Atlas allows ONE window stage per pipeline, so
// river (tumbling) and rain (hopping) are two processors.
//
// Window timing: windows use the change event's time (≈ when the reading was inserted), not the
// reading's own `ts`. JPS stations report with different delays (some hours stale) and the 2014
// replay re-inserts old readings; with reading-time windows Atlas would treat those as late data and
// drop them. Dedup therefore uses the READING's time: the risk event _id is
//   <stationId>:<type>:<level>:<reading-time bucket>
// and $merge keeps an existing doc, so restarts, re-inserts and replays never duplicate.
//
// Syntax checked against the Atlas Stream Processing docs ($source, $tumblingWindow, $hoppingWindow,
// $lookup, $merge, sp.createStreamProcessor) on 24 Oct 2026. Expression-level details marked VERIFY.

import { existsSync, readFileSync } from "node:fs";
import { loadLandslideConfig, OPTION_A } from "../../agent/landslide.ts";

const CONNECTION = "monsoonwatch"; // connection registry entry → Cluster0
const DB = "monsoonwatch";
const MYT_OFFSET_MS = 8 * 3600 * 1000; // Asia/Kuala_Lumpur, no DST

// Window sizes are processing time, so they must be shorter than one replay day: the replay engine
// inserts a whole 2014 day per tick (default 30 s, 10 s when testing). Longer windows would merge
// several replay days and skip the alert → warning → danger build-up. Live JPS bursts (every 15 min,
// inserted within a second) still land in a single window.

// River: max level per station per tumbling window. Dedup bucket = the 15-minute JPS reporting slot
// of the reading (for daily GloFAS readings that is one bucket per day).
const RIVER_WINDOW = { size: 10, unit: "second" };
const RIVER_DEDUP_BUCKET_MS = 15 * 60 * 1000;

// GloFAS discharge (m³/s) on the main Kelantan channel — only in the reconstructed 2014 replay
// (meta.kind "glofas", stationId = Region.glofasCells id). APPROXIMATE thresholds chosen by us from
// the 2014 series shape (cells peak ~5,100 m³/s on 24 Dec); they are not official JPS/GloFAS
// return-period thresholds and discharge is not comparable to JPS water levels in metres.
const GLOFAS_ALERT_M3S = 1500;
const GLOFAS_WARNING_M3S = 3000;
const GLOFAS_DANGER_M3S = 4500;

// Rain (landslide screening thresholds, B's Deep Research): generated at `pnpm db:stream` time from
// agent/research/output/landslide-thresholds.<region>.json via B's loadLandslideConfig, which falls back to
// OPTION_A when the file is missing or its check didn't pass — so a re-run of the research flows through on
// the next `pnpm db:stream`. Each level is checked against ITS OWN window (option A mixes them):
//   alert 47.66 mm over 3 days · warning 100 mm in 1 day · danger 240 mm in 1 day.
// rain over N days = `value` (rain since local midnight live; that day's total in replay) + the last N−1
// daily totals in `rain6d` (oldest first, last = yesterday; null = missing → 0). Same rule as B's
// rainOverDays/rainLevel in agent/landslide.ts. A hopping window takes each station's highest level
// (then highest mm) over the last 20 s, re-evaluated every 5 s. One event per station, level and local day.
const REGION_ID = process.env.REGION_ID || "kelantan";
const RAIN_CFG = loadLandslideConfig(REGION_ID);
const RANK = { alert: 1, warning: 2, danger: 3 };
const RAIN_LEVELS = [...RAIN_CFG.levels].sort((a, b) => RANK[b.level] - RANK[a.level]); // danger first
/** Short label for messages, e.g. "Deep Research option A". */
function thresholdLabel() {
  if (RAIN_CFG === OPTION_A) return "Deep Research option A (built-in defaults)";
  const file = new URL(`../../agent/research/output/landslide-thresholds.${REGION_ID}.json`, import.meta.url);
  try {
    const decision = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).decision : "";
    const option = /^option\s+(\w+)/i.exec(decision ?? "");
    return option ? `Deep Research option ${option[1]}` : "Deep Research";
  } catch {
    return "Deep Research";
  }
}
export const RAIN_THRESHOLDS = {
  levels: RAIN_LEVELS.map(({ level, days, mm }) => ({ level, days, mm })),
  label: thresholdLabel(),
  source: RAIN_CFG.source,
};
/** Printed by `pnpm db:stream`. */
export const SUMMARY = [
  `riskRain thresholds (${RAIN_THRESHOLDS.label}; from ${RAIN_THRESHOLDS.source}):`,
  ...RAIN_THRESHOLDS.levels.map((t) => `  ${t.level.padEnd(7)} ≥ ${t.mm} mm in ${t.days} day${t.days > 1 ? "s" : ""}`),
];
const RAIN_WINDOW = { size: 20, unit: "second" };
const RAIN_HOP = { size: 5, unit: "second" };

const IDLE_TIMEOUT = { size: 10, unit: "second" }; // close windows when ingest goes quiet

const source = {
  $source: { connectionName: CONNECTION, db: DB, coll: "reading_events" },
  // No timeField: event time defaults to the change event's own timestamp. VERIFY (docs: "creates a
  // timestamp from the message timestamp provided by the source").
};

const lookupStation = {
  $lookup: {
    from: { connectionName: CONNECTION, db: DB, coll: "stations" },
    localField: "_id", // window output is grouped by stationId
    foreignField: "_id",
    as: "station",
  },
};

const sink = {
  $merge: {
    into: { connectionName: CONNECTION, db: DB, coll: "risk_events" },
    on: "_id",
    whenMatched: "keepExisting",
    whenNotMatched: "insert",
  },
};

const round2 = (expr) => ({ $round: [expr, 2] });
const levelOf = (value, alert, warning, danger) => ({
  $switch: {
    branches: [
      { case: { $gte: [value, danger] }, then: "danger" },
      { case: { $gte: [value, warning] }, then: "warning" },
      { case: { $gte: [value, alert] }, then: "alert" },
    ],
    default: "none",
  },
});
const thresholdFor = (alert, warning, danger) => ({
  $switch: {
    branches: [
      { case: { $eq: ["$level", "danger"] }, then: danger },
      { case: { $eq: ["$level", "warning"] }, then: warning },
    ],
    default: alert,
  },
});

// GloFAS cell id → region + label, from Region.glofasCells.
const lookupCell = {
  $lookup: {
    from: { connectionName: CONNECTION, db: DB, coll: "regions" },
    let: { cellId: "$_id" },
    pipeline: [
      { $unwind: "$glofasCells" },
      { $match: { $expr: { $eq: ["$glofasCells.id", "$$cellId"] } } },
      { $project: { _id: 1, label: "$glofasCells.label" } },
    ],
    as: "cell",
  },
};

const isGlofas = { $eq: ["$top.kind", "glofas"] };
const first = (path) => ({ $arrayElemAt: [path, 0] });

const river = [
  source,
  {
    $match: {
      operationType: "insert",
      "fullDocument.meta.kind": { $in: ["river", "glofas"] },
      "fullDocument.value": { $type: "number" },
    },
  },
  { $replaceRoot: { newRoot: "$fullDocument" } },
  {
    $tumblingWindow: {
      interval: RIVER_WINDOW,
      idleTimeout: IDLE_TIMEOUT,
      pipeline: [
        {
          $group: {
            _id: "$meta.stationId",
            // $max over a document compares field by field, so this is the highest value and its ts
            // (verified with several readings in one window).
            top: { $max: { value: "$value", ts: "$ts", mode: "$meta.mode", kind: "$meta.kind" } },
            readings: { $sum: 1 },
            // $$NOW is not available in stream processing (verified: DLQ "Builtin variable '$$NOW' is not
            // available"), so the window bounds are the processor's timing record.
            windowStart: { $min: { $meta: "stream.window.start" } },
            windowEnd: { $max: { $meta: "stream.window.end" } },
          },
        },
      ],
    },
  },
  lookupStation,
  lookupCell,
  // One shape for both: JPS station (thresholds in metres) or GloFAS cell (approximate m³/s constants).
  {
    $addFields: {
      site: {
        $cond: [
          isGlofas,
          {
            name: first("$cell.label"),
            regionId: first("$cell._id"),
            thresholds: { alert: GLOFAS_ALERT_M3S, warning: GLOFAS_WARNING_M3S, danger: GLOFAS_DANGER_M3S },
          },
          { name: first("$station.name"), regionId: first("$station.regionId"), thresholds: first("$station.thresholds") },
        ],
      },
    },
  },
  { $match: { "site.thresholds.alert": { $type: "number" }, "site.regionId": { $type: "string" } } },
  { $addFields: { level: levelOf("$top.value", "$site.thresholds.alert", "$site.thresholds.warning", "$site.thresholds.danger") } },
  { $match: { level: { $ne: "none" } } },
  { $addFields: { threshold: thresholdFor("$site.thresholds.alert", "$site.thresholds.warning", "$site.thresholds.danger") } },
  {
    $project: {
      _id: {
        $concat: [
          "$_id", ":river_threshold:", "$level", ":",
          { $toString: { $toDate: { $subtract: [{ $toLong: "$top.ts" }, { $mod: [{ $toLong: "$top.ts" }, RIVER_DEDUP_BUCKET_MS] }] } } },
        ],
      },
      regionId: "$site.regionId",
      ts: "$top.ts",
      type: { $literal: "river_threshold" },
      stationId: "$_id",
      level: 1,
      value: round2("$top.value"),
      threshold: 1,
      message: {
        $cond: [
          isGlofas,
          {
            $concat: [
              { $toUpper: "$level" }, ": GloFAS discharge (reconstructed) at ", "$site.name", " — ",
              { $toString: { $round: ["$top.value", 0] } }, " m³/s ≥ ", { $toString: "$threshold" }, " m³/s (approximate threshold)",
            ],
          },
          {
            $concat: [
              { $toUpper: "$level" }, " crossing: ", "$site.name",
              " (", { $toString: round2("$top.value") }, " m ≥ ", { $toString: round2("$threshold") }, " m)",
            ],
          },
        ],
      },
      source: { $literal: "stream_processing" },
      mode: "$top.mode",
      windowStart: 1,
      windowEnd: 1,
    },
  },
  sink,
];

// Rain over the last `days` days including today (mm).
const rainOver = (days) => ({
  $add: [
    "$value",
    ...Array.from({ length: days - 1 }, (_, i) => ({ $ifNull: [{ $arrayElemAt: [{ $ifNull: ["$rain6d", []] }, -(i + 1)] }, 0] })),
  ],
});

const rain = [
  source,
  { $match: { operationType: "insert", "fullDocument.meta.kind": "rain", "fullDocument.value": { $type: "number" } } },
  { $replaceRoot: { newRoot: "$fullDocument" } },
  {
    $addFields: {
      rain1dMm: "$value",
      rain3dMm: rainOver(3),
      // Highest level whose own-window rain reaches its threshold (rank 0 = none).
      hit: {
        $switch: {
          branches: RAIN_LEVELS.map((t) => ({
            case: { $gte: [rainOver(t.days), t.mm] },
            then: { rank: RANK[t.level], mm: rainOver(t.days), level: t.level, threshold: t.mm, days: t.days },
          })),
          default: { rank: 0 },
        },
      },
    },
  },
  { $match: { "hit.rank": { $gt: 0 } } },
  {
    $hoppingWindow: {
      interval: RAIN_WINDOW,
      hopSize: RAIN_HOP,
      idleTimeout: IDLE_TIMEOUT,
      pipeline: [
        {
          $group: {
            _id: "$meta.stationId",
            // Field order matters: highest level first, then most rain (see $max note in river).
            top: {
              $max: {
                rank: "$hit.rank", mm: "$hit.mm", level: "$hit.level", threshold: "$hit.threshold", days: "$hit.days",
                ts: "$ts", rain1dMm: "$rain1dMm", rain3dMm: "$rain3dMm", mode: "$meta.mode",
              },
            },
            readings: { $sum: 1 },
            windowStart: { $min: { $meta: "stream.window.start" } },
            windowEnd: { $max: { $meta: "stream.window.end" } },
          },
        },
      ],
    },
  },
  lookupStation,
  { $unwind: "$station" },
  {
    $project: {
      _id: {
        $concat: [
          "$station._id", ":rain_accumulation:", "$top.level", ":",
          { $dateToString: { format: "%Y-%m-%d", date: { $add: ["$top.ts", MYT_OFFSET_MS] } } }, // local (MYT) day
        ],
      },
      regionId: "$station.regionId",
      ts: "$top.ts",
      type: { $literal: "rain_accumulation" },
      stationId: "$station._id",
      level: "$top.level",
      value: round2("$top.mm"), // rain over the level's own window
      threshold: "$top.threshold",
      windowDays: "$top.days",
      rain1dMm: round2("$top.rain1dMm"),
      rain3dMm: round2("$top.rain3dMm"),
      thresholdSource: { $literal: `${RAIN_THRESHOLDS.label} — ${RAIN_THRESHOLDS.source}` },
      message: {
        $concat: [
          { $toUpper: "$top.level" }, " rain: ", "$station.name", " — ", { $toString: round2("$top.mm") },
          { $cond: [{ $eq: ["$top.days", 1] }, " mm in 1 day", { $concat: [" mm in ", { $toString: "$top.days" }, " days"] }] },
          " (≥ ", { $toString: "$top.threshold" }, " mm; threshold: ", { $literal: RAIN_THRESHOLDS.label }, ")",
        ],
      },
      source: { $literal: "stream_processing" },
      mode: "$top.mode",
      windowStart: 1,
      windowEnd: 1,
    },
  },
  sink,
];

// Each processor bills per hour while running; SP2 is the smallest tier.
const options = { dlq: { connectionName: CONNECTION, db: DB, coll: "sp_dlq" }, tier: "SP2" };

export default [
  { name: "riskRiver", pipeline: river, options },
  { name: "riskRain", pipeline: rain, options },
];
