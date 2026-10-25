// B4: the human approval step. NOTHING is sent before an official approves (GUIDELINES §2).
//   POST /alerts/:id/approve { approvedBy }  — only "verified" alerts (all checks green)
//   POST /alerts/:id/reject  { rejectedBy?, reason? }
// Approve → status "approved" + a SaintTask(send_alert, queued) for C's Saint handoff, then the
// spoken alert (Gemini 3.8 Flash TTS, approved text verbatim) is generated in the background.
//   GET /alerts/:id/audio/:lang → audio/wav (404 until generated, usually a few seconds)
// District warnings (AreaWarning: "evacuate" fallback + "advisory", deterministic templates) get the
// same human step — nothing about them is sent before an official approves either:
//   GET  /area-warnings?runId=                      the run's district warnings (evacuate first)
//   POST /area-warnings/:id/approve { approvedBy }  needs_approval → approved + SaintTask(target
//                                                    "area_warning") + spoken version (same audio URL)
//   POST /area-warnings/:id/reject  { rejectedBy?, reason? }
// All of it is logged as AgentSteps for the Tech HUD. PUBLIC_DEMO=1 blocks every POST (server.ts).

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Alert, AreaWarning, SaintTask } from "@monsoonwatch/shared";
import { audioUrl, generateSpokenAlert, readSpokenAlert, speakText } from "../agent/speech";
import { emitStep } from "../agent/steps";
import { defaultStore } from "../agent/store";
import { HttpError } from "../errors";

export async function alertRoutes(app: FastifyInstance, opts: { summarySpeaker?: typeof speakText } = {}) {
  // Resident-requested replay narration is separate from approved official alert recordings.
  const summaries = new Map<string, Promise<Buffer>>();
  app.post<{ Body: { text?: unknown } }>("/resident-summary/audio", async (req, reply) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 2400) {
      throw new HttpError(400, 'bad_request', 'Summary text must contain 1–2400 characters');
    }
    const transcript = `Historical replay model estimate. ${text.trim()}. Follow official instructions.`;
    let audio = summaries.get(transcript);
    if (!audio) {
      if (summaries.size >= 32) summaries.delete(summaries.keys().next().value!);
      audio = (opts.summarySpeaker ?? speakText)(`resident-voice-${randomUUID()}`, transcript, 'resident replay summary (en)');
      summaries.set(transcript, audio);
      audio.catch(() => { if (summaries.get(transcript) === audio) summaries.delete(transcript); });
    }
    return reply.type('audio/wav').header('cache-control', 'no-store').send(await audio);
  });

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

  app.get<{ Querystring: { runId?: string } }>("/area-warnings", async (req): Promise<AreaWarning[]> => {
    const runId = req.query.runId?.trim();
    if (!runId) throw new HttpError(400, "bad_request", `"runId" is required`);
    const list = await defaultStore().areaWarningsForRun(runId);
    return list.sort((a, b) => (a.kind === b.kind ? b.people - a.people : a.kind === "evacuate" ? -1 : 1));
  });

  app.post<{ Params: { id: string }; Body: { approvedBy?: string } }>("/area-warnings/:id/approve", async (req): Promise<AreaWarning> => {
    const approvedBy = req.body?.approvedBy?.trim();
    if (!approvedBy) throw new HttpError(400, "bad_request", `"approvedBy" is required: who is approving this warning`);
    const store = defaultStore();
    const w = await store.getAreaWarning(req.params.id);
    if (!w) throw new HttpError(404, "not_found", `Area warning "${req.params.id}" not found`);
    if (w.status !== "needs_approval") throw new HttpError(409, "conflict", `Area warning is already "${w.status}"`);
    const approved: AreaWarning = { ...w, status: "approved", approvedBy, approvedAt: new Date().toISOString() };
    await store.saveAreaWarning(approved);
    const pickups = Object.entries(approved.vulnerableByCategory).filter(([, n]) => n > 0).map(([c, n]) => `${c} ${n}`).join(", ");
    const task: SaintTask = {
      _id: `saint-${randomUUID()}`,
      alertId: approved._id,
      target: "area_warning",
      ts: new Date().toISOString(),
      type: "send_alert",
      status: "queued",
      detail: `Send approved ${approved.level.toUpperCase()} ${approved.hazard} ${approved.kind === "evacuate" ? "EVACUATE warning" : "advisory"} for ${approved.district} district ` +
        `(${approved.villageIds.length} villages, ${approved.people.toLocaleString()} people) to community leaders.` +
        `${approved.kind === "evacuate" && pickups ? ` No pickups were planned — officials must arrange transport (${pickups}).` : ""} ` +
        `Spoken versions (WAV, ready a few seconds after approval): ${approved.messages.map((m) => `${m.lang} ${audioUrl(approved._id, m.lang)}`).join(", ")}`,
    };
    await store.saveSaintTask(task);
    await emitStep({ runId: approved.runId, actor: "Human approval", kind: "info", status: "ok", summary: `${approvedBy} approved the ${approved.district} district ${approved.kind} warning (${approved.villageIds.length} villages) → Saint task queued`.slice(0, 200) });
    void generateSpokenAlert(approved).catch((err) => req.log.warn({ err }, "spoken warning failed"));
    return approved;
  });

  app.post<{ Params: { id: string }; Body: { rejectedBy?: string; reason?: string } }>("/area-warnings/:id/reject", async (req): Promise<AreaWarning> => {
    const store = defaultStore();
    const w = await store.getAreaWarning(req.params.id);
    if (!w) throw new HttpError(404, "not_found", `Area warning "${req.params.id}" not found`);
    if (w.status !== "needs_approval") throw new HttpError(409, "conflict", `Area warning is already "${w.status}"`);
    const rejected: AreaWarning = { ...w, status: "rejected" };
    await store.saveAreaWarning(rejected);
    const who = req.body?.rejectedBy?.trim() || "An official";
    await emitStep({ runId: rejected.runId, actor: "Human approval", kind: "info", status: "fail", summary: `${who} rejected the ${rejected.district} district ${rejected.kind} warning${req.body?.reason ? `: ${req.body.reason}` : ""}`.slice(0, 200) });
    return rejected;
  });
}
