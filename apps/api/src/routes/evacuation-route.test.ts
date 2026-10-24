// Query validation for GET /regions/:id/evacuation-route (rejected before any database access).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildServer } from "../server";
import { parseEvacuationQuery } from "./evacuation-route";

test("bad queries → 400 with the shared ApiError shape (also allowed, not 403, under PUBLIC_DEMO)", async () => {
  const app = buildServer({ serveWeb: false, publicDemo: true });
  try {
    for (const qs of ["lat=5.3", "lng=abc&lat=5.3", "lng=102&lat=95", "lng=102&lat=5.3&travel=plane", "lng=102&lat=5.3&people=0", "lng=102&lat=5.3&people=2.5", "lng=102&lat=5.3&mode=past", "lng=102&lat=5.3&ts=yesterday"]) {
      const res = await app.inject({ url: `/api/regions/kelantan/evacuation-route?${qs}` });
      assert.equal(res.statusCode, 400, qs);
      const body = res.json();
      assert.equal(body.error.code, "bad_request", qs);
      assert.equal(typeof body.error.message, "string");
    }
  } finally {
    await app.close();
  }
});

test("defaults: travel car, mode live, people 1; date-only ts = end of that day in Malaysia time", () => {
  const q = parseEvacuationQuery({ lng: "102.1", lat: "5.3" });
  assert.deepEqual([q.travel, q.mode, q.people, q.centreId], ["car", "live", 1, null]);
  assert.equal(parseEvacuationQuery({ lng: "102.1", lat: "5.3", ts: "2014-12-24", mode: "replay" }).ts.toISOString(), "2014-12-24T15:59:59.000Z");
});
