import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { UnifiedRecall } from "../src/unified-recall.js";

const vector = () => [1, 0];
const embedder = {
  dimensions: 2,
  embedQuery: async () => vector(),
  embedPassage: async () => vector(),
  embed: async () => vector(),
} as any;

function conversationResult(id: string, text: string, score: number) {
  return {
    entry: {
      id, text, category: "fact", scope: "global",
      importance: 0.8, timestamp: Date.now(), vector: [],
    },
    score,
  } as any;
}

function documentResult(docid: string, title: string, text: string, score: number) {
  return {
    file: `/docs/${docid}.md`,
    displayPath: `${docid}.md`,
    title,
    body: text,
    bestChunk: text,
    bestChunkPos: 0,
    score,
    docid,
    context: null,
  };
}

function makeRecall(config: any, rerankBody?: any) {
  const retriever = {
    retrieve: async () => [
      conversationResult("mem-strong", "x".repeat(3000), 0.95),
      conversationResult("mem-weak", "weak conversation match", 0.55),
    ],
  } as any;
  const recall = new UnifiedRecall(retriever, embedder, config);
  recall.setSearchStore({
    searchFTS: () => [],
    searchVec: async () => [documentResult("doc-weak", "Weak document", "y".repeat(3000), 0.55)],
  } as any, (async (_store: any, _q: any, opts: any) => {
    if (rerankBody) {
      rerankBody.documentTexts = [_store, _q, opts];
    }
    return [documentResult("doc-weak", "Weak document", "y".repeat(3000), 0.55)];
  }) as any, "test-embed");
  return recall;
}

describe("UnifiedRecall shared cross-rerank", () => {
  it("truncates long reranker documents and applies rerankMinScore without source protection", async () => {
    let request: any;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url: any, init?: RequestInit) => {
      request = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 0.99 },
          { index: 1, relevance_score: 0.01 },
          { index: 2, relevance_score: 0.01 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const recall = makeRecall({
        crossRerank: true,
        rerankConfig: {
          provider: "jina", apiKey: "test", model: "test", endpoint: "http://rerank.invalid.test/v1/rerank",
        },
        minScore: 0.15,
        rerankMinScore: 0.5,
      });
      const results = await recall.recall("deployment topic", { limit: 3 });
      assert.equal(request.documents.length, 3);
      assert.equal(request.documents.every((doc: string) => doc.length <= 1500), true);
      assert.equal(results.length, 1);
      assert.equal(results[0].id, "mem-strong");
      assert.ok(results[0].score >= 0.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to weighted merge and source protection when reranker fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("Internal Server Error", { status: 500 });
    const warnings: string[] = [];
    try {
      const retriever = {
        retrieve: async () => [
          conversationResult("mem-a", "memory A", 0.9),
        ],
      } as any;
      const recall = new UnifiedRecall(retriever, embedder, {
        crossRerank: true,
        rerankConfig: {
          provider: "jina", apiKey: "test", model: "test", endpoint: "http://rerank.invalid.test/v1/rerank",
        },
        minScore: 0.5,
        rerankMinScore: 0.9,
      }, { warn: (m) => warnings.push(m) });
      recall.setSearchStore({
        searchFTS: () => [],
        searchVec: async () => [documentResult("doc-b", "document B", "document B", 0.55)],
      } as any, async () => [documentResult("doc-b", "document B", "document B", 0.55)] as any, "test-embed");
      const results = await recall.recall("topic", { limit: 3 });
      assert.equal(results.length, 2, "both protected source tops survive fallback");
      assert.ok(results.some(r => r.source === "conversation"));
      assert.ok(results.some(r => r.source === "document"));
      assert.equal(warnings.length, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
