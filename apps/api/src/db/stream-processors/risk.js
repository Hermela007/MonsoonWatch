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

const CONNECTION = "monsoonwatch"; // connection registry entry → Cluster0
const DB = "monsoonwatch";
const MYT_OFFSET_MS = 8 * 3600 * 1000; // Asia/Kuala_Lumpur, no DST

// River: max level per station per tumbling window (short so alerts surface quickly, also during the
// fast 2014 replay). Dedup bucket = the 15-minute JPS reporting slot of the reading.
const RIVER_WINDOW = { size: 1, unit: "minute" };
const RIVER_DEDUP_BUCKET_MS = 15 * 60 * 1000;

// Rain: 3-day accumulation = rain since local midnight (`value`) + the last two daily totals in
// `rain6d` (oldest first, last = yesterday; null = missing → 0). A hopping window takes each station's
// highest 3-day total over the last 2 minutes, re-evaluated every 30 s. One event per station,
// level and local day.
// PLACEHOLDER thresholds (mm over 3 days) — replace with B's Deep Research values
// (Region.landslide.rainThresholdsMm) once they exist.
const RAIN_3D_ALERT_MM = 150;
const RAIN_3D_WARNING_MM = 250;
const RAIN_3D_DANGER_MM = 350;
const RAIN_WINDOW = { size: 2, unit: "minute" };
const RAIN_HOP = { size: 30, unit: "second" };

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

const river = [
  source,
  { $match: { operationType: "insert", "fullDocument.meta.kind": "river", "fullDocument.value": { $type: "number" } } },
  { $replaceRoot: { newRoot: "$fullDocument" } },
  {
    $tumblingWindow: {
      interval: RIVER_WINDOW,
      idleTimeout: IDLE_TIMEOUT,
      pipeline: [
        {
          $group: {
            _id: "$meta.stationId",
            // $max over a document compares field by field, so this is the highest level and its ts. VERIFY
            top: { $max: { value: "$value", ts: "$ts", mode: "$meta.mode" } },
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
  { $unwind: "$station" },
  { $match: { "station.thresholds.alert": { $type: "number" } } },
  { $addFields: { level: levelOf("$top.value", "$station.thresholds.alert", "$station.thresholds.warning", "$station.thresholds.danger") } },
  { $match: { level: { $ne: "none" } } },
  { $addFields: { threshold: thresholdFor("$station.thresholds.alert", "$station.thresholds.warning", "$station.thresholds.danger") } },
  {
    $project: {
      _id: {
        $concat: [
          "$station._id", ":river_threshold:", "$level", ":",
          { $toString: { $toDate: { $subtract: [{ $toLong: "$top.ts" }, { $mod: [{ $toLong: "$top.ts" }, RIVER_DEDUP_BUCKET_MS] }] } } },
        ],
      },
      regionId: "$station.regionId",
      ts: "$top.ts",
      type: { $literal: "river_threshold" },
      stationId: "$station._id",
      level: 1,
      value: "$top.value",
      threshold: 1,
      message: {
        $concat: [
          { $toUpper: "$level" }, " crossing: ", "$station.name",
          " (", { $toString: round2("$top.value") }, " m ≥ ", { $toString: round2("$threshold") }, " m)",
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

const rain = [
  source,
  { $match: { operationType: "insert", "fullDocument.meta.kind": "rain", "fullDocument.value": { $type: "number" } } },
  { $replaceRoot: { newRoot: "$fullDocument" } },
  {
    $addFields: {
      acc3dMm: {
        $add: [
          "$value",
          { $ifNull: [{ $arrayElemAt: [{ $ifNull: ["$rain6d", []] }, -1] }, 0] },
          { $ifNull: [{ $arrayElemAt: [{ $ifNull: ["$rain6d", []] }, -2] }, 0] },
        ],
      },
    },
  },
  {
    $hoppingWindow: {
      interval: RAIN_WINDOW,
      hopSize: RAIN_HOP,
      idleTimeout: IDLE_TIMEOUT,
      pipeline: [
        {
          $group: {
            _id: "$meta.stationId",
            top: { $max: { acc3dMm: "$acc3dMm", ts: "$ts", value: "$value", mode: "$meta.mode" } }, // VERIFY (see river)
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
  { $addFields: { level: levelOf("$top.acc3dMm", RAIN_3D_ALERT_MM, RAIN_3D_WARNING_MM, RAIN_3D_DANGER_MM) } },
  { $match: { level: { $ne: "none" } } },
  { $addFields: { threshold: thresholdFor(RAIN_3D_ALERT_MM, RAIN_3D_WARNING_MM, RAIN_3D_DANGER_MM) } },
  {
    $project: {
      _id: {
        $concat: [
          "$station._id", ":rain_accumulation:", "$level", ":",
          { $dateToString: { format: "%Y-%m-%d", date: { $add: ["$top.ts", MYT_OFFSET_MS] } } }, // local (MYT) day
        ],
      },
      regionId: "$station.regionId",
      ts: "$top.ts",
      type: { $literal: "rain_accumulation" },
      stationId: "$station._id",
      level: 1,
      value: round2("$top.acc3dMm"),
      threshold: 1,
      message: {
        $concat: [
          { $toUpper: "$level" }, " rain: ", "$station.name", " — ", { $toString: round2("$top.acc3dMm") },
          " mm in 3 days (≥ ", { $toString: "$threshold" }, " mm, placeholder threshold)",
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
