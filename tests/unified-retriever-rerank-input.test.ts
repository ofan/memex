import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  UnifiedRetriever,
  RERANK_DOCUMENT_CHAR_LIMIT,
} from "../src/unified-retriever.js";

function vector(seed: number, dim = 4): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin((seed + i) * 0.1));
}

describe("UnifiedRetriever reranker request size", () => {
  it("truncates long memory and document candidates before calling the reranker", async () => {
    const store = {
      vectorSearch: async () => [{
        entry: {
          id: "memory-1",
          text: "x".repeat(5000),
          category: "fact",
          scope: "global",
          importance: 0.5,
          timestamp: Date.now(),
        },
        score: 0.9,
      }],
      bm25Search: async () => [],
    } as any;
    const embedder = {
      dimensions: 4,
      embedQuery: async () => vector(1),
      embedPassage: async () => vector(2),
      embed: async () => vector(3),
    } as any;
    const docSearch = async () => [{
      filepath: "/long.md",
      displayPath: "long.md",
      title: "Long document",
      body: "y".repeat(5000),
      bestChunk: "z".repeat(5000),
      bestChunkPos: 0,
      score: 0.8,
      docid: "long-doc",
      context: null,
    } as any];

    let capturedBody: any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.1 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    try {
      const retriever = new UnifiedRetriever(store, docSearch, embedder, {
        candidatePoolSize: 10,
        confidenceThreshold: 2,
        confidenceGap: 2,
        minScore: 0,
        reranker: {
          endpoint: "http://rerank.invalid.test/v1/rerank",
          apiKey: "test-key",
          model: "test-reranker",
          provider: "jina",
        },
      });

      const results = await retriever.retrieve("search the long codebase", { limit: 2 });
      assert.equal(results.length, 2, "truncated reranker input should succeed");
      assert.ok(capturedBody.documents, "reranker request captured");
      assert.equal(capturedBody.documents.length, 2);
      assert.equal(capturedBody.documents.every((doc: string) => doc.length <= RERANK_DOCUMENT_CHAR_LIMIT), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
