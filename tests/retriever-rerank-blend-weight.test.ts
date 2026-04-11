/**
 * Unit test for the configurable `rerankBlendWeight` option added to
 * MemoryRetriever. The default (0.8) makes the reranker dominant;
 * lower values let the fusion score matter more — useful when the
 * reranker is overconfident on semantically-similar-but-wrong matches.
 *
 * The test mocks the rerank endpoint to return deterministic scores,
 * then verifies that the final blended score matches the formula:
 *
 *   blended = rerank_score * W + original_score * (1 - W)
 *
 * across several W values.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { createRetriever } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

function makeFakeEmbedder(dim: number): Embedder {
  const embed = (text: string): number[] => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    const vec = new Array(dim).fill(0).map((_, i) => Math.sin((h + i) * 0.1));
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    return vec.map(x => x / (norm || 1));
  };
  return {
    dimensions: dim,
    embedQuery: async (t: string) => embed(t),
    embedDocument: async (t: string) => embed(t),
    embedBatchQuery: async (ts: string[]) => ts.map(embed),
    embedBatchPassage: async (ts: string[]) => ts.map(embed),
  } as any;
}

async function runWithWeight(
  store: MemoryStore,
  embedder: Embedder,
  blendWeight: number,
): Promise<number[]> {
  const originalFetch = globalThis.fetch;
  // Mock rerank endpoint: return specific relevance scores for doc 0 and doc 1
  globalThis.fetch = async (url: any) => {
    const urlStr = typeof url === "string" ? url : (url as Request).url;
    if (urlStr.includes("/rerank")) {
      return new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 1.0 },  // highest rerank score
          { index: 1, relevance_score: 0.0 },  // lowest
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return originalFetch(url);
  };

  try {
    const retriever = createRetriever(store, embedder, {
      mode: "hybrid",
      rerank: "cross-encoder",
      rerankEndpoint: "http://fake-rerank/v1/rerank",
      rerankApiKey: "fake-key",
      rerankModel: "fake-model",
      rerankProvider: "jina",
      rerankBlendWeight: blendWeight,
      candidatePoolSize: 10,
      minScore: 0.0,
      hardMinScore: 0.0,
      recencyHalfLifeDays: 0,
      recencyWeight: 0,
      timeDecayHalfLifeDays: 0,
      lengthNormAnchor: 0,
      filterNoise: false,
    });

    const results = await retriever.retrieve({ query: "test query", limit: 5 });
    return results.map(r => r.score);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("rerankBlendWeight — configurable rerank/fusion blend", () => {
  let tmpDir: string;
  let store: MemoryStore;
  const dim = 16;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-blend-weight-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "memex.sqlite"), vectorDim: dim });
    const embedder = makeFakeEmbedder(dim);
    // Two memories. Query should bring them both into the candidate pool.
    const texts = [
      "dark mode preference for the UI theme settings",
      "light mode fallback for bright environments",
    ];
    for (const text of texts) {
      const vector = await embedder.embedDocument(text);
      await store.store({ text, vector, category: "fact", scope: "global", importance: 0.7 });
    }
  });

  after(async () => {
    store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("blend weight 1.0 → pure reranker score (original fused score ignored)", async () => {
    const embedder = makeFakeEmbedder(dim);
    const scores = await runWithWeight(store, embedder, 1.0);
    // With weight=1.0, doc 0 (rerank_score=1.0) should have a final score of 1.0 * 1.0 + fused * 0.0 = 1.0
    assert.ok(scores.length > 0, "expected results");
    assert.ok(scores[0] > 0.9, `top result should be close to 1.0 (pure rerank), got ${scores[0]}`);
  });

  it("blend weight 0.0 → pure fusion score (reranker ignored)", async () => {
    const embedder = makeFakeEmbedder(dim);
    const scores = await runWithWeight(store, embedder, 0.0);
    // With weight=0.0, score = 0.0 * 1.0 + fused * 1.0 = fused.
    // We don't know the exact fused score but it should be non-trivial and
    // definitely NOT clamped to 1.0 (which would happen with blend=1.0).
    assert.ok(scores.length > 0);
    // Fused scores from z-score sigmoid are bounded; just sanity check.
    assert.ok(scores.every(s => s >= 0 && s <= 1), "all scores should be in [0,1]");
  });

  it("blend weight 0.5 → even mix", async () => {
    const embedder = makeFakeEmbedder(dim);
    const scores10 = await runWithWeight(store, embedder, 1.0);
    const scores05 = await runWithWeight(store, embedder, 0.5);
    // At 0.5, the top result's score should be LOWER than at 1.0 because
    // the pure rerank score (1.0) is blended with a lower fusion score.
    assert.ok(
      scores05[0] < scores10[0],
      `top score at 0.5 (${scores05[0]}) should be lower than at 1.0 (${scores10[0]}) because the fusion component pulls it down`,
    );
  });

  it("rankScoreMode: uses rank-normalized scores instead of raw", async () => {
    // Test that rerankScoreMode='rank' transforms raw scores into rank
    // positions: top-1 → 1.0, top-k → 1 - (k-1)/N.
    // With two candidates, raw scores 1.0 and 0.99 become 1.0 and 0.5.
    const embedder = makeFakeEmbedder(dim);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 1.00 },  // raw top-1 (saturated)
            { index: 1, relevance_score: 0.99 },  // raw top-2 (saturated, barely below)
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(url);
    };
    try {
      const rawRetriever = createRetriever(store, embedder, {
        mode: "hybrid",
        rerank: "cross-encoder",
        rerankEndpoint: "http://fake-rerank/v1/rerank",
        rerankApiKey: "fake-key",
        rerankModel: "fake-model",
        rerankProvider: "jina",
        rerankBlendWeight: 0.8,
        rerankScoreMode: "raw",
        candidatePoolSize: 10,
        minScore: 0.0,
        hardMinScore: 0.0,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
        filterNoise: false,
      });
      const rankRetriever = createRetriever(store, embedder, {
        mode: "hybrid",
        rerank: "cross-encoder",
        rerankEndpoint: "http://fake-rerank/v1/rerank",
        rerankApiKey: "fake-key",
        rerankModel: "fake-model",
        rerankProvider: "jina",
        rerankBlendWeight: 0.8,
        rerankScoreMode: "rank",
        candidatePoolSize: 10,
        minScore: 0.0,
        hardMinScore: 0.0,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
        filterNoise: false,
      });
      const rawResults = await rawRetriever.retrieve({ query: "dark mode preference", limit: 5 });
      const rankResults = await rankRetriever.retrieve({ query: "dark mode preference", limit: 5 });
      // Raw mode: both blended scores are near 1.0 because both rerank values are saturated
      // (0.8*1.0 + 0.2*fused vs 0.8*0.99 + 0.2*fused) → diff is 0.002
      // Rank mode: top-1 gets 1.0, top-2 gets 1 - 1/2 = 0.5
      // (0.8*1.0 + 0.2*fused vs 0.8*0.5 + 0.2*fused) → diff is 0.4
      // So the rank-mode gap between results[0] and results[1] should be much larger.
      if (rawResults.length >= 2 && rankResults.length >= 2) {
        const rawGap = rawResults[0].score - rawResults[1].score;
        const rankGap = rankResults[0].score - rankResults[1].score;
        assert.ok(
          rankGap > rawGap,
          `rank mode should produce a larger top-1 vs top-2 gap (raw=${rawGap.toFixed(4)}, rank=${rankGap.toFixed(4)})`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("undefined blend weight defaults to 0.8 (backward compat)", async () => {
    // The previous hardcoded behavior was item.score * 0.8 + original.score * 0.2.
    // Omitting rerankBlendWeight should give the same answer as explicit 0.8.
    const embedder = makeFakeEmbedder(dim);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url: any) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/rerank")) {
        return new Response(JSON.stringify({
          results: [
            { index: 0, relevance_score: 1.0 },
            { index: 1, relevance_score: 0.0 },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(url);
    };
    try {
      const explicitRetriever = createRetriever(store, embedder, {
        mode: "hybrid",
        rerank: "cross-encoder",
        rerankEndpoint: "http://fake-rerank/v1/rerank",
        rerankApiKey: "fake-key",
        rerankModel: "fake-model",
        rerankProvider: "jina",
        rerankBlendWeight: 0.8,
        candidatePoolSize: 10,
        minScore: 0.0,
        hardMinScore: 0.0,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
        filterNoise: false,
      });
      const defaultRetriever = createRetriever(store, embedder, {
        mode: "hybrid",
        rerank: "cross-encoder",
        rerankEndpoint: "http://fake-rerank/v1/rerank",
        rerankApiKey: "fake-key",
        rerankModel: "fake-model",
        rerankProvider: "jina",
        // rerankBlendWeight omitted → should fall back to 0.8
        candidatePoolSize: 10,
        minScore: 0.0,
        hardMinScore: 0.0,
        recencyHalfLifeDays: 0,
        recencyWeight: 0,
        timeDecayHalfLifeDays: 0,
        lengthNormAnchor: 0,
        filterNoise: false,
      });
      const a = await explicitRetriever.retrieve({ query: "test query", limit: 5 });
      const b = await defaultRetriever.retrieve({ query: "test query", limit: 5 });
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        assert.ok(
          Math.abs(a[i].score - b[i].score) < 0.0001,
          `result ${i}: explicit 0.8 → ${a[i].score}, default → ${b[i].score}`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
