/**
 * Per-query debug trace for MemoryRetriever (plan: feat/recall-debug-trace).
 * Verifies that `captureTrace` records every ranking stage with frozen per-stage
 * scores, records what the hardMinScore floor dropped, and is zero-cost (null)
 * when off.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { createRetriever } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";
import type { RetrievalTrace } from "../src/retrieval-trace.js";

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

async function seed(store: MemoryStore, embedder: Embedder, texts: string[]) {
  for (const text of texts) {
    await store.store({
      text, vector: await embedder.embedDocument(text),
      category: "fact", importance: 0.7, scope: "global",
    } as any);
  }
}

const baseConfig = {
  mode: "hybrid" as const,
  rerank: "none" as const,
  minScore: 0.0,
  recencyHalfLifeDays: 0, recencyWeight: 0, timeDecayHalfLifeDays: 0,
  lengthNormAnchor: 0, filterNoise: false,
};

describe("MemoryRetriever debug trace", () => {
  it("is null when captureTrace is off (zero-overhead default)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-trace-off-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: 8 });
    const embedder = makeFakeEmbedder(8);
    await seed(store, embedder, ["the quick brown fox", "lazy dog naps"]);
    const r = createRetriever(store, embedder, { ...baseConfig });
    await r.retrieve({ query: "quick fox", limit: 5 });
    assert.equal(r.lastTrace, null, "lastTrace must be null when captureTrace is off");
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("records fusion + adaptive-floor + final stages with frozen scores", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-trace-on-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: 8 });
    const embedder = makeFakeEmbedder(8);
    await seed(store, embedder, ["the quick brown fox jumps", "lazy dog naps all day", "totally unrelated gibberish zzz"]);
    const r = createRetriever(store, embedder, { ...baseConfig, captureTrace: true });
    const results = await r.retrieve({ query: "quick fox jumps", limit: 5 });

    const trace: RetrievalTrace | null = r.lastTrace;
    assert.ok(trace, "lastTrace must be populated when captureTrace is on");
    assert.equal(trace!.pipeline, "memory-hybrid");
    assert.equal(trace!.query, "quick fox jumps");
    const names = trace!.stages.map(s => s.name);
    assert.ok(names.includes("fusion"), `stages include fusion; got ${names.join(",")}`);
    assert.ok(names.includes("adaptive-floor"), `stages include adaptive-floor; got ${names.join(",")}`);

    // finalIds match the returned results, in order.
    assert.deepEqual(trace!.finalIds, results.map(x => x.entry.id));

    // Frozen scores: fusion stage items carry the fused score as a number.
    const fusion = trace!.stages.find(s => s.name === "fusion")!;
    assert.ok(fusion.kept.length > 0, "fusion stage kept the candidate pool");
    assert.ok(typeof fusion.kept[0].scores?.fused === "number", "fused score snapshotted");

    store.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("adaptive-floor stage records what hardMinScore dropped + the effective floor", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-trace-floor-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: 8 });
    const embedder = makeFakeEmbedder(8);
    await seed(store, embedder, ["the quick brown fox jumps high", "the quick brown fox jumps low", "zzz nothing relevant here qqq"]);
    // Force a floor high enough to drop the weak match.
    const r = createRetriever(store, embedder, { ...baseConfig, captureTrace: true, hardMinScore: 0.95 });
    await r.retrieve({ query: "quick brown fox", limit: 5 });

    const trace = r.lastTrace!;
    const floor = trace.stages.find(s => s.name === "adaptive-floor")!;
    assert.ok(floor.meta, "adaptive-floor has meta");
    assert.ok(typeof floor.meta!.effectiveFloor === "number", "effectiveFloor recorded");
    // At least one candidate was dropped at the floor (the weak match).
    assert.ok((floor.dropped ?? []).length > 0, "floor dropped the below-threshold candidates");

    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
