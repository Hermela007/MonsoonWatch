import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildServer } from "./server";

test("deployment serves the UI and immutable assets while preserving API errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "monsoonwatch-web-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>MonsoonWatch</title>");
  await writeFile(join(root, "assets", "app-123.js"), "console.log('demo');");
  const app = buildServer({ webRoot: root });
  try {
    const page = await app.inject({ url: "/" });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers["content-type"]!, /text\/html/);
    assert.match(page.body, /MonsoonWatch/);
    assert.equal(page.headers["cache-control"], "no-cache");
    const asset = await app.inject({ url: "/assets/app-123.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.headers["cache-control"]!, /immutable/);
    const health = await app.inject({ url: "/api/health" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().ok, true);
    for (const url of ["/api/unknown", "/.env", "/package.json", "/assets/missing.js"]) {
      const missing = await app.inject({ url });
      assert.equal(missing.statusCode, 404, url);
      assert.equal(missing.json().error.code, "not_found");
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("public demo rejects operator mutations before they can call services", async () => {
  const app = buildServer({ serveWeb: false, publicDemo: true });
  try {
    assert.equal((await app.inject({ url: "/api/health" })).json().readOnly, true);
    for (const url of ["/api/agent/run", "/api/replay/start", "/api/replay/stop", "/api/alerts/test/approve", "/api/alerts/test/reject"]) {
      const res = await app.inject({ method: "POST", url, payload: { regionId: "kelantan" } });
      assert.equal(res.statusCode, 403, url);
      assert.match(res.json().error.message, /Operator actions are restricted/);
    }
  } finally { await app.close(); }
});
