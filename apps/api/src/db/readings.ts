// raw_readings stores `ts` as a BSON Date (time series); the API contract uses ISO strings.
import type { Reading } from "@monsoonwatch/shared";

export interface ReadingDoc {
  ts: Date;
  meta: Reading["meta"];
  value: number;
  rain6d?: (number | null)[]; // null = JPS reported missing (-9999)
}

export function toReading(doc: ReadingDoc): Reading {
  return {
    ts: doc.ts.toISOString(),
    meta: doc.meta,
    value: doc.value,
    ...(doc.rain6d ? { rain6d: doc.rain6d as number[] } : {}),
  };
}
