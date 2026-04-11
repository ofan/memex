import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InTurnRecallCache } from "../src/recall-cache.js";

describe("InTurnRecallCache", () => {
  it("returns null on miss", () => {
    const cache = new InTurnRecallCache();
    assert.equal(cache.get("main", "session-1", "what is x?"), null);
  });

  it("returns the entry on hit with matching query", () => {
    const cache = new InTurnRecallCache();
    cache.set("main", "session-1", "what is x?", {
      context: "x = 42",
      recalledIds: ["mem-1", "mem-2"],
    });
    const hit = cache.get("main", "session-1", "what is x?");
    assert.deepEqual(hit, { context: "x = 42", recalledIds: ["mem-1", "mem-2"] });
  });

  it("returns null when query differs (new user message in same session)", () => {
    const cache = new InTurnRecallCache();
    cache.set("main", "session-1", "what is x?", {
      context: "x = 42",
      recalledIds: ["mem-1"],
    });
    assert.equal(cache.get("main", "session-1", "what is y?"), null);
  });

  it("scopes entries by sessionKey", () => {
    const cache = new InTurnRecallCache();
    cache.set("main", "session-1", "shared query", {
      context: "ctx-A",
      recalledIds: ["mem-A"],
    });
    cache.set("main", "session-2", "shared query", {
      context: "ctx-B",
      recalledIds: ["mem-B"],
    });
    assert.equal(cache.get("main", "session-1", "shared query")?.context, "ctx-A");
    assert.equal(cache.get("main", "session-2", "shared query")?.context, "ctx-B");
  });

  it("scopes entries by agentId", () => {
    const cache = new InTurnRecallCache();
    cache.set("main", "session-1", "shared query", {
      context: "main-ctx",
      recalledIds: [],
    });
    cache.set("infra", "session-1", "shared query", {
      context: "infra-ctx",
      recalledIds: [],
    });
    assert.equal(cache.get("main", "session-1", "shared query")?.context, "main-ctx");
    assert.equal(cache.get("infra", "session-1", "shared query")?.context, "infra-ctx");
  });

  it("treats undefined sessionKey as a single shared bucket", () => {
    const cache = new InTurnRecallCache();
    cache.set("main", undefined, "q", { context: "default-bucket", recalledIds: [] });
    assert.equal(cache.get("main", undefined, "q")?.context, "default-bucket");
  });

  it("expires entries past TTL", () => {
    let now = 1000;
    const cache = new InTurnRecallCache({ ttlMs: 100, nowFn: () => now });
    cache.set("main", "s", "q", { context: "x", recalledIds: [] });
    assert.equal(cache.get("main", "s", "q")?.context, "x", "fresh entry should hit");
    now = 1099;
    assert.equal(cache.get("main", "s", "q")?.context, "x", "still within TTL");
    now = 1101;
    assert.equal(cache.get("main", "s", "q"), null, "past TTL should miss");
  });

  it("deletes expired entry on miss so size shrinks", () => {
    let now = 1000;
    const cache = new InTurnRecallCache({ ttlMs: 100, nowFn: () => now });
    cache.set("main", "s", "q", { context: "x", recalledIds: [] });
    assert.equal(cache.size(), 1);
    now = 2000;
    cache.get("main", "s", "q");
    assert.equal(cache.size(), 0);
  });

  it("opportunistically GCs expired entries when map grows past maxSize", () => {
    let now = 1000;
    const cache = new InTurnRecallCache({ ttlMs: 100, maxSize: 3, nowFn: () => now });
    // Insert 3 entries that will expire
    cache.set("a", "1", "q", { context: "x", recalledIds: [] });
    cache.set("b", "1", "q", { context: "x", recalledIds: [] });
    cache.set("c", "1", "q", { context: "x", recalledIds: [] });
    assert.equal(cache.size(), 3);
    // Advance past TTL and add a 4th — GC should drop the expired ones
    now = 2000;
    cache.set("d", "1", "q", { context: "x", recalledIds: [] });
    assert.equal(cache.size(), 1, "GC should have dropped a, b, c");
    assert.equal(cache.get("d", "1", "q")?.context, "x", "fresh entry survives GC");
  });

  it("simulates the multi-rebuild agent turn pattern (cache hit on rebuild 2..N)", () => {
    // The actual production pattern: before_prompt_build fires once for the
    // initial build, then again after each tool result. The recall query is
    // the same throughout the turn.
    const cache = new InTurnRecallCache();
    let retrieveCount = 0;

    // Simulate a single agent turn with 5 prompt rebuilds (initial + 4 tool results)
    function rebuild(query: string) {
      const cached = cache.get("main", "agent-turn-xyz", query);
      if (cached) return cached;
      retrieveCount++;
      const fresh = { context: `recalled context for: ${query}`, recalledIds: [`mem-for-${query}`] };
      cache.set("main", "agent-turn-xyz", query, fresh);
      return fresh;
    }

    const query = "What is the deployment rule for the inference host?";
    for (let i = 0; i < 5; i++) {
      const result = rebuild(query);
      assert.ok(result.context.includes(query), "all rebuilds should return the same context");
    }
    assert.equal(retrieveCount, 1, "expected exactly 1 retrieve call across 5 rebuilds");
  });

  it("cache invalidates when the user sends a new message (different query)", () => {
    const cache = new InTurnRecallCache();
    let retrieveCount = 0;

    function rebuild(query: string) {
      const cached = cache.get("main", "session-1", query);
      if (cached) return cached;
      retrieveCount++;
      const fresh = { context: `ctx for ${query}`, recalledIds: [] };
      cache.set("main", "session-1", query, fresh);
      return fresh;
    }

    // First user message: retrieves once, then 3 tool-result rebuilds reuse cache
    rebuild("user message 1");
    rebuild("user message 1");
    rebuild("user message 1");
    rebuild("user message 1");
    assert.equal(retrieveCount, 1);

    // Second user message: cache miss (new query), retrieves again
    rebuild("user message 2");
    assert.equal(retrieveCount, 2);

    // Subsequent rebuilds for message 2 reuse new cache
    rebuild("user message 2");
    rebuild("user message 2");
    assert.equal(retrieveCount, 2);
  });
});
