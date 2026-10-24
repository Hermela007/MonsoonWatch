// District warnings get the same human step as alerts: list → approve (→ Saint task) / reject.
// Memory store (MOCK=1) and no Gemini key, so nothing reaches MongoDB or Gemini (the spoken
// version fails quietly and is logged as a HUD step).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { AreaWarning } from "@monsoonwatch/shared";

process.env.MOCK = "1";
process.env.GEMINI_API_KEY = "";
process.env.MONGODB_URI = "";

const { buildServer } = await import("../server");
const { defaultStore } = await import("../agent/store");

const fixture = (name: string): AreaWarning =>
  JSON.parse(readFileSync(new URL(`../../../../packages/shared/fixtures/area-warning.${name}.json`, import.meta.url), "utf8"));

test("list, approve (→ Saint task) and reject district warnings", async () => {
  const store = defaultStore() as ReturnType<typeof defaultStore> & { saintTasks?: unknown[] };
  const evac = { ...fixture("evacuate"), _id: "area:t1:at_risk:Kuala Krai:flood", runId: "t1" };
  const adv = { ...fixture("advisory"), _id: "advisory:t1:watch:Kuala Krai:flood", runId: "t1" };
  await store.saveAreaWarning(adv);
  await store.saveAreaWarning(evac);
  const app = buildServer({ serveWeb: false, publicDemo: false });
  try {
    assert.equal((await app.inject({ url: "/api/area-warnings" })).statusCode, 400);
    const list = (await app.inject({ url: "/api/area-warnings?runId=t1" })).json() as AreaWarning[];
    assert.deepEqual(list.map((w) => w.kind), ["evacuate", "advisory"]);

    const url = `/api/area-warnings/${encodeURIComponent(evac._id)}`;
    assert.equal((await app.inject({ method: "POST", url: `${url}/approve`, payload: {} })).statusCode, 400);
    const ok = await app.inject({ method: "POST", url: `${url}/approve`, payload: { approvedBy: "Pegawai Daerah" } });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().status, "approved");
    assert.equal((await store.getAreaWarning(evac._id))!.approvedBy, "Pegawai Daerah");
    const task = (store.saintTasks ?? []).at(-1) as { alertId: string; target: string; detail: string };
    assert.equal(task.alertId, evac._id);
    assert.equal(task.target, "area_warning");
    assert.match(task.detail, /officials must arrange transport/);
    assert.equal((await app.inject({ method: "POST", url: `${url}/approve`, payload: { approvedBy: "x" } })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: `${url}/reject`, payload: {} })).statusCode, 409);

    const rej = await app.inject({ method: "POST", url: `/api/area-warnings/${encodeURIComponent(adv._id)}/reject`, payload: { reason: "test" } });
    assert.equal(rej.json().status, "rejected");
    assert.equal((await app.inject({ method: "POST", url: "/api/area-warnings/nope/approve", payload: { approvedBy: "x" } })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test("public demo blocks approving district warnings", async () => {
  const app = buildServer({ serveWeb: false, publicDemo: true });
  try {
    const res = await app.inject({ method: "POST", url: "/api/area-warnings/x/approve", payload: { approvedBy: "x" } });
    assert.notEqual(res.statusCode, 200);
    assert.equal((await app.inject({ url: "/api/area-warnings?runId=t1" })).statusCode, 200);
  } finally {
    await app.close();
  }
});
