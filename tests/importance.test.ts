/**
 * Tests for src/importance.ts (shared importance scorer)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sigmoid, heuristicImportance, scoreImportance } from "../src/importance.js";

describe("sigmoid", () => {
  it("maps 0 to 0.5", () => {
    assert.ok(Math.abs(sigmoid(0) - 0.5) < 0.001);
  });

  it("maps large positive to ~1", () => {
    assert.ok(sigmoid(10) > 0.99);
  });

  it("maps large negative to ~0", () => {
    assert.ok(sigmoid(-10) < 0.01);
  });

  it("is monotonically increasing", () => {
    assert.ok(sigmoid(-5) < sigmoid(0));
    assert.ok(sigmoid(0) < sigmoid(5));
  });
});

describe("heuristicImportance", () => {
  it("returns baseline 0.3 for no triggers", () => {
    assert.equal(heuristicImportance("The quick brown fox jumps over the lazy dog"), 0.3);
  });

  it("returns 0.6 for one trigger match", () => {
    // Only "remember" matches
    assert.equal(heuristicImportance("Please remember this setting"), 0.6);
  });

  it("returns 0.8 for two trigger matches", () => {
    // "prefer" + "i ... prefer" both match
    assert.equal(heuristicImportance("I prefer dark mode for all editors"), 0.8);
  });

  it("returns 0.9 for three or more trigger matches", () => {
    // "remember" + "prefer" + "important" + "i prefer"
    assert.equal(heuristicImportance("Remember that I prefer this, it's important"), 0.9);
  });
});

describe("scoreImportance", () => {
  it("falls back to heuristic on network error", async () => {
    const scores = await scoreImportance(
      ["I prefer dark mode", "The quick brown fox"],
      "http://localhost:1/nonexistent",
      "test-model",
    );
    assert.equal(scores.length, 2);
    // Should fallback to heuristic: "prefer" + "i prefer" triggers → 0.8, no trigger → 0.3
    assert.equal(scores[0], 0.8);
    assert.equal(scores[1], 0.3);
  });

  it("returns correct length for empty input", async () => {
    const scores = await scoreImportance([], "http://localhost:1/x", "m");
    assert.equal(scores.length, 0);
  });
});
