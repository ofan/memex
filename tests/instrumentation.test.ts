/**
 * Tests that Stopwatch-based timing instrumentation flows through
 * retriever, tools, and auto-recall track() calls.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { createRetriever } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

const VECTOR_DIM = 8;

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

function createMockEmbedder(): Embedder {
  return {
    get model() { return "test-mock"; },
    dimensions: VECTOR_DIM,
    embedQuery: async (_text: string) => makeVector(42),
    embedPassage: async (_text: string) => makeVector(42),
    embed: async (_text: string) => makeVector(42),
    embedBatchPassage: async (texts: string[]) => texts.map((_, i) => makeVector(i)),
    test: async () => ({ success: true as const, dimensions: VECTOR_DIM, model: "test-mock", hasFtsSupport: true }),
    cacheStats: { size: 0, hits: 0, misses: 0, hitRate: "0%" },
  } as any as Embedder;
}

// ============================================================================
// Retriever lastTimings
// ============================================================================

describe("MemoryRetriever lastTimings", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "retriever-timing-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("populates lastTimings with _ms keys after hybrid retrieve()", async () => {
    // Seed a memory so retrieval has something to work with
    await store.store({
      text: "User prefers dark mode",
      vector: makeVector(1),
      category: "preference",
      scope: "global",
      importance: 0.8,
    });

    const retriever = createRetriever(store, createMockEmbedder(), {
      mode: "hybrid",
      minScore: 0, // Accept all results so pipeline runs fully
    });
    const results = await retriever.retrieve({ query: "dark mode preference", limit: 3 });

    const timings = retriever.lastTimings;
    assert.equal(typeof timings.embed_ms, "number", "should have embed_ms");
    assert.equal(typeof timings.search_ms, "number", "should have search_ms");
    assert.equal(typeof timings.fuse_ms, "number", "should have fuse_ms");
    assert.equal(typeof timings.score_ms, "number", "should have score_ms");
    assert.equal(typeof timings.total_ms, "number", "should have total_ms");
    assert.ok(timings.total_ms >= 0, "total_ms should be non-negative");
  });

  it("populates lastTimings after vector-only retrieve()", async () => {
    await store.store({
      text: "test memory",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    // Force vector-only mode
    const retriever = createRetriever(store, createMockEmbedder(), { mode: "vector" });
    await retriever.retrieve({ query: "test", limit: 3 });

    const timings = retriever.lastTimings;
    assert.equal(typeof timings.embed_ms, "number", "should have embed_ms");
    assert.equal(typeof timings.search_ms, "number", "should have search_ms");
    assert.equal(typeof timings.score_ms, "number", "should have score_ms");
    assert.equal(typeof timings.total_ms, "number", "should have total_ms");
  });

  it("starts with empty lastTimings before first retrieve()", () => {
    const retriever = createRetriever(store, createMockEmbedder());
    const timings = retriever.lastTimings;
    assert.deepEqual(timings, {});
  });

  it("includes rerank_ms even when reranker is disabled (near-zero)", async () => {
    await store.store({
      text: "no reranker here",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    const retriever = createRetriever(store, createMockEmbedder(), {
      rerank: "none",
      minScore: 0,
    });
    await retriever.retrieve({ query: "reranker test", limit: 3 });

    const timings = retriever.lastTimings;
    // rerank lap fires even when skipped — should be near-zero
    assert.equal(typeof timings.rerank_ms, "number");
    assert.ok(timings.rerank_ms < 50, `rerank_ms should be near-zero when disabled, got ${timings.rerank_ms}`);
  });
});

// ============================================================================
// Tool track() calls include timing
// ============================================================================

describe("tool track() calls include _ms timing fields", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "tool-timing-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("recall tool includes total_ms in track payload", async () => {
    await store.store({
      text: "test memory for timing",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    const embedder = createMockEmbedder();
    const retriever = createRetriever(store, embedder);
    const { createMockPluginApi } = await import("./helpers/plugin-mock.js");
    const api = createMockPluginApi();

    const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
    const { registerMemoryRecallTool } = await import("../src/tools.js");
    const { createScopeManager } = await import("../src/scopes.js");

    registerMemoryRecallTool(api as any, {
      retriever,
      store,
      scopeManager: createScopeManager(),
      embedder,
      agentId: undefined,
      track: (event: string, props?: Record<string, unknown>) => {
        tracked.push({ event, props: props || {} });
      },
    } as any);

    await api.executeTool("memory_recall", { query: "test timing" });

    const recallEvent = tracked.find(t => t.event === "recall");
    assert.ok(recallEvent, "should have tracked a recall event");
    assert.equal(typeof recallEvent!.props.total_ms, "number", "recall should include total_ms");
  });

  it("store tool includes total_ms in track payload", async () => {
    const embedder = createMockEmbedder();
    const retriever = createRetriever(store, embedder);
    const { createMockPluginApi } = await import("./helpers/plugin-mock.js");
    const api = createMockPluginApi();

    const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
    const { registerMemoryStoreTool } = await import("../src/tools.js");
    const { createScopeManager } = await import("../src/scopes.js");

    registerMemoryStoreTool(api as any, {
      retriever,
      store,
      scopeManager: createScopeManager(),
      embedder,
      agentId: undefined,
      track: (event: string, props?: Record<string, unknown>) => {
        tracked.push({ event, props: props || {} });
      },
    } as any);

    await api.executeTool("memory_store", { text: "Something to remember", importance: 0.7 });

    const storeEvent = tracked.find(t => t.event === "store");
    assert.ok(storeEvent, "should have tracked a store event");
    assert.equal(typeof storeEvent!.props.total_ms, "number", "store should include total_ms");
  });

  it("forget tool includes total_ms in track payload", async () => {
    const embedder = createMockEmbedder();
    const retriever = createRetriever(store, embedder);

    // Store a memory to forget
    const entry = await store.store({
      text: "memory to forget",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    const { createMockPluginApi } = await import("./helpers/plugin-mock.js");
    const api = createMockPluginApi();

    const tracked: Array<{ event: string; props: Record<string, unknown> }> = [];
    const { registerMemoryForgetTool } = await import("../src/tools.js");
    const { createScopeManager } = await import("../src/scopes.js");

    registerMemoryForgetTool(api as any, {
      retriever,
      store,
      scopeManager: createScopeManager(),
      embedder,
      agentId: undefined,
      track: (event: string, props?: Record<string, unknown>) => {
        tracked.push({ event, props: props || {} });
      },
    } as any);

    await api.executeTool("memory_forget", { memoryId: entry.id });

    const forgetEvent = tracked.find(t => t.event === "forget");
    assert.ok(forgetEvent, "should have tracked a forget event");
    assert.equal(typeof forgetEvent!.props.total_ms, "number", "forget should include total_ms");
  });
});
