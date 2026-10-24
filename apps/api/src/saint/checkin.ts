// Parses the one-line reports Thea (Saint) ends each WhatsApp message with, e.g.
//   MW CHECKIN alert=alert-123 centre=SK Dabong people=30 status=moving
// The official copies Thea's message into the app; any number of lines and surrounding text is fine.
export const CHECKIN_STATUSES = ["acknowledged", "moving", "arrived"] as const;
export type CheckinStatus = (typeof CHECKIN_STATUSES)[number];

export interface Checkin {
  alertId: string;
  centre: string;
  people: number;
  status: CheckinStatus;
  raw: string; // the normalised line, used as the idempotency key
}

export interface ParseResult {
  checkins: Checkin[];
  errors: { line: string; reason: string }[];
}

const KEYS = ["alert", "centre", "people", "status"] as const;

export function parseCheckins(text: string): ParseResult {
  const checkins: Checkin[] = [];
  const errors: ParseResult["errors"] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/[*_`]/g, "").replace(/\s+/g, " ").trim(); // WhatsApp formatting marks
    const start = line.toUpperCase().indexOf("MW CHECKIN");
    if (start < 0) continue;
    const body = line.slice(start + "MW CHECKIN".length);
    // key=value where value runs until the next " key=" (centre names contain spaces)
    const fields: Record<string, string> = {};
    const re = /\b(alert|centre|center|people|status)=/gi;
    const marks = [...body.matchAll(re)];
    marks.forEach((m, i) => {
      const key = m[1]!.toLowerCase() === "center" ? "centre" : m[1]!.toLowerCase();
      const from = m.index! + m[0].length;
      const to = i + 1 < marks.length ? marks[i + 1]!.index! : body.length;
      fields[key] = body.slice(from, to).trim().replace(/[.,;]+$/, "");
    });
    const missing = KEYS.filter((k) => !fields[k]);
    if (missing.length) { errors.push({ line, reason: `missing ${missing.join(", ")}` }); continue; }
    const people = Number.parseInt(fields.people!, 10);
    if (!Number.isFinite(people) || people < 0 || people > 100_000) { errors.push({ line, reason: `people must be a whole number` }); continue; }
    const status = fields.status!.toLowerCase();
    if (!(CHECKIN_STATUSES as readonly string[]).includes(status)) {
      errors.push({ line, reason: `status must be one of ${CHECKIN_STATUSES.join(", ")}` });
      continue;
    }
    const alertId = fields.alert!.replace(/^<|>$/g, "");
    const centre = fields.centre!.replace(/^<|>$/g, "");
    checkins.push({ alertId, centre, people, status: status as CheckinStatus, raw: `MW CHECKIN alert=${alertId} centre=${centre} people=${people} status=${status}` });
  }
  return { checkins, errors };
}

/** Loose name match for centre names typed by people ("SK Dabong" vs "Sekolah Kebangsaan Dabong"). */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bsekolah kebangsaan\b/g, "sk")
    .replace(/\bsekolah menengah kebangsaan\b/g, "smk")
    .replace(/\bsekolah menengah\b/g, "sm")
    .replace(/\bkampung\b/g, "kg")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
