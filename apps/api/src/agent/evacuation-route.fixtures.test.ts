// The shared fixtures for GET /evacuation-route must match the shared schema (A builds against them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { EvacuationRouteSchema } from "@monsoonwatch/shared";

const dir = new URL("../../../../packages/shared/fixtures/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.startsWith("evacuation-route."));

test("evacuation-route fixtures exist", () => assert.ok(files.length >= 3));

for (const f of files) {
  test(`fixture ${f} matches EvacuationRouteSchema and its own rules`, () => {
    const r = EvacuationRouteSchema.parse(JSON.parse(readFileSync(new URL(f, dir), "utf8")));
    if (r.status === "ok") {
      assert.equal(r.reason, null);
      assert.ok(r.geometry && r.geometry.coordinates.length >= 2);
      for (const s of r.steps) assert.ok(s.endIndex < r.geometry.coordinates.length);
    } else {
      assert.ok(r.reason);
      assert.equal(r.geometry, null);
      assert.deepEqual(r.steps, []);
    }
    if (r.hazards.status !== "assessed") assert.notEqual(r.hazards.crossesFlood, false, "false only when fully assessed");
  });
}
