import { test } from "node:test";
import assert from "node:assert/strict";
import { snippet } from "./snippet";

const long =
  "The 2014 floods began on 15 December. Rain fell for days across the upper basin. " +
  "In Kuala Krai the main road was closed when the river rose above the bridge. " +
  "Hundreds of families sheltered in the district mosque and two schools. " +
  "Relief convoys could not reach Gua Musang for a week. Power was cut to the hospital.";

test("short chunks are returned whole", () => {
  assert.equal(snippet("  Short   passage. ", "anything"), "Short passage.");
});

test("picks the sentence with the most query words and trims to maxChars", () => {
  const s = snippet(long, "where did families shelter", 120);
  assert.ok(s.includes("Hundreds of families sheltered"), s);
  assert.ok(s.length <= 124, `${s.length}: ${s}`);
  assert.ok(s.startsWith("…") || s.endsWith("…"));
});

test("matches Malay/English words case- and accent-insensitively", () => {
  const s = snippet(long, "KUALA KRAI road", 100);
  assert.ok(s.includes("In Kuala Krai the main road was closed"), s);
});

test("an over-long single sentence is cut on a word boundary", () => {
  const s = snippet("word ".repeat(200), "word", 50);
  assert.ok(s.length <= 50, `${s.length}`);
  assert.ok(s.endsWith("…"));
});

test("decimals don't end a sentence", () => {
  const s = snippet("Intro sentence here. " + "x ".repeat(80) + "end. The river reached 26.8 metres at Kuala Krai. More text follows here.", "Kuala Krai river", 60);
  assert.ok(s.includes("26.8 metres"), s);
});
