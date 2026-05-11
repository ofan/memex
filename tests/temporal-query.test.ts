/**
 * Unit tests for src/temporal.ts — detectTemporalRange()
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectTemporalRange } from "../src/temporal.js";

const MS_PER_DAY = 86_400_000;

// Fixed "now" for deterministic tests: 2026-04-07T12:00:00Z
const NOW = new Date("2026-04-07T12:00:00Z").getTime();

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const TODAY_START = startOfDay(NOW);

describe("detectTemporalRange", () => {
  // =====================================================================
  // Positive detections
  // =====================================================================

  it("detects 'yesterday'", () => {
    const result = detectTemporalRange("what happened yesterday", NOW);
    assert.ok(result, "should return a range");
    const [start, end] = result;
    assert.equal(start, TODAY_START - MS_PER_DAY);
    assert.equal(end, NOW);
  });

  it("detects 'last week'", () => {
    const result = detectTemporalRange("what happened last week", NOW);
    assert.ok(result, "should return a range");
    const [start, end] = result;
    assert.equal(start, TODAY_START - 7 * MS_PER_DAY);
    assert.equal(end, NOW);
  });

  it("detects 'last month'", () => {
    const result = detectTemporalRange("updates from last month", NOW);
    assert.ok(result, "should return a range");
    const [start, end] = result;
    assert.equal(start, TODAY_START - 30 * MS_PER_DAY);
    assert.equal(end, NOW);
  });

  it("detects 'in March'", () => {
    const result = detectTemporalRange("meetings in March", NOW);
    assert.ok(result, "should return a range");
    const [start, end] = result;
    // March 2026 (current year, March is before April so same year)
    assert.equal(start, new Date(2026, 2, 1).getTime());
    // End should be last moment of March
    assert.ok(end <= new Date(2026, 3, 1).getTime());
  });

  it("detects '2 days ago'", () => {
    const result = detectTemporalRange("what happened 2 days ago", NOW);
    assert.ok(result, "should return a range");
    const [start, end] = result;
    assert.equal(start, TODAY_START - 2 * MS_PER_DAY);
    assert.equal(end, NOW);
  });

  it("detects '3 weeks ago'", () => {
    const result = detectTemporalRange("tasks from 3 weeks ago", NOW);
    assert.ok(result, "should return a range");
    const [start, end] = result;
    assert.equal(start, TODAY_START - 21 * MS_PER_DAY);
    assert.equal(end, NOW);
  });

  it("detects 'in January' (past year since Jan < current month Apr)", () => {
    // April 2026, so "in January" refers to January 2026 (same year, Jan < Apr)
    const result = detectTemporalRange("what happened in January", NOW);
    assert.ok(result, "should return a range");
    const [start] = result;
    assert.equal(start, new Date(2026, 0, 1).getTime());
  });

  it("detects 'in December' (previous year since Dec > current month Apr)", () => {
    // April 2026, so "in December" refers to December 2025
    const result = detectTemporalRange("events in December", NOW);
    assert.ok(result, "should return a range");
    const [start] = result;
    assert.equal(start, new Date(2025, 11, 1).getTime());
  });

  it("detects abbreviated month 'in Mar'", () => {
    const result = detectTemporalRange("what happened in mar", NOW);
    assert.ok(result, "should return a range");
    const [start] = result;
    assert.equal(start, new Date(2026, 2, 1).getTime());
  });

  // =====================================================================
  // Negative cases (should return null)
  // =====================================================================

  it("returns null for non-temporal query 'deploy the model'", () => {
    assert.equal(detectTemporalRange("deploy the model", NOW), null);
  });

  it("returns null for 'the week was good'", () => {
    assert.equal(detectTemporalRange("the week was good", NOW), null);
  });

  it("returns null for 'last resort'", () => {
    assert.equal(detectTemporalRange("last resort", NOW), null);
  });

  it("returns null for 'last chance'", () => {
    assert.equal(detectTemporalRange("last chance to finish", NOW), null);
  });

  it("returns null for 'last name'", () => {
    assert.equal(detectTemporalRange("what is their last name", NOW), null);
  });

  // =====================================================================
  // Edge cases
  // =====================================================================

  it("returns null for empty string", () => {
    assert.equal(detectTemporalRange("", NOW), null);
  });

  it("returns null for very long string without temporal phrases", () => {
    const longStr = "This is a test query about deploying models and running experiments. ".repeat(50);
    assert.equal(detectTemporalRange(longStr, NOW), null);
  });

  it("handles very long string with temporal phrase near the start", () => {
    const longStr = "what happened yesterday " + "padding text ".repeat(100);
    const result = detectTemporalRange(longStr, NOW);
    assert.ok(result, "should detect 'yesterday' even in long string");
  });

  it("returns null for null-ish input", () => {
    assert.equal(detectTemporalRange(null as any, NOW), null);
    assert.equal(detectTemporalRange(undefined as any, NOW), null);
  });

  it("detects singular '1 day ago'", () => {
    const result = detectTemporalRange("what happened 1 day ago", NOW);
    assert.ok(result, "should return a range");
    const [start] = result;
    assert.equal(start, TODAY_START - MS_PER_DAY);
  });

  it("detects '1 week ago'", () => {
    const result = detectTemporalRange("tasks from 1 week ago", NOW);
    assert.ok(result, "should return a range");
    const [start] = result;
    assert.equal(start, TODAY_START - 7 * MS_PER_DAY);
  });
});
