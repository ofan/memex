/**
 * Benchmark tests for UnifiedRetriever
 *
 * Task 7: API call counts, pipeline latency overhead, and source diversity.
 * All tests use mock embedder/reranker for deterministic behavior.
 *
 * Run: node --import jiti/register --test tests/unified-retriever-benchmark.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  UnifiedRetriever,
} from "../src/unified-retriever.js";
import type {
  DocumentCandidate,
} from "../src/unified-retriever.js";
import { MemoryStore } from "../src/memory.js";
import type { Embedder } from "../src/embedder.js";

// =============================================================================
// Constants
// =============================================================================

const VECTOR_DIM = 32;

// =============================================================================
// Mock Helpers
// =============================================================================

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

function createCountingEmbedder(): {
  embedder: Embedder;
  getEmbedCalls: () => number;
  resetCounts: () => void;
} {
  let embedCalls = 0;
  const embedder = {
    get model() { return "test-mock"; },
    dimensions: VECTOR_DIM,
    embedQuery: async (_text: string) => {
      embedCalls++;
      return makeVector(42);
    },
    embedPassage: async (_text: string) => makeVector(42),
    embed: async (_text: string) => makeVector(42),
    embedBatchPassage: async (texts: string[]) => texts.map((_, i) => makeVector(i)),
    test: async () => ({ success: true, dimensions: VECTOR_DIM }),
    cacheStats: { size: 0, hits: 0, misses: 0, hitRate: "0%" },
  } as any as Embedder;
  return {
    embedder,
    getEmbedCalls: () => embedCalls,
    resetCounts: () => { embedCalls = 0; },
  };
}

function makeDocCandidate(id: string, title: string, score: number): DocumentCandidate {
  return {
    filepath: `/docs/${id}.md`,
    displayPath: `docs/${id}.md`,
    title,
    body: `Full body content of ${title}. This document contains important information.`,
    bestChunk: `Best chunk of ${title}`,
    bestChunkPos: 0,
    score,
    docid: id,
    context: null,
  };
}

// =============================================================================
// API Call Count Benchmarks
// =============================================================================

describe("UnifiedRetriever Benchmark — API call counts", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ur-bench-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });

    // Seed some memories so vector/bm25 search returns results
    const entries = [
      { text: "User prefers dark mode for all editors", importance: 0.8, category: "preference" as const },
      { text: "Project uses TypeScript with jiti for transpilation", importance: 0.9, category: "fact" as const },
      { text: "Deploy memex by copying to plugin directory", importance: 0.7, category: "decision" as const },
      { text: "Mac Mini runs llama-swap on port 8090", importance: 0.85, category: "fact" as const },
      { text: "Embedding model is Qwen3-Embedding-0.6B-Q8_0", importance: 0.9, category: "fact" as const },
    ];

    for (const e of entries) {
      const vec = makeVector(entries.indexOf(e) + 1);
      await store.store({
        text: e.text,
        vector: vec,
        importance: e.importance,
        category: e.category,
        scope: "global",
        metadata: "{}",
      });
    }
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("factoid lookup (memory-routed, high confidence) uses 1 embed call, no rerank", async () => {
    const { embedder, getEmbedCalls } = createCountingEmbedder();
    let rerankCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
      rerankCalls++;
      return originalFetch(...args);
    };

    try {
      // Memory-only route: "i told you" triggers MEM_PATTERNS
      const retriever = new UnifiedRetriever(store, null, embedder, {
        reranker: null, // No reranker
      });

      const results = await retriever.retrieve("what did i tell you about dark mode");
      assert.equal(getEmbedCalls(), 1, "should make exactly 1 embed call");
      assert.equal(rerankCalls, 0, "should not call reranker");
      assert.ok(results.length > 0, "should return at least one memory result");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("mixed query (both sources, close scores) uses 1 embed + 1 rerank = 2 API calls", async () => {
    const { embedder, getEmbedCalls } = createCountingEmbedder();
    let rerankCalls = 0;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: string | URL | Request, _init?: RequestInit) => {
      rerankCalls++;
      // Return a valid rerank response
      const body = JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.85 },
          { index: 1, relevance_score: 0.80 },
          { index: 2, relevance_score: 0.75 },
          { index: 3, relevance_score: 0.60 },
          { index: 4, relevance_score: 0.50 },
        ],
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    try {
      // Doc search function returning close-scored results
      const docSearch = async (_q: string, _vec: number[], limit: number) => {
        return [
          makeDocCandidate("deploy-guide", "Deployment Guide", 0.72),
          makeDocCandidate("architecture", "Architecture Overview", 0.68),
        ].slice(0, limit);
      };

      const retriever = new UnifiedRetriever(store, docSearch, embedder, {
        reranker: {
          endpoint: "http://localhost:19999/rerank",
          apiKey: "test",
          model: "test-reranker",
          provider: "jina",
        },
        confidenceThreshold: 0.99, // Force reranking by setting very high threshold
        confidenceGap: 0.99,       // Force reranking by setting very high gap
      });

      // Query must be >= 15 chars to pass adaptive retrieval length check
      const results = await retriever.retrieve("how to deploy the application to production");
      assert.equal(getEmbedCalls(), 1, "should make exactly 1 embed call");
      assert.equal(rerankCalls, 1, "should make exactly 1 rerank call");
      assert.ok(results.length > 0, "should return results");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("document-only query uses 1 embed call", async () => {
    const { embedder, getEmbedCalls } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [
        makeDocCandidate("readme", "README", 0.9),
      ].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null,
    });

    // "in the file" triggers DOC_PATTERNS
    const results = await retriever.retrieve("what does it say in the file about config");
    assert.equal(getEmbedCalls(), 1, "should make exactly 1 embed call");
    assert.ok(results.length > 0, "should return document results");
  });

  it("greeting/skip query uses 0 API calls", async () => {
    const { embedder, getEmbedCalls } = createCountingEmbedder();

    const retriever = new UnifiedRetriever(store, null, embedder);
    const results = await retriever.retrieve("hello");
    assert.equal(getEmbedCalls(), 0, "should make 0 API calls for greetings");
    assert.equal(results.length, 0, "should return empty results for greetings");
  });

  it("average API calls across 5 query types <= 2", async () => {
    const { embedder, getEmbedCalls, resetCounts } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [makeDocCandidate("doc1", "Test Doc", 0.7)].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null, // No reranker to keep API calls predictable
    });

    const queries = [
      "hello",                                    // skip (0 calls)
      "i told you about the TypeScript setup",    // memory-only (1 call)
      "check the file for deployment steps",      // doc-only (1 call)
      "how does the retrieval pipeline work",     // both (1 call)
      "what is my preferred port for the server", // memory-only (1 call)
    ];

    let totalCalls = 0;
    for (const q of queries) {
      resetCounts();
      await retriever.retrieve(q);
      totalCalls += getEmbedCalls();
    }

    const avgCalls = totalCalls / queries.length;
    assert.ok(avgCalls <= 2, `average API calls should be <= 2, got ${avgCalls.toFixed(2)}`);
  });
});

// =============================================================================
// Latency Benchmarks
// =============================================================================

describe("UnifiedRetriever Benchmark — pipeline latency", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ur-latency-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });

    // Seed memories
    for (let i = 0; i < 20; i++) {
      await store.store({
        text: `Memory entry ${i}: some information about topic ${i} that might be relevant`,
        vector: makeVector(i),
        importance: 0.5 + Math.random() * 0.5,
        category: (["fact", "preference", "decision"] as const)[i % 3],
        scope: "global",
        metadata: "{}",
      });
    }
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("pipeline overhead < 10ms with instant mock APIs", async () => {
    const { embedder } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return Array.from({ length: 5 }, (_, i) =>
        makeDocCandidate(`doc${i}`, `Document ${i}`, 0.9 - i * 0.1)
      ).slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null, // No reranker -- pure pipeline overhead
    });

    // Warm up: first call may incur JIT/module-init costs
    await retriever.retrieve("warm up query");

    // Measure 10 iterations
    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      await retriever.retrieve(`test query number ${i}`);
      const elapsed = performance.now() - start;
      timings.push(elapsed);
    }

    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];
    const p95 = timings[Math.floor(timings.length * 0.95)];

    // Pipeline overhead should be minimal -- mock APIs return instantly
    // Allow generous 10ms to account for SQLite queries + fusion math
    assert.ok(median < 10, `median pipeline time should be < 10ms, got ${median.toFixed(2)}ms`);
    assert.ok(p95 < 15, `p95 pipeline time should be < 15ms, got ${p95.toFixed(2)}ms`);
  });

  it("retrieve with 0 results returns quickly (< 5ms)", async () => {
    const { embedder } = createCountingEmbedder();

    // Empty store + no doc search
    const emptyTmpDir = await mkdtemp(join(tmpdir(), "ur-empty-"));
    const emptyStore = new MemoryStore({ dbPath: join(emptyTmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });

    const retriever = new UnifiedRetriever(emptyStore, null, embedder, {
      reranker: null,
    });

    // Warm up
    await retriever.retrieve("warm up");

    const start = performance.now();
    const results = await retriever.retrieve("test query with no results");
    const elapsed = performance.now() - start;

    assert.equal(results.length, 0);
    assert.ok(elapsed < 5, `empty retrieval should be < 5ms, got ${elapsed.toFixed(2)}ms`);

    await emptyStore.close();
    await rm(emptyTmpDir, { recursive: true, force: true });
  });

  it("skip-path (greetings) returns in < 0.1ms", async () => {
    const { embedder } = createCountingEmbedder();
    const retriever = new UnifiedRetriever(store, null, embedder);

    // Warm up
    await retriever.retrieve("hi");

    const start = performance.now();
    const results = await retriever.retrieve("hello");
    const elapsed = performance.now() - start;

    assert.equal(results.length, 0);
    assert.ok(elapsed < 0.1, `skip-path should be < 0.1ms, got ${elapsed.toFixed(3)}ms`);
  });
});

// =============================================================================
// Source Diversity Benchmarks
// =============================================================================

describe("UnifiedRetriever Benchmark — source diversity", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ur-diversity-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });

    // Seed memories
    for (let i = 0; i < 5; i++) {
      await store.store({
        text: `Memory about deployment step ${i + 1}: important information`,
        vector: makeVector(i + 10),
        importance: 0.8,
        category: "fact",
        scope: "global",
        metadata: "{}",
      });
    }
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("both sources appear in results when both have matches", async () => {
    const { embedder } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [
        makeDocCandidate("deploy-guide", "Deployment Guide", 0.85),
        makeDocCandidate("architecture", "Architecture", 0.70),
      ].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null,
      minScore: 0.0, // Allow all results through
    });

    const results = await retriever.retrieve("deployment steps");
    const sources = new Set(results.map(r => r.source));

    assert.ok(sources.has("conversation"), "should include conversation results");
    assert.ok(sources.has("document"), "should include document results");
    assert.ok(sources.size === 2, "should have exactly 2 source types");
  });

  it("top-1 from each source is protected even with low scores", async () => {
    const { embedder } = createCountingEmbedder();

    // Low-scoring document results
    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [
        makeDocCandidate("marginal", "Marginally Relevant Doc", 0.15),
      ].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null,
      minScore: 0.5, // High threshold -- but top-1 per source should still survive
    });

    const results = await retriever.retrieve("deployment information");
    const docResults = results.filter(r => r.source === "document");
    const memResults = results.filter(r => r.source === "conversation");

    // At least one from each source should be protected
    assert.ok(memResults.length >= 1, "at least 1 conversation result should be protected");
    assert.ok(docResults.length >= 1, "at least 1 document result should be protected");
  });

  it("conversation-only queries return only memory results", async () => {
    const { embedder } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [makeDocCandidate("doc1", "Doc", 0.9)].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null,
    });

    // "i told you" matches MEM_PATTERNS, routes to memory-only
    const results = await retriever.retrieve("i told you about the deployment process before");
    const sources = new Set(results.map(r => r.source));

    assert.ok(sources.has("conversation"), "should include conversation results");
    assert.ok(!sources.has("document"), "should NOT include document results for memory-routed query");
  });

  it("document-only queries return only document results", async () => {
    const { embedder } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [
        makeDocCandidate("readme", "README", 0.9),
        makeDocCandidate("docs", "Documentation", 0.8),
      ].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null,
    });

    // "in the file" routes to document-only
    const results = await retriever.retrieve("what does it say in the file");
    const sources = new Set(results.map(r => r.source));

    assert.ok(sources.has("document"), "should include document results");
    assert.ok(!sources.has("conversation"), "should NOT include conversation results for doc-routed query");
  });

  it("results are sorted by score descending", async () => {
    const { embedder } = createCountingEmbedder();

    const docSearch = async (_q: string, _vec: number[], limit: number) => {
      return [
        makeDocCandidate("doc1", "High Score Doc", 0.95),
        makeDocCandidate("doc2", "Medium Score Doc", 0.65),
        makeDocCandidate("doc3", "Low Score Doc", 0.35),
      ].slice(0, limit);
    };

    const retriever = new UnifiedRetriever(store, docSearch, embedder, {
      reranker: null,
      minScore: 0.0,
    });

    const results = await retriever.retrieve("deployment configuration");

    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1].score >= results[i].score,
        `result ${i - 1} (${results[i - 1].score.toFixed(3)}) should score >= result ${i} (${results[i].score.toFixed(3)})`
      );
    }
  });
});
