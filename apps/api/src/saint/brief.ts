// Builds the "Saint brief" the official sends to Thea on WhatsApp after approving an alert,
// and the click-to-chat link that pre-fills it. Pure functions (no DB) so they're easy to test.
import type { Alert, AreaWarning, EvacCentre, Village } from "@monsoonwatch/shared";

const LANG_LABEL: Record<string, string> = { ms: "BM", en: "EN" };

function routeKm(alert: Pick<Alert, "route">): number {
  const c = alert.route?.coordinates ?? [];
  let m = 0;
  for (let i = 1; i < c.length; i++) {
    const [lon1, lat1] = c[i - 1]!, [lon2, lat2] = c[i]!;
    const dLat = ((lat2 - lat1) * Math.PI) / 180, dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    m += 2 * 6_371_000 * Math.asin(Math.sqrt(a));
  }
  return m / 1000;
}

export function buildBrief(input: {
  taskId: string;
  alert: Alert;
  village: Pick<Village, "name" | "district"> | null;
  centre: Pick<EvacCentre, "name" | "capacity" | "headcount"> | null;
}): string {
  const { taskId, alert, village, centre } = input;
  const villageName = village?.name ?? alert.villageId;
  const centreName = centre?.name ?? alert.evacCentreId;
  const eta = typeof alert.etaHours === "number" ? `ETA ~${Math.round(alert.etaHours)} h` : "ETA unknown";
  const km = routeKm(alert);
  const pickups = (alert.pickups ?? [])
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((p) => `${p.order}. ${p.people} ${p.category} by ${p.vehicle}`);
  const approvedAt = alert.approvedAt
    ? new Date(alert.approvedAt).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" }) + " MYT"
    : "time unknown";
  const messages = [...alert.messages]
    .sort((a, b) => (a.lang === "ms" ? -1 : b.lang === "ms" ? 1 : 0))
    .map((m) => `[${LANG_LABEL[m.lang] ?? m.lang.toUpperCase()}] ${m.text}`);

  return [
    `MonsoonWatch: APPROVED ALERT (Saint task ${taskId})`,
    `Alert: ${alert._id}`,
    `Village: ${villageName}${village?.district ? ` (${village.district})` : ""}, ${alert.people} people`,
    `Hazard: ${alert.hazard.toUpperCase()}, level ${alert.level.toUpperCase()}, ${eta}`,
    `Evacuation centre: ${centreName}${centre ? ` (${Math.max(0, centre.capacity - centre.headcount)} places free of ${centre.capacity}, estimated)` : ""}`,
    km > 0 ? `Route: ${km.toFixed(1)} km (verified by MonsoonWatch)` : `Route: see app`,
    pickups.length ? `Priority pickups (in order):\n${pickups.join("\n")}` : `Priority pickups: none recorded`,
    `Approved by ${alert.approvedBy ?? "an official"} at ${approvedAt}`,
    ``,
    `Message for the ketua kampung of ${villageName}:`,
    ...messages,
    ``,
    `Please: 1) WhatsApp this alert to the ketua kampung of ${villageName}; 2) when I ask, chase if there's no reply; 3) report back to me and end each report with this one line, filled in:`,
    `MW CHECKIN alert=${alert._id} centre=${centreName} people=<number> status=<acknowledged|moving|arrived>`,
  ].join("\n");
}

/** Village names shown in a district brief; the rest are counted, to keep the WhatsApp link short. */
export const AREA_BRIEF_MAX_VILLAGES = 15;
const CATEGORY_LABEL: Record<string, string> = { bedridden: "bedridden", disabled: "disabled", elderly: "elderly", noTransport: "without transport" };

/**
 * Brief for a district-level warning (AreaWarning). There is no planned centre or route: officials
 * arrange transport, so the leader reports which centre people went to and Thea fills centre= too.
 */
export function buildAreaBrief(input: { taskId: string; warning: AreaWarning; villageNames: string[] }): string {
  const { taskId, warning: w, villageNames } = input;
  const shown = villageNames.slice(0, AREA_BRIEF_MAX_VILLAGES);
  const more = w.villageIds.length - shown.length;
  const vulnerable = Object.entries(w.vulnerableByCategory ?? {})
    .filter(([, n]) => n > 0)
    .map(([c, n]) => `${n.toLocaleString("en-GB")} ${CATEGORY_LABEL[c] ?? c}`);
  const approvedAt = w.approvedAt
    ? new Date(w.approvedAt).toLocaleString("en-GB", { timeZone: "Asia/Kuala_Lumpur", dateStyle: "medium", timeStyle: "short" }) + " MYT"
    : "time unknown";
  const messages = [...w.messages]
    .sort((a, b) => (a.lang === "ms" ? -1 : b.lang === "ms" ? 1 : 0))
    .map((m) => `[${LANG_LABEL[m.lang] ?? m.lang.toUpperCase()}] ${m.text}`);
  const what = w.kind === "evacuate" ? "DISTRICT EVACUATION WARNING" : "DISTRICT ADVISORY (be ready to move)";

  return [
    `MonsoonWatch: APPROVED ${what} (Saint task ${taskId})`,
    `Warning: ${w._id}`,
    `District: ${w.district}`,
    `Hazard: ${w.hazard.toUpperCase()}, level ${w.level.toUpperCase()}`,
    `Villages (${w.villageIds.length}): ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
    `People: about ${w.people.toLocaleString("en-GB")} (estimated)`,
    vulnerable.length ? `Vulnerable residents, pickups NOT planned (estimated): ${vulnerable.join(", ")}` : `Vulnerable residents: none recorded`,
    `No centre or route is planned for this warning: officials arrange transport.`,
    ...(w.evidence?.length ? [`Why: ${w.evidence.slice(0, 3).join("; ")}`] : []),
    `Approved by ${w.approvedBy ?? "an official"} at ${approvedAt}`,
    ``,
    `Message for the ketua kampung of each village above:`,
    ...messages,
    ``,
    `Please: 1) WhatsApp this warning to the ketua kampung you are cleared to contact; 2) when I ask, chase if there's no reply; 3) report back to me and end each report with this one line, filled in (centre = where the leader says people are going):`,
    `MW CHECKIN alert=${w._id} centre=<centre name> people=<number> status=<acknowledged|moving|arrived>`,
  ].join("\n");
}

/** wa.me click-to-chat link that opens WhatsApp with the brief pre-filled. Null if no number configured. */
export function whatsappUrl(number: string, text: string): string | null {
  const digits = number.replace(/[^\d]/g, "");
  return digits ? `https://wa.me/${digits}?text=${encodeURIComponent(text)}` : null;
}
