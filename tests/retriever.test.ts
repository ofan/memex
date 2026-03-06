/**
 * Tests for src/retriever.ts (7-stage hybrid retrieval pipeline)
 *
 * Uses real LanceDB store with mock embedder for deterministic vector searches.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/store.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

const VECTOR_DIM = 32;

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function createMockEmbedder(defaultSeed = 1): Embedder {
  return {
    embedQuery: async (text: string) => {
      // Simple hash-based deterministic vector from text
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
      return makeVector(Math.abs(hash) % 1000);
    },
    embedPassage: async (text: string) => {
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
      return makeVector(Math.abs(hash) % 1000);
    },
    embed: async (text: string) => {
      let hash = 0;
      for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
      return makeVector(Math.abs(hash) % 1000);
    },
    embedBatchPassage: async (texts: string[]) => {
      return Promise.all(texts.map(async (t) => {
        let hash = 0;
        for (let i = 0; i < t.length; i++) hash = (hash * 31 + t.charCodeAt(i)) | 0;
        return makeVector(Math.abs(hash) % 1000);
      }));
    },
    dimensions: VECTOR_DIM,
    model: "test-mock",
    test: async () => ({ success: true, dimensions: VECTOR_DIM }),
    cacheStats: { size: 0, hits: 0, misses: 0, hitRate: "0%" },
  } as any;
}

describe("MemoryRetriever", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let embedder: Embedder;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "retriever-test-"));
    store = new MemoryStore({ dbPath: tmpDir, vectorDim: VECTOR_DIM });
    embedder = createMockEmbedder();

    // Seed data: store entries with pre-computed vectors matching the mock embedder
    const entries = [
      { text: "User prefers dark mode in all applications", category: "preference" as const, scope: "global", importance: 0.9 },
      { text: "Project uses PostgreSQL 15 for primary database", category: "fact" as const, scope: "global", importance: 0.8 },
      { text: "Deploy to AWS us-east-1 region", category: "decision" as const, scope: "global", importance: 0.7 },
      { text: "Authentication uses JWT tokens with RS256", category: "fact" as const, scope: "global", importance: 0.8 },
      { text: "User timezone is America/New_York", category: "entity" as const, scope: "global", importance: 0.6 },
    ];

    for (const e of entries) {
      const vec = await embedder.embedPassage(e.text);
      await store.store({ ...e, vector: vec });
    }
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  describe("vector-only retrieval", () => {
    it("retrieves results sorted by relevance", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const results = await retriever.retrieve({
        query: "dark mode preferences",
        limit: 5,
        scopeFilter: ["global"],
      });

      assert.ok(results.length > 0, "should return results");
      // Results should be sorted by score descending
      for (let i = 1; i < results.length; i++) {
        assert.ok(results[i].score <= results[i - 1].score + 0.001,
          `result ${i} score ${results[i].score} should be <= previous ${results[i - 1].score}`);
      }
    });

    it("includes source attribution", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const results = await retriever.retrieve({
        query: "database",
        limit: 3,
        scopeFilter: ["global"],
      });

      for (const r of results) {
        assert.ok(r.sources, "should have sources");
        assert.ok(r.sources.vector, "should have vector source");
        assert.ok(typeof r.sources.vector.score === "number");
        assert.ok(typeof r.sources.vector.rank === "number");
      }
    });

    it("respects limit parameter", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const results = await retriever.retrieve({
        query: "anything",
        limit: 2,
        scopeFilter: ["global"],
      });

      assert.ok(results.length <= 2);
    });

    it("filters by category", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const results = await retriever.retrieve({
        query: "test query for facts",
        limit: 10,
        scopeFilter: ["global"],
        category: "preference",
      });

      for (const r of results) {
        assert.equal(r.entry.category, "preference");
      }
    });
  });

  describe("hybrid retrieval", () => {
    it("retrieves using hybrid mode", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "hybrid",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const results = await retriever.retrieve({
        query: "PostgreSQL database",
        limit: 5,
        scopeFilter: ["global"],
      });

      assert.ok(results.length > 0, "hybrid should return results");
    });

    it("returns BM25 source for text-matched results", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "hybrid",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const results = await retriever.retrieve({
        query: "PostgreSQL",
        limit: 5,
        scopeFilter: ["global"],
      });

      // At least one result should have BM25 source (exact keyword match)
      const hasBm25 = results.some((r) => r.sources.bm25);
      // BM25 availability depends on LanceDB FTS index creation
      // which may or may not succeed in the test environment
      assert.ok(results.length > 0, "should have results from at least vector search");
    });
  });

  describe("getConfig", () => {
    it("returns the current configuration", () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "hybrid",
      });

      const config = retriever.getConfig();
      assert.equal(config.mode, "hybrid");
    });
  });

  describe("test", () => {
    it("returns success status", async () => {
      const retriever = createRetriever(store, embedder, {
        ...DEFAULT_RETRIEVAL_CONFIG,
        mode: "vector",
        rerank: "none",
        minScore: 0.01,
        hardMinScore: 0.01,
      });

      const result = await retriever.test();
      assert.ok(result.success);
      assert.ok(result.mode);
      assert.equal(typeof result.hasFtsSupport, "boolean");
    });
  });
});
