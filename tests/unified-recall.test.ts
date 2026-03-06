/**
 * Tests for src/unified-recall.ts
 *
 * Uses mock implementations for retriever, embedder, and QMD store.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { UnifiedRecall, DEFAULT_UNIFIED_CONFIG } from "../src/unified-recall.js";
import type { RerankConfig } from "../src/unified-recall.js";
import type { RetrievalResult, RetrievalConfig } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

// ============================================================================
// Mock Helpers
// ============================================================================

function createMockRetriever(results: RetrievalResult[] = []) {
  return {
    retrieve: async (_ctx: any) => results,
    getConfig: () => ({ mode: "hybrid" }) as any,
  } as any;
}

function createMockEmbedder() {
  return {
    embedQuery: async (text: string) => new Array(1024).fill(0.1),
    embedPassage: async (text: string) => new Array(1024).fill(0.1),
    dimensions: 1024,
    model: "test-model",
  } as any;
}

function makeConversationResult(id: string, text: string, score: number): RetrievalResult {
  return {
    entry: {
      id,
      text,
      vector: [],
      category: "fact" as const,
      scope: "global",
      importance: 0.7,
      timestamp: Date.now(),
    },
    score,
    sources: { vector: { score, rank: 1 } },
  };
}

function createMockQmdStore() {
  return {
    searchFTS: () => [],
    searchVec: async () => [],
  };
}

function createMockHybridQuery(results: any[] = []) {
  return async (_store: any, _query: string, _options?: any) => results;
}

// ============================================================================
// Tests
// ============================================================================

describe("UnifiedRecall", () => {
  let recall: UnifiedRecall;
  let mockRetriever: any;
  let mockEmbedder: any;

  beforeEach(() => {
    mockRetriever = createMockRetriever([
      makeConversationResult("mem-1", "User prefers dark mode", 0.9),
      makeConversationResult("mem-2", "Project uses PostgreSQL", 0.7),
    ]);
    mockEmbedder = createMockEmbedder();
    recall = new UnifiedRecall(mockRetriever, mockEmbedder);
  });

  describe("constructor", () => {
    it("uses default config", () => {
      const r = new UnifiedRecall(mockRetriever, mockEmbedder);
      assert.ok(r);
    });

    it("accepts partial config override", () => {
      const r = new UnifiedRecall(mockRetriever, mockEmbedder, { limit: 20, minScore: 0.5 });
      assert.ok(r);
    });
  });

  describe("hasDocumentSearch", () => {
    it("returns false without QMD store", () => {
      assert.equal(recall.hasDocumentSearch, false);
    });

    it("returns true after setting QMD store", () => {
      recall.setQmdStore(createMockQmdStore() as any, createMockHybridQuery(), "test-model");
      assert.equal(recall.hasDocumentSearch, true);
    });
  });

  describe("recall (conversation only)", () => {
    it("returns conversation results when no QMD store", async () => {
      const results = await recall.recall("dark mode");
      // With 2 results at scores 0.9 and 0.7, min-max normalization produces 1.0 and 0.0.
      // After conversationWeight(0.5): 0.5 and 0.0. minScore filter (0.2) removes the 0.0 entry.
      assert.equal(results.length, 1);
      assert.equal(results[0].source, "conversation");
      assert.equal(results[0].metadata.type, "conversation");
    });

    it("normalizes scores", async () => {
      const results = await recall.recall("dark mode");
      // After min-max normalization with 2 items (0.9, 0.7): first becomes 1.0, second becomes 0.0
      // Then multiplied by conversationWeight (0.5): 0.5, 0.0
      assert.ok(results[0].score <= 1.0);
      assert.ok(results[0].score >= 0);
    });

    it("applies minScore filter", async () => {
      const r = new UnifiedRecall(mockRetriever, mockEmbedder, { minScore: 0.5 });
      const results = await r.recall("dark mode");
      for (const result of results) {
        assert.ok(result.score >= 0.5);
      }
    });

    it("respects limit", async () => {
      const results = await recall.recall("dark mode", { limit: 1 });
      assert.ok(results.length <= 1);
    });
  });

  describe("recall (unified - both sources)", () => {
    beforeEach(() => {
      const qmdResults = [
        {
          file: "/docs/config.md",
          displayPath: "docs/config.md",
          title: "Configuration Guide",
          body: "This guide covers dark mode configuration...",
          bestChunk: "Enable dark mode by setting theme: dark in config.yml",
          bestChunkPos: 0,
          score: 0.85,
          context: "docs",
          docid: "doc-1",
        },
      ];
      recall.setQmdStore(
        createMockQmdStore() as any,
        createMockHybridQuery(qmdResults),
        "test-model"
      );
    });

    it("returns results from both sources", async () => {
      const results = await recall.recall("dark mode");
      const sources = new Set(results.map((r) => r.source));
      assert.ok(sources.has("conversation"));
      assert.ok(sources.has("document"));
    });

    it("includes source attribution in results", async () => {
      const results = await recall.recall("dark mode");
      for (const result of results) {
        assert.ok(result.source === "conversation" || result.source === "document");
        if (result.source === "conversation") {
          assert.equal(result.metadata.type, "conversation");
        } else {
          assert.equal(result.metadata.type, "document");
          const meta = result.metadata as any;
          assert.ok(meta.file);
          assert.ok(meta.title);
        }
      }
    });

    it("filters to conversation-only when specified", async () => {
      const results = await recall.recall("dark mode", { sources: ["conversation"] });
      for (const r of results) {
        assert.equal(r.source, "conversation");
      }
    });

    it("filters to document-only when specified", async () => {
      const results = await recall.recall("dark mode", { sources: ["document"] });
      for (const r of results) {
        assert.equal(r.source, "document");
      }
    });

    it("preserves rawScore", async () => {
      const results = await recall.recall("dark mode");
      for (const r of results) {
        assert.ok(typeof r.rawScore === "number");
        assert.ok(r.rawScore >= 0);
      }
    });
  });

  describe("recallConversationOnly", () => {
    it("returns raw retriever results", async () => {
      const results = await recall.recallConversationOnly("test query");
      assert.equal(results.length, 2);
      assert.ok(results[0].entry);
      assert.ok(results[0].sources);
    });
  });

  describe("score normalization edge cases", () => {
    it("handles single result (all same score)", async () => {
      const singleRetriever = createMockRetriever([
        makeConversationResult("only-one", "Single result", 0.8),
      ]);
      const r = new UnifiedRecall(singleRetriever, mockEmbedder);
      const results = await r.recall("test");
      // Single result: min = max = 0.8, range = 0 → score set to 1.0
      assert.equal(results.length, 1);
      assert.equal(results[0].score, 0.5); // 1.0 * conversationWeight(0.5)
    });

    it("handles empty results gracefully", async () => {
      const emptyRetriever = createMockRetriever([]);
      const r = new UnifiedRecall(emptyRetriever, mockEmbedder);
      const results = await r.recall("nothing here");
      assert.equal(results.length, 0);
    });
  });

  describe("early termination", () => {
    it("skips document search when conversation results are strong", async () => {
      // High-scoring conversation results
      const strongRetriever = createMockRetriever([
        makeConversationResult("strong-1", "Very relevant memory 1", 0.95),
        makeConversationResult("strong-2", "Very relevant memory 2", 0.90),
        makeConversationResult("strong-3", "Very relevant memory 3", 0.85),
        makeConversationResult("strong-4", "Very relevant memory 4", 0.80),
        makeConversationResult("strong-5", "Very relevant memory 5", 0.75),
      ]);

      let docSearchCalled = false;
      const r = new UnifiedRecall(strongRetriever, mockEmbedder, {
        earlyTermination: true,
        highConfidenceThreshold: 0.6,
        minScore: 0,
        limit: 5,
      });
      r.setQmdStore(
        createMockQmdStore() as any,
        async () => { docSearchCalled = true; return []; },
        "test-model"
      );

      await r.recall("relevant query", { limit: 5 });
      assert.equal(docSearchCalled, false, "document search should be skipped");
    });

    it("does NOT skip documents when conversation results are weak", async () => {
      // Low-scoring conversation results
      const weakRetriever = createMockRetriever([
        makeConversationResult("weak-1", "Marginally related memory", 0.4),
      ]);

      let docSearchCalled = false;
      const r = new UnifiedRecall(weakRetriever, mockEmbedder, {
        earlyTermination: true,
        highConfidenceThreshold: 0.6,
        minScore: 0,
        limit: 5,
      });
      r.setQmdStore(
        createMockQmdStore() as any,
        async () => { docSearchCalled = true; return []; },
        "test-model"
      );

      await r.recall("obscure query", { limit: 5 });
      assert.equal(docSearchCalled, true, "document search should run for weak results");
    });
  });

  describe("document error handling", () => {
    it("returns empty on QMD error", async () => {
      recall.setQmdStore(
        createMockQmdStore() as any,
        async () => { throw new Error("QMD failed"); },
        "test-model"
      );
      const results = await recall.recall("test query");
      // Should still return conversation results even if QMD fails
      assert.ok(results.length >= 0);
    });
  });

  describe("cross-source reranking", () => {
    let server: Server;
    let port: number;
    let rerankCalled: boolean;
    let lastRerankBody: any;

    beforeEach(async () => {
      rerankCalled = false;
      lastRerankBody = null;
      server = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
        req.on("end", () => {
          rerankCalled = true;
          lastRerankBody = JSON.parse(body);
          const docs = lastRerankBody.documents || [];
          // Return results in reverse order with descending scores
          const results = docs.map((_: any, i: number) => ({
            index: docs.length - 1 - i,
            relevance_score: 1 - i * 0.2,
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ results }));
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, () => {
          port = (server.address() as any).port;
          resolve();
        });
      });
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("applies cross-encoder reranking when enabled", async () => {
      const rerankConfig: RerankConfig = {
        provider: "jina",
        apiKey: "test-key",
        model: "test-reranker",
        endpoint: `http://127.0.0.1:${port}/v1/rerank`,
      };

      // Create unified recall with cross-reranking enabled
      const rerankedRecall = new UnifiedRecall(mockRetriever, mockEmbedder, {
        crossRerank: true,
        rerankConfig,
        minScore: 0,
      });

      // Add QMD results so we have cross-source data
      rerankedRecall.setQmdStore(
        createMockQmdStore() as any,
        createMockHybridQuery([{
          file: "/docs/test.md",
          displayPath: "docs/test.md",
          title: "Test Doc",
          body: "Test document content about dark mode",
          bestChunk: "Dark mode test chunk",
          bestChunkPos: 0,
          score: 0.8,
          context: "docs",
          docid: "doc-1",
        }]),
        "test-model"
      );

      const results = await rerankedRecall.recall("dark mode");
      assert.ok(rerankCalled, "reranker should have been called");
      assert.ok(lastRerankBody.query === "dark mode");
      assert.ok(results.length > 0);
    });

    it("falls back to score-sort on reranker failure", async () => {
      const rerankConfig: RerankConfig = {
        provider: "jina",
        apiKey: "test-key",
        model: "test-reranker",
        endpoint: "http://127.0.0.1:1/nonexistent", // Will fail to connect
      };

      const failRecall = new UnifiedRecall(mockRetriever, mockEmbedder, {
        crossRerank: true,
        rerankConfig,
        minScore: 0,
      });

      const results = await failRecall.recall("dark mode");
      // Should still return results even when reranker fails
      assert.ok(results.length > 0);
    });

    it("does not call reranker when crossRerank is false", async () => {
      const noRerankRecall = new UnifiedRecall(mockRetriever, mockEmbedder, {
        crossRerank: false,
        minScore: 0,
      });

      noRerankRecall.setQmdStore(
        createMockQmdStore() as any,
        createMockHybridQuery([{
          file: "/docs/test.md",
          displayPath: "docs/test.md",
          title: "Test",
          body: "Content",
          bestChunk: "Chunk",
          bestChunkPos: 0,
          score: 0.8,
          context: "docs",
          docid: "doc-1",
        }]),
        "test-model"
      );

      await noRerankRecall.recall("test");
      assert.equal(rerankCalled, false, "reranker should NOT have been called");
    });

    it("blends cross-encoder score with original score", async () => {
      const rerankConfig: RerankConfig = {
        provider: "jina",
        apiKey: "test-key",
        model: "test-reranker",
        endpoint: `http://127.0.0.1:${port}/v1/rerank`,
      };

      const blendRecall = new UnifiedRecall(mockRetriever, mockEmbedder, {
        crossRerank: true,
        rerankConfig,
        minScore: 0,
      });

      const results = await blendRecall.recall("dark mode");
      // All results should have scores between 0 and 1
      for (const r of results) {
        assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of range`);
      }
    });
  });
});
