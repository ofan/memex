/**
 * Tests for `memoryAgents` config key — the unified replacement for
 * autoRecallAgents + autoCaptureAgents (issue #30).
 *
 * Backward-compat semantics: union of memoryAgents and the legacy specific
 * key. Legacy keys never restrict; they only extend.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeAgentLists } from "../src/agent-merge.js";

describe("mergeAgentLists (issue #30 — memoryAgents config)", () => {
  it("returns undefined when both inputs are absent", () => {
    assert.equal(mergeAgentLists(undefined, undefined), undefined);
  });

  it("returns undefined when both inputs are non-arrays", () => {
    assert.equal(mergeAgentLists("main", 42), undefined);
  });

  it("returns the unified list when only memoryAgents is set", () => {
    assert.deepEqual(mergeAgentLists(["main", "virgil"], undefined), ["main", "virgil"]);
  });

  it("returns the legacy list when only the legacy key is set (back-compat)", () => {
    assert.deepEqual(mergeAgentLists(undefined, ["coder"]), ["coder"]);
  });

  it("unions both lists when both are set, deduping", () => {
    const result = mergeAgentLists(["main", "virgil"], ["main", "coder"]);
    assert.deepEqual(result?.sort(), ["coder", "main", "virgil"]);
  });

  it("returns undefined for empty arrays on both sides (treats as no whitelist)", () => {
    assert.equal(mergeAgentLists([], []), undefined);
  });

  it("preserves a single non-empty side when the other is empty array", () => {
    assert.deepEqual(mergeAgentLists([], ["main"]), ["main"]);
    assert.deepEqual(mergeAgentLists(["main"], []), ["main"]);
  });
});
