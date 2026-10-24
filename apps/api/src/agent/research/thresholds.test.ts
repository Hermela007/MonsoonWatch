import { test } from "node:test";
import assert from "node:assert/strict";
import { checkExtraction, chunkReport, collectSources, toRegionLandslide, type ThresholdExtraction } from "./thresholds";

const raw = {
  steps: [{ type: "model_output", content: [{ type: "text", text: "See report", annotations: [{ type: "url_citation", url: "https://example.org/paper-a", title: "Paper A" }] }] }],
};
const report = "Thresholds for Peninsular Malaysia [1](https://example.org/paper-b).\n\nMore text.";

test("collects sources from annotations and from the report text, deduplicated", () => {
  const s = collectSources(raw, report + " again https://example.org/paper-a");
  assert.deepEqual(s.map((x) => x.url), ["https://example.org/paper-a", "https://example.org/paper-b"]);
  assert.equal(s[0]!.title, "Paper A");
});

const good: ThresholdExtraction = {
  slopeMinDeg: 25, slopeSource: 1,
  rainThresholdsMm: [
    { level: "alert", days: 3, mm: 120, source: 2, quote: "q" },
    { level: "warning", days: 3, mm: 200, source: 2, quote: "q" },
    { level: "danger", days: 3, mm: 300, source: 1, quote: "q" },
  ],
  notes: "",
};

test("a well-cited, plausible extraction passes and maps to Region.landslide", () => {
  const sources = collectSources(raw, report);
  assert.deepEqual(checkExtraction(good, sources), { passed: true, problems: [] });
  const r = toRegionLandslide(good, sources);
  assert.deepEqual(r.rainThresholdsMm, [{ days: 3, mm: 120 }, { days: 3, mm: 200 }, { days: 3, mm: 300 }]);
  assert.equal(r.citations.length, 2);
});

test("invented sources, implausible values and non-rising levels fail", () => {
  const sources = collectSources(raw, report);
  const bad: ThresholdExtraction = {
    ...good, slopeSource: 9,
    rainThresholdsMm: [
      { level: "alert", days: 3, mm: 300, source: 2, quote: "q" },
      { level: "warning", days: 3, mm: 200, source: 7, quote: "q" },
      { level: "danger", days: 90, mm: 5, source: 1, quote: "q" },
    ],
  };
  const r = checkExtraction(bad, sources);
  assert.equal(r.passed, false);
  const all = r.problems.join("\n");
  assert.match(all, /source 9/);
  assert.match(all, /source 7/);
  assert.match(all, /days outside/);
  assert.match(all, /must rise/);
});

test("report chunks stay under the size limit and keep ids stable", () => {
  const long = Array.from({ length: 10 }, (_, i) => `Paragraph ${i} `.repeat(30)).join("\n\n");
  const c = chunkReport("kelantan", "Landslide thresholds", long, undefined, 1000);
  assert.ok(c.length > 1);
  assert.ok(c.every((k) => k.chunk.length <= 1000 && k.kind === "deep_research"));
  assert.equal(c[0]!._id, "dr-landslide-kelantan-1");
});
