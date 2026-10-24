import { before, test } from "node:test";
import assert from "node:assert/strict";
import type { Alert } from "@monsoonwatch/shared";
import { audioFile, audioUrl, generateSpokenAlert, orderMessages, wavSeconds } from "./speech";
import { getMemorySteps, memoryStepSink, setStepSink } from "./steps";

before(() => setStepSink(memoryStepSink));

test("Malay first, empty messages skipped", () => {
  const m = orderMessages({ messages: [{ lang: "en", text: "Flood" }, { lang: "xx", text: " " }, { lang: "ms", text: "Banjir" }] }, ["ms", "en"]);
  assert.deepEqual(m.map((x) => x.lang), ["ms", "en"]);
});

test("WAV length from bytes (24 kHz mono 16-bit)", () => {
  assert.equal(wavSeconds(44 + 48_000 * 12), 12);
});

test("file names are safe and URLs are stable", () => {
  assert.match(audioFile("run-1:kg/../x:1", "ms").pathname, /run-1_kg_.._x_1\.ms\.wav$/);
  assert.equal(audioUrl("run-1:kg:1", "en"), "/api/alerts/run-1%3Akg%3A1/audio/en");
});

test("never speaks an alert that is not approved (no TTS call)", async () => {
  const alert = { _id: "a1", runId: "tts-guard", status: "verified", messages: [{ lang: "ms", text: "x" }] } as unknown as Alert;
  assert.deepEqual(await generateSpokenAlert(alert), []);
  assert.ok(getMemorySteps("tts-guard").some((s) => s.status === "fail" && /not approved/.test(s.summary)));
});
