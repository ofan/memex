/**
 * Tests for Stopwatch timing utility and telemetry track schema.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Stopwatch } from "../src/telemetry.ts";

describe("Stopwatch", () => {
  it("records lap times as {name}_ms properties", () => {
    const sw = new Stopwatch();
    sw.lap("embed");
    sw.lap("search");

    const t = sw.timings;
    assert.equal(typeof t.embed_ms, "number");
    assert.equal(typeof t.search_ms, "number");
    assert.equal(typeof t.total_ms, "number");
  });

  it("lap returns delta since previous lap", async () => {
    const sw = new Stopwatch();
    // Busy-wait ~20ms to get a measurable delta
    const start = Date.now();
    while (Date.now() - start < 20) { /* spin */ }

    const delta = sw.lap("wait");
    assert.ok(delta >= 15, `Expected >= 15ms, got ${delta}ms`);
  });

  it("total_ms covers full elapsed time", async () => {
    const sw = new Stopwatch();
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }
    sw.lap("a");
    while (Date.now() - start < 20) { /* spin */ }
    sw.lap("b");

    const t = sw.timings;
    assert.ok(t.total_ms >= t.a_ms + t.b_ms - 1, "total should be >= sum of laps (minus rounding)");
  });

  it("timings are empty when no laps recorded", () => {
    const sw = new Stopwatch();
    const t = sw.timings;
    assert.ok("total_ms" in t);
    // Only total_ms, no lap keys
    const keys = Object.keys(t).filter(k => k !== "total_ms");
    assert.equal(keys.length, 0);
  });

  it("skipped phases produce no key (optional fields)", () => {
    const sw = new Stopwatch();
    sw.lap("embed");
    // No "rerank" lap — simulates reranker being off
    sw.lap("score");

    const t = sw.timings;
    assert.equal(typeof t.embed_ms, "number");
    assert.equal(typeof t.score_ms, "number");
    assert.equal(t.rerank_ms, undefined, "rerank_ms should be absent when not lapped");
  });
});
