// C8: Saint (Thea) handoff over WhatsApp — Thea's guest access is WhatsApp-only (no web/API/email),
// so a human stays in the loop on both sides (docs/saint-brief.md):
//   GET  /saint/tasks?alertId=&status=         list Saint tasks (newest first)
//   GET  /saint/tasks/:id/handoff              the brief + a wa.me link that pre-fills it to Thea
//                                              (target "area_warning" → brief from area_warnings)
//   POST /saint/tasks/:id/handed-off {by}      the official sent it → task in_progress (+ HUD step)
//   POST /saint/updates {text}                 paste Thea's report; every "MW CHECKIN …" line is applied
// Writes go to MongoDB only; change streams relay saint.task / evac.updated to the UI.
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { COLLECTIONS, type Alert, type AreaWarning, type EvacCentre, type SaintTask, type Village } from "@monsoonwatch/shared";
import { emitStep } from "../agent/steps";
import { getDb } from "../db/client";
import { env } from "../env";
import { HttpError } from "../errors";
import { AREA_BRIEF_MAX_VILLAGES, buildAreaBrief, buildBrief, whatsappUrl } from "../saint/brief";
import { normaliseName, parseCheckins, type Checkin } from "../saint/checkin";

const STATUSES: SaintTask["status"][] = ["queued", "in_progress", "awaiting_approval", "done", "failed"];

async function requireTask(id: string): Promise<SaintTask> {
  const task = await (await getDb()).collection<SaintTask>(COLLECTIONS.saintTasks).findOne({ _id: id });
  if (!task) throw new HttpError(404, "not_found", `Saint task "${id}" not found`);
  return task;
}

async function loadAlertContext(alertId: string) {
  const db = await getDb();
  const alert = await db.collection<Alert>(COLLECTIONS.alerts).findOne({ _id: alertId });
  if (!alert) return null;
  const [village, centre] = await Promise.all([
    db.collection<Village>(COLLECTIONS.villages).findOne({ _id: alert.villageId }, { projection: { name: 1, district: 1 } }),
    db.collection<EvacCentre>(COLLECTIONS.evacCentres).findOne({ _id: alert.evacCentreId }),
  ]);
  return { alert, village, centre };
}

async function loadAreaWarning(id: string): Promise<AreaWarning | null> {
  return (await getDb()).collection<AreaWarning>(COLLECTIONS.areaWarnings).findOne({ _id: id });
}

/**
 * What a check-in's alert= id points to: an Alert (with its planned centre) or an approved AreaWarning
 * (no centre: matched by name in the region). Alerts are tried first; ids never overlap ("area:…"/"advisory:…").
 */
async function loadCheckinTarget(id: string): Promise<{ regionId: string; runId: string; centre: EvacCentre | null } | null> {
  const ctx = await loadAlertContext(id);
  if (ctx) return { regionId: ctx.alert.regionId, runId: ctx.alert.runId, centre: ctx.centre };
  const w = await loadAreaWarning(id);
  return w ? { regionId: w.regionId, runId: w.runId, centre: null } : null;
}

const approvedOrSent = (status: string) => status === "approved" || status === "sent";

export async function saintRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { alertId?: string; status?: string } }>("/saint/tasks", async (req): Promise<SaintTask[]> => {
    const filter: Record<string, string> = {};
    if (req.query.alertId) filter.alertId = req.query.alertId;
    if (req.query.status) {
      if (!STATUSES.includes(req.query.status as SaintTask["status"])) throw new HttpError(400, "bad_request", `"status" must be one of ${STATUSES.join(", ")}`);
      filter.status = req.query.status;
    }
    return (await getDb()).collection<SaintTask>(COLLECTIONS.saintTasks).find(filter).sort({ ts: -1 }).limit(200).toArray();
  });

  app.get<{ Params: { id: string } }>("/saint/tasks/:id/handoff", async (req) => {
    const task = await requireTask(req.params.id);
    if (task.target === "area_warning") {
      const warning = await loadAreaWarning(task.alertId);
      if (!warning) throw new HttpError(404, "not_found", `Area warning "${task.alertId}" for Saint task "${task._id}" not found`);
      if (!approvedOrSent(warning.status)) {
        throw new HttpError(409, "conflict", `Area warning is "${warning.status}"; only approved warnings are handed to Saint`);
      }
      const ids = warning.villageIds.slice(0, AREA_BRIEF_MAX_VILLAGES);
      const docs = await (await getDb()).collection<Village>(COLLECTIONS.villages).find({ _id: { $in: ids } }, { projection: { name: 1 } }).toArray();
      const names = new Map(docs.map((v) => [v._id, v.name]));
      const brief = buildAreaBrief({ taskId: task._id, warning, villageNames: ids.map((id) => names.get(id) ?? id) });
      const url = whatsappUrl(env.saintWhatsapp, brief);
      return {
        taskId: task._id,
        alertId: task.alertId,
        brief,
        whatsappUrl: url,
        ...(url ? {} : { note: "SAINT_WHATSAPP is not set in .env — copy the brief into WhatsApp manually" }),
      };
    }
    const ctx = await loadAlertContext(task.alertId);
    if (!ctx) throw new HttpError(404, "not_found", `Alert "${task.alertId}" for Saint task "${task._id}" not found`);
    if (!approvedOrSent(ctx.alert.status)) {
      throw new HttpError(409, "conflict", `Alert is "${ctx.alert.status}"; only approved alerts are handed to Saint`);
    }
    const brief = buildBrief({ taskId: task._id, alert: ctx.alert, village: ctx.village, centre: ctx.centre });
    const url = whatsappUrl(env.saintWhatsapp, brief);
    return {
      taskId: task._id,
      alertId: task.alertId,
      brief,
      whatsappUrl: url,
      ...(url ? {} : { note: "SAINT_WHATSAPP is not set in .env — copy the brief into WhatsApp manually" }),
    };
  });

  app.post<{ Params: { id: string }; Body: { by?: string } }>("/saint/tasks/:id/handed-off", async (req): Promise<SaintTask> => {
    const by = req.body?.by?.trim();
    if (!by) throw new HttpError(400, "bad_request", `"by" is required: who sent the brief to Saint`);
    const task = await requireTask(req.params.id);
    if (task.status !== "queued") return task; // idempotent: already handed off
    const db = await getDb();
    const updated: SaintTask = {
      ...task,
      status: "in_progress",
      ts: new Date().toISOString(),
      detail: `${task.detail} · Brief sent to Saint (Thea) on WhatsApp by ${by}`,
    };
    await db.collection<SaintTask>(COLLECTIONS.saintTasks).replaceOne({ _id: task._id }, updated);
    const isArea = task.target === "area_warning";
    const source = isArea
      ? await db.collection<AreaWarning>(COLLECTIONS.areaWarnings).findOne({ _id: task.alertId }, { projection: { runId: 1 } })
      : await db.collection<Alert>(COLLECTIONS.alerts).findOne({ _id: task.alertId }, { projection: { runId: 1 } });
    await emitStep({ runId: source?.runId ?? `saint-${task._id}`, actor: "Saint", kind: "saint", status: "ok", summary: `${by} handed the approved ${isArea ? "district warning" : "alert"} to Saint (Thea) on WhatsApp` });
    return updated;
  });

  app.post<{ Body: { text?: string; by?: string } }>("/saint/updates", async (req) => {
    const text = req.body?.text ?? "";
    if (!text.trim()) throw new HttpError(400, "bad_request", `"text" is required: paste Saint's WhatsApp report`);
    const { checkins, errors } = parseCheckins(text);
    if (checkins.length === 0) {
      throw new HttpError(400, "bad_request", errors.length ? `No valid MW CHECKIN line: ${errors.map((e) => e.reason).join("; ")}` : `No "MW CHECKIN" line found in the pasted text`);
    }
    const db = await getDb();
    const tasks = db.collection<SaintTask>(COLLECTIONS.saintTasks);
    const centres = db.collection<EvacCentre>(COLLECTIONS.evacCentres);
    const applied: (Checkin & { centreId: string; taskId: string })[] = [];
    const skipped: { line: string; reason: string }[] = [];
    const failed = [...errors];

    for (const c of checkins) {
      const ctx = await loadCheckinTarget(c.alertId);
      if (!ctx) { failed.push({ line: c.raw, reason: `alert or area warning "${c.alertId}" not found` }); continue; }
      // Resolve the centre: the alert's own centre if the name matches, else a unique name match in the region
      // (always the name match for an area warning, which has no planned centre).
      let centre = ctx.centre && normaliseName(ctx.centre.name) === normaliseName(c.centre) ? ctx.centre : null;
      if (!centre) {
        const want = normaliseName(c.centre);
        const candidates = (await centres.find({ regionId: ctx.regionId }, { projection: { name: 1, capacity: 1, headcount: 1, regionId: 1 } }).toArray())
          .filter((x) => normaliseName(x.name) === want || normaliseName(x.name).includes(want));
        if (candidates.length !== 1) {
          failed.push({ line: c.raw, reason: candidates.length ? `centre "${c.centre}" is ambiguous (${candidates.length} matches)` : `centre "${c.centre}" not found` });
          continue;
        }
        centre = candidates[0]!;
      }
      // Idempotency: one log_checkin task per distinct line, so pasting the same report twice changes nothing.
      const taskId = `checkin-${createHash("sha1").update(c.raw.toLowerCase()).digest("hex").slice(0, 16)}`;
      const task: SaintTask = {
        _id: taskId,
        alertId: c.alertId,
        ts: new Date().toISOString(),
        type: "log_checkin",
        status: "done",
        detail: `Saint (via WhatsApp): ${c.people} people ${c.status} → ${centre.name}${req.body?.by ? ` · logged by ${req.body.by}` : ""}`,
      };
      try {
        await tasks.insertOne(task);
      } catch (err) {
        if ((err as { code?: number }).code === 11000) { skipped.push({ line: c.raw, reason: "already applied" }); continue; }
        throw err;
      }
      if (c.status === "arrived") {
        await centres.updateOne({ _id: centre._id }, { $inc: { headcount: c.people }, $set: { headcountUpdatedAt: new Date().toISOString() } as never });
      }
      // The original send_alert task is done once the leader has responded.
      await tasks.updateMany({ alertId: c.alertId, type: "send_alert", status: { $in: ["queued", "in_progress"] } }, { $set: { status: "done", ts: new Date().toISOString() } });
      await emitStep({
        runId: ctx.runId,
        actor: "Saint",
        kind: "saint",
        status: "ok",
        summary: `Leader report via WhatsApp: ${c.people} people ${c.status} → ${centre.name}${c.status === "arrived" ? " (headcount updated)" : ""}`,
      });
      applied.push({ ...c, centreId: centre._id, taskId });
    }
    return { applied, skipped, errors: failed };
  });
}
