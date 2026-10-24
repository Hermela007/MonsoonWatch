// B6 — Vulnerable-people priority (IMPLEMENTATION §1.7 decision 3, GUIDELINES §6.2).
// Deterministic helpers + the `vulnerable` verification check. No LLM in this file.
//
// Gemini subagents PLAN the pickups (they can call `suggestPickups` as a tool for a baseline);
// `checkVulnerable` VERIFIES the plan before a human sees it. Carrying pickups out after
// approval is Saint's job, not Gemini's (GUIDELINES §6.5).
//
// Privacy: works on per-village COUNTS only. Never names or addresses.

import type { Alert, Pickup, PickupVehicle, VerificationResult, Village, VulnerableCategory } from "@monsoonwatch/shared";

/** Pickup priority, highest first. */
export const PRIORITY: readonly VulnerableCategory[] = ["bedridden", "disabled", "elderly", "noTransport"];

const RANK: Record<VulnerableCategory, number> = { bedridden: 0, disabled: 1, elderly: 2, noTransport: 3 };

const LABEL: Record<VulnerableCategory, string> = {
  bedridden: "bedridden",
  disabled: "disabled",
  elderly: "elderly",
  noTransport: "without transport",
};

/**
 * Vehicles acceptable for a category. If the only route crosses floodwater, boats only;
 * where roads are open, bedridden people go by ambulance (C's brief, IMPLEMENTATION B6).
 */
export function allowedVehicles(category: VulnerableCategory, routeCrossesFlood: boolean): readonly PickupVehicle[] {
  if (routeCrossesFlood) return ["boat"];
  if (category === "bedridden") return ["ambulance", "boat"];
  if (category === "disabled") return ["ambulance", "4x4", "boat"];
  return ["bus", "4x4", "boat"];
}

/** Default vehicle for a category — the first allowed one. */
export function vehicleFor(category: VulnerableCategory, routeCrossesFlood: boolean): PickupVehicle {
  return allowedVehicles(category, routeCrossesFlood)[0]!;
}

export function totalVulnerable(village: Village): number {
  const v = village.vulnerable;
  return v ? PRIORITY.reduce((sum, c) => sum + v[c], 0) : 0;
}

/** Deterministic baseline plan: one pickup per non-empty category, in priority order. */
export function suggestPickups(village: Village, routeCrossesFlood: boolean): Pickup[] {
  const v = village.vulnerable;
  if (!v) return [];
  return PRIORITY.filter((c) => v[c] > 0).map((category, i) => ({
    category,
    people: v[category],
    vehicle: vehicleFor(category, routeCrossesFlood),
    order: i + 1,
  }));
}

/**
 * The `vulnerable` check, run over ALL alerts for one village in a run (a village may be split
 * across centres, §1.6 decision 5). Passes when:
 *  1. every counted vulnerable person is covered by a pickup,
 *  2. pickup `order` values are unique and follow PRIORITY (bedridden first),
 *  3. each pickup's vehicle suits its category (boat if the route crosses floodwater).
 */
export function checkVulnerable(
  alerts: Pick<Alert, "villageId" | "pickups">[],
  village: Village,
  opts: { routeCrossesFlood: boolean },
): VerificationResult {
  const v = village.vulnerable;
  if (!v || totalVulnerable(village) === 0) {
    return pass(`${village.name}: no vulnerable residents recorded`);
  }
  const est = v.estimated ? " (estimated)" : "";
  const pickups = alerts.filter((a) => a.villageId === village._id).flatMap((a) => a.pickups ?? []);

  // 1. Coverage per category
  for (const c of PRIORITY) {
    const covered = pickups.filter((p) => p.category === c).reduce((s, p) => s + p.people, 0);
    if (covered < v[c]) {
      return fail(`${village.name}: ${v[c] - covered} of ${v[c]} ${LABEL[c]} residents${est} have no pickup planned`);
    }
  }

  // 2. Order: unique, and priority never goes backwards
  const sorted = [...pickups].sort((a, b) => a.order - b.order);
  if (new Set(sorted.map((p) => p.order)).size !== sorted.length) {
    return fail(`${village.name}: two pickups share the same order number`);
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (RANK[cur.category] < RANK[prev.category]) {
      return fail(`${village.name}: ${LABEL[cur.category]} (order ${cur.order}) scheduled after ${LABEL[prev.category]} — must come first`);
    }
  }

  // 3. Vehicle suitability
  for (const p of sorted) {
    const ok = allowedVehicles(p.category, opts.routeCrossesFlood);
    if (!ok.includes(p.vehicle)) {
      const why = opts.routeCrossesFlood ? "route crosses floodwater, boats only" : `${LABEL[p.category]} residents need ${ok.join("/")}`;
      return fail(`${village.name}: pickup ${p.order} uses ${p.vehicle} — ${why}`);
    }
  }

  const first = sorted[0]!;
  return pass(
    `${village.name}: all ${totalVulnerable(village)} vulnerable residents${est} covered; ` +
      `${first.people} ${LABEL[first.category]} first by ${first.vehicle}`,
  );
}

function pass(detail: string): VerificationResult {
  return { check: "vulnerable", passed: true, detail };
}
function fail(detail: string): VerificationResult {
  return { check: "vulnerable", passed: false, detail };
}
