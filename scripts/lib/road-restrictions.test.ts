import { test } from "node:test";
import assert from "node:assert/strict";
import { restrictions } from "./road-restrictions";

test("oneway: explicit tags and roundabouts", () => {
  assert.equal(restrictions({ oneway: "yes" }).oneway, "forward");
  assert.equal(restrictions({ oneway: "-1" }).oneway, "reverse");
  assert.equal(restrictions({ oneway: "no" }).oneway, "no");
  assert.equal(restrictions({ junction: "roundabout" }).oneway, "forward");
  assert.equal(restrictions({}).oneway, undefined); // untagged ≠ two-way
});

test("bridge, access, surface copied; maxweight parsed in tonnes only", () => {
  assert.deepEqual(restrictions({ bridge: "yes", access: "private", surface: "unpaved", maxweight: "36" }), { bridge: true, access: "private", maxweightT: 36, surface: "unpaved" });
  assert.equal(restrictions({ bridge: "no" }).bridge, undefined);
  assert.equal(restrictions({ maxweight: "15 t" }).maxweightT, 15);
  assert.equal(restrictions({ maxweight: "5000 lbs" }).maxweightT, undefined);
});
