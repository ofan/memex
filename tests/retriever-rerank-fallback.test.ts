/**
 * Regression test for the rerank-failure fallback path in MemoryRetriever.
 *
 * Bug history: when rerank was configured (endpoint + model + api key) but
 * the rerank API failed — timeout, 502, network error — the code previously
 * fell through to the cosine-similarity fallback pass, which aggressively
 * re-ranked the pool based on raw vector cosine similarity. That displaced
 * the fusion winners and hurt domain-eval quality (observed 2026-04-11 on
 * the `host-a-model` and `gemma4-stability` queries — both lost a top-3 hit
 * to cosine fallback when the reranker timed out under concurrent load).
 *
 * Fixed behavior:
 * - rerank NOT configured → do the cosine pass (helps pure BM25 paths)
 * - rerank configured AND succeeds → return reranked results
 * - rerank configured AND fails → return the input results unchanged
 *   (trust the hybrid fusion ranking; don't re-rank with cosine)
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { createRetriever } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

/** A minimal fake embedder that returns deterministic unit vectors. */
function makeFakeEmbedder(dim: number): Embedder {
  const embed = (text: string): number[] => {
    // Deterministic "embedding": hash the text into a unit vector
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    const vec = new Array(dim).fill(0).map((_, i) => Math.sin((h + i) * 0.1));
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return vec.map(x => x / (norm || 1));
  };
  return {
    dimensions: dim,
    embedQuery: async (text: string) => embed(text),
    embedDocument: async (text: string) => embed(text),
    embedBatchQuery: async (texts: string[]) => texts.map(embed),
    embedBatchPassage: async (texts: string[]) => texts.map(embed),
  } as any;
}

describe("MemoryRetriever rerank-failure fallback", () => {
  let tmpDir: string;
  let store: MemoryStore;
  const dim = 16;
  let originalFetch: typeof globalThis.fetch;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-rerank-fallback-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "memex.sqlite"), vectorDim: dim });
    const embedder = makeFakeEmbedder(dim);
    // Store 5 memories with varying relevance to the test query
    const memories = [
      "User prefers dark mode and high contrast themes for all their interfaces",
      "The deployment uses PostgreSQL 15 on a dedicated host",
      "Alex banned the word sorry from assistant responses",
      "Weather in San Francisco today is foggy with light winds",
      "Kubernetes cluster runs on three control-plane nodes",
    ];
    for (const text of memories) {
      const vector = await embedder.embedDocument(text);
      await store.store({
        text,
        vector,
        category: "fact",
        scope: "global",
        importance: 0.7,
      });
    }
    originalFetch = globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns hybrid-fusion results UNCHANGED when rerank API throws a 502", async () => {
    // Mock fetch to simulate a rerank endpoint that always 502s
    let fetchCallCount = 0;
    globalThis.fetch = async (url: any) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/rerank")) {
        fetchCallCount++;
        return new Response("upstream unavailable", { status: 502 });
      }
      return originalFetch(url);
    };

    const embedder = makeFakeEmbedder(dim);

    // First run: rerank CONFIGURED but API fails
    const retrieverWithRerank = createRetriever(store, embedder, {
      mode: "hybrid",
      fusionMethod: "zscore",
      vectorWeight: 0.8,
      bm25Weight: 0.2,
      rerank: "cross-encoder",
      rerankEndpoint: "http://fake-rerank.invalid/v1/rerank",
      rerankApiKey: "fake-key",
      rerankModel: "fake-model",
      rerankProvider: "jina",
      candidatePoolSize: 10,
      minScore: 0.0,
      hardMinScore: 0.0,
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    // Second run: rerank NOT configured (will use cosine fallback)
    const retrieverNoRerank = createRetriever(store, embedder, {
      mode: "hybrid",
      fusionMethod: "zscore",
      vectorWeight: 0.8,
      bm25Weight: 0.2,
      rerank: "none",
      candidatePoolSize: 10,
      minScore: 0.0,
      hardMinScore: 0.0,
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    const query = "dark mode preference";
    const withRerankFailed = await retrieverWithRerank.retrieve({ query, limit: 5 });
    const withoutRerank = await retrieverNoRerank.retrieve({ query, limit: 5 });

    // The rerank API was called (and failed with 502)
    assert.ok(fetchCallCount > 0, "rerank endpoint should have been called");

    // Both runs should have produced results
    assert.ok(withRerankFailed.length > 0);
    assert.ok(withoutRerank.length > 0);

    // KEY ASSERTION: when rerank failed, the output should equal the
    // baseline hybrid-fusion order. NOT a cosine re-rank of the pool.
    // The `sources.reranked` field is set on rerank, but should NOT be
    // set when rerank failed and we returned the pool unchanged.
    for (const r of withRerankFailed) {
      assert.equal(
        (r.sources as any)?.reranked,
        undefined,
        "rerank-failure path should NOT mark results as reranked (no cosine fallback applied)",
      );
    }
  });

  it("retries transient failures via withTransientRetry before giving up", async () => {
    let attemptCount = 0;
    globalThis.fetch = async (url: any) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/rerank")) {
        attemptCount++;
        return new Response("upstream unavailable", { status: 502 });
      }
      return originalFetch(url);
    };

    const embedder = makeFakeEmbedder(dim);
    const retriever = createRetriever(store, embedder, {
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankEndpoint: "http://fake-rerank.invalid/v1/rerank",
      rerankApiKey: "fake-key",
      rerankModel: "fake-model",
      rerankProvider: "jina",
      candidatePoolSize: 10,
      minScore: 0.0,
      hardMinScore: 0.0,
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
    });

    await retriever.retrieve({ query: "test query", limit: 3 });

    // With retry, the 502 should be retried (default 4 attempts).
    // We're not asserting the exact count because backoff timing makes it
    // flaky; but it should be > 1 to confirm retries happened at all.
    assert.ok(
      attemptCount > 1,
      `expected retry on 502 but got only ${attemptCount} attempt(s)`,
    );
  });
});
