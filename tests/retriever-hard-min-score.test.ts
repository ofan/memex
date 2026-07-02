/**
 * F12 regression: hardMinScore was dead config — defined (default 0.40) but never
 * read by applyAdaptiveMinScore, which hardcoded max(best*0.3, 0.15). Tests that
 * set hardMinScore:0.0 thinking they'd disabled the floor were vacuously running
 * with floor 0.15. This canary proves the config is now actually consulted.
 */
import { describe, it } from "node:test";
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

describe("F12: hardMinScore is wired (regression for the dead-config bug)", () => {
  it("a high hardMinScore filters all results; 0.0 returns them", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-f12-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: 8 });
    const embedder = makeFakeEmbedder(8);
    const passage = "the quick brown fox jumps over the lazy dog";
    await store.store({
      text: passage, vector: await embedder.embedDocument(passage),
      category: "fact", importance: 0.7, scope: "global",
    } as any);

    const base = {
      mode: "hybrid", rerank: "none" as const, minScore: 0.0,
      recencyHalfLifeDays: 0, recencyWeight: 0, timeDecayHalfLifeDays: 0,
      lengthNormAnchor: 0, filterNoise: false,
    };

    // Low floor: results surface.
    const low = createRetriever(store, embedder, { ...base, hardMinScore: 0.0 });
    const lowRes = await low.retrieve({ query: "quick fox dog", limit: 5 });
    assert.ok(lowRes.length > 0, "hardMinScore=0.0 should return results");
    const maxScore = Math.max(...lowRes.map(r => r.score));
    assert.ok(maxScore < 0.99, `fixture max score ${maxScore.toFixed(3)} must be < 0.99 for a valid canary`);

    // High floor: everything filtered — proves hardMinScore is actually read.
    // (Pre-fix this returned results because the floor was hardcoded max(best*0.3, 0.15).)
    const high = createRetriever(store, embedder, { ...base, hardMinScore: 0.99 });
    const highRes = await high.retrieve({ query: "quick fox dog", limit: 5 });
    assert.equal(highRes.length, 0, "hardMinScore=0.99 must filter all results (proves the config is read)");

    store.close();
    await rm(tmp, { recursive: true, force: true });
  });

  it("MEMEX_RELEVANCE_FIRST caps recency + disables timeDecay (cap-temporal redesign change)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "memex-relfirst-"));
    const store = new MemoryStore({ dbPath: join(tmp, "m.sqlite"), vectorDim: 8 });
    const embedder = makeFakeEmbedder(8);
    const passage = "the quick brown fox jumps over the lazy dog";
    await store.store({
      text: passage, vector: await embedder.embedDocument(passage),
      category: "fact", importance: 0.7, scope: "global",
    } as any);
    const base = { mode: "hybrid", rerank: "none" as const, minScore: 0.0, filterNoise: false };

    const prev = process.env.MEMEX_RELEVANCE_FIRST;
    try {
      const off = createRetriever(store, embedder, { ...base });
      const resOff = await off.retrieve({ query: "quick fox dog", limit: 5 }); // flag unset

      process.env.MEMEX_RELEVANCE_FIRST = "1";
      const on = createRetriever(store, embedder, { ...base }); // flag set: recency capped, decay off
      const resOn = await on.retrieve({ query: "quick fox dog", limit: 5 });

      assert.ok(resOff.length > 0 && resOn.length > 0, "both should return results");
      // Flag caps recency (+0.05 vs +0.10) for a brand-new memory and removes timeDecay, so the
      // score must differ — proves the flag is consulted. (Empirically confirmed via domain-eval:
      // relevant memories score higher, e.g. private-repos 0.401→0.692, less decay penalty.)
      assert.notEqual(resOff[0].score, resOn[0].score, "MEMEX_RELEVANCE_FIRST must change scoring");
    } finally {
      if (prev === undefined) delete process.env.MEMEX_RELEVANCE_FIRST;
      else process.env.MEMEX_RELEVANCE_FIRST = prev;
    }
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
});
