// B4: the human approval step. NOTHING is sent before an official approves (GUIDELINES §2).
//   POST /alerts/:id/approve { approvedBy }  — only "verified" alerts (all checks green)
//   POST /alerts/:id/reject  { rejectedBy?, reason? }
// Approve → status "approved" + a SaintTask(send_alert, queued) for C's Saint handoff, then the
// spoken alert (Gemini 3.8 Flash TTS, approved text verbatim) is generated in the background.
//   GET /alerts/:id/audio/:lang → audio/wav (404 until generated, usually a few seconds)
// All of it is logged as AgentSteps for the Tech HUD.

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Alert, SaintTask } from "@monsoonwatch/shared";
import { audioUrl, generateSpokenAlert, readSpokenAlert } from "../agent/speech";
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
        `(${approved.people} people → ${approved.evacCentreId}${approved.pickups?.length ? `, ${approved.pickups.length} priority pickups` : ""}) to community leaders. ` +
        `Spoken versions (WAV, ready a few seconds after approval): ${approved.messages.map((m) => `${m.lang} ${audioUrl(approved._id, m.lang)}`).join(", ")}`,
    };
    await store.saveSaintTask(task);
    await emitStep({ runId: approved.runId, actor: "Human approval", kind: "info", status: "ok", summary: `${approvedBy} approved alert ${approved._id} → Saint task queued` });
    void generateSpokenAlert(approved).catch((err) => req.log.warn({ err }, "spoken alert failed"));
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

  app.get<{ Params: { id: string; lang: string } }>("/alerts/:id/audio/:lang", async (req, reply) => {
    if (!/^[a-z]{2,3}$/.test(req.params.lang)) throw new HttpError(400, "bad_request", `"lang" must be a language code like ms or en`);
    const wav = await readSpokenAlert(req.params.id, req.params.lang);
    if (!wav) throw new HttpError(404, "not_found", `No spoken alert yet for ${req.params.id} (${req.params.lang}) — it is generated after approval`);
    return reply.type("audio/wav").header("cache-control", "no-store").send(wav);
  });
}
