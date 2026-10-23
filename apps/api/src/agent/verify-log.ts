// Logs each verification result as an AgentStep (kind "verify") so the HUD shows green/red ticks
// and the fail → replan → pass moment is visible. Kept separate so verify.ts stays pure.

import type { Alert, VerificationResult } from "@monsoonwatch/shared";
import { emitStep } from "./steps";

export async function logVerification(
  runId: string,
  alert: Pick<Alert, "villageId">,
  villageName: string,
  results: VerificationResult[],
  attempt: number,
): Promise<void> {
  for (const r of results) {
    await emitStep({
      runId,
      actor: "Verification",
      kind: "verify",
      status: r.passed ? "ok" : "fail",
      summary: `${villageName} · ${r.check} ${r.passed ? "PASSED" : "FAILED"} (attempt ${attempt}) — ${r.detail}`.slice(0, 240),
    });
  }
  const failed = results.filter((r) => !r.passed).length;
  if (failed > 0) {
    await emitStep({
      runId,
      actor: "Verification",
      kind: "replan",
      status: "running",
      summary: `${villageName}: ${failed} check(s) failed → replanning`,
    });
  }
}
