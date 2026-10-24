// B4: the human approval step. NOTHING is sent before an official approves (GUIDELINES §2).
//   POST /alerts/:id/approve { approvedBy }  — only "verified" alerts (all checks green)
//   POST /alerts/:id/reject  { rejectedBy?, reason? }
// Approve → status "approved" + a SaintTask(send_alert, queued) for C's Saint handoff.
// Both are logged as AgentSteps for the Tech HUD.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Alert, SaintTask } from "@monsoonwatch/shared";
import { emitStep } from "../agent/steps";
import { defaultStore } from "../agent/store";
import { HttpError } from "../errors";

export async function alertRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { approvedBy?: string } }>("/alerts/:id/approve", async (req): Promise<Alert> => {
    const approvedBy = req.body?.approvedBy?.trim();
    if (!approvedBy) throw new HttpError(400, "bad_request", `"approvedBy" is required: who is approving this alert`);
    const store = defaultStore();
    const alert = await store.getAlert(req.params.id);
    if (!alert) throw new HttpError(404, "not_found", `Alert "${req.params.id}" not found`);
    if (alert.status !== "verified") {
      throw new HttpError(409, "conflict", `Alert is "${alert.status}"; only alerts that passed every check ("verified") can be approved`);
    }

    const approved: Alert = { ...alert, status: "approved", approvedBy, approvedAt: new Date().toISOString() };
    await store.saveAlert(approved);
    const task: SaintTask = {
      _id: `saint-${randomUUID()}`,
      alertId: approved._id,
      ts: new Date().toISOString(),
      type: "send_alert",
      status: "queued",
      detail: `Send approved ${approved.level.toUpperCase()} ${approved.hazard} alert for village ${approved.villageId} ` +
        `(${approved.people} people → ${approved.evacCentreId}${approved.pickups?.length ? `, ${approved.pickups.length} priority pickups` : ""}) to community leaders`,
    };
    await store.saveSaintTask(task);
    await emitStep({ runId: approved.runId, actor: "Human approval", kind: "info", status: "ok", summary: `${approvedBy} approved alert ${approved._id} → Saint task queued` });
    return approved;
  });

  app.post<{ Params: { id: string }; Body: { rejectedBy?: string; reason?: string } }>("/alerts/:id/reject", async (req): Promise<Alert> => {
    const store = defaultStore();
    const alert = await store.getAlert(req.params.id);
    if (!alert) throw new HttpError(404, "not_found", `Alert "${req.params.id}" not found`);
    if (alert.status === "approved" || alert.status === "sent") {
      throw new HttpError(409, "conflict", `Alert is already "${alert.status}"`);
    }
    const rejected: Alert = { ...alert, status: "rejected" };
    await store.saveAlert(rejected);
    const who = req.body?.rejectedBy?.trim() || "An official";
    await emitStep({ runId: rejected.runId, actor: "Human approval", kind: "info", status: "fail", summary: `${who} rejected alert ${rejected._id}${req.body?.reason ? `: ${req.body.reason}` : ""}`.slice(0, 200) });
    return rejected;
  });
}
