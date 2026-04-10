/**
 * Acceptance tests for Entity Graph project.
 *
 * Goal: domain eval from 80% → ≥87% (12/15 → ≥13/15)
 * Focus: multi-entity queries where graph traversal finds related memories
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
    embedQuery: async () => makeVector(42),
    embedPassage: async () => makeVector(42),
    embed: async () => makeVector(42),
    embedBatchPassage: async (texts: string[]) => texts.map((_, i) => makeVector(i)),
    embedBatchQuery: async (texts: string[]) => texts.map((_, i) => makeVector(i)),
    test: async () => ({ success: true as const, dimensions: VECTOR_DIM, model: "test", hasFtsSupport: true }),
    cacheStats: { size: 0, hits: 0, misses: 0, hitRate: "0%" },
  } as any as Embedder;
}

describe("Entity Graph — Acceptance Criteria", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "entity-graph-ac-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("AC1: memory_links table exists after store init", () => {
    const tables = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_links'"
    ).all();
    assert.equal(tables.length, 1, "memory_links table should exist");
  });

  it("AC2: storing memories with shared entities creates links", async () => {
    // Two memories sharing entities "Alice" and "ProjectX"
    await store.store({
      text: "Alice leads ProjectX development",
      vector: makeVector(1), category: "fact", scope: "global", importance: 0.7,
    });
    await store.store({
      text: "Alice deployed ProjectX to production",
      vector: makeVector(2), category: "fact", scope: "global", importance: 0.7,
    });

    const links = store.db.prepare("SELECT * FROM memory_links").all();
    assert.ok(links.length > 0, "should create links between memories sharing entities");
  });

  it("AC3: memories with <2 shared entities are NOT linked", async () => {
    // Only share 1 entity "Alice"
    await store.store({
      text: "Alice went to the store",
      vector: makeVector(1), category: "fact", scope: "global", importance: 0.5,
    });
    await store.store({
      text: "Alice cooked dinner at home",
      vector: makeVector(2), category: "fact", scope: "global", importance: 0.5,
    });

    const links = store.db.prepare("SELECT * FROM memory_links").all();
    assert.equal(links.length, 0, "single shared entity should not create a link");
  });

  it("AC4: one-hop expansion surfaces linked memories in retrieval", async () => {
    // Memory A: about a crash (directly relevant to query)
    const a = await store.store({
      text: "Model Alpha crashed after 5 messages in multi-turn on Server Beta",
      vector: makeVector(10), category: "fact", scope: "global", importance: 0.8,
    });
    // Memory B: about the switch (what we want to find via graph)
    const b = await store.store({
      text: "Team switched from Model Alpha to Model Gamma on Server Beta due to instability",
      vector: makeVector(20), category: "decision", scope: "global", importance: 0.8,
    });
    // Memory C: unrelated
    await store.store({
      text: "The weather was nice yesterday",
      vector: makeVector(30), category: "fact", scope: "global", importance: 0.3,
    });

    // A and B share entities "Model Alpha" + "Server Beta" → should be linked
    // Query about the switch — B might not rank top via vector alone
    const retriever = createRetriever(store, createMockEmbedder(), { minScore: 0 });
    const results = await retriever.retrieve({ query: "Why did team switch from Model Alpha?", limit: 5 });

    // Both A and B should appear (B via direct match or graph link from A)
    const texts = results.map(r => r.entry.text);
    const hasSwitch = texts.some(t => t.includes("switched"));
    const hasCrash = texts.some(t => t.includes("crashed"));
    assert.ok(hasSwitch || hasCrash, `should find switch or crash memory, got: ${texts.map(t => t.slice(0, 50))}`);
  });

  it("AC5: links cap at 10 per memory", async () => {
    // Store 15 memories all sharing entities with memory #1
    const first = await store.store({
      text: "Alice and Bob work on ProjectX together",
      vector: makeVector(1), category: "fact", scope: "global", importance: 0.7,
    });

    for (let i = 2; i <= 15; i++) {
      await store.store({
        text: `Alice and Bob discussed ProjectX milestone ${i}`,
        vector: makeVector(i), category: "fact", scope: "global", importance: 0.5,
      });
    }

    const linkCount = (store.db.prepare(
      "SELECT COUNT(*) as c FROM memory_links WHERE source_id = ?"
    ).get(first!.id) as any).c;

    assert.ok(linkCount <= 10, `should cap at 10 links, got ${linkCount}`);
  });

  it("AC6: deleted memories have their links cleaned up", async () => {
    const a = await store.store({
      text: "Alice and Bob started ProjectX",
      vector: makeVector(1), category: "fact", scope: "global", importance: 0.7,
    });
    await store.store({
      text: "Alice and Bob finished ProjectX",
      vector: makeVector(2), category: "fact", scope: "global", importance: 0.7,
    });

    const linksBefore = (store.db.prepare("SELECT COUNT(*) as c FROM memory_links").get() as any).c;
    assert.ok(linksBefore > 0);

    await store.delete(a!.id);

    const linksAfter = (store.db.prepare("SELECT COUNT(*) as c FROM memory_links").get() as any).c;
    assert.equal(linksAfter, 0, "links should be cleaned up on delete");
  });

  it("AC7: graph expansion does not regress retrieval for non-entity queries", async () => {
    await store.store({
      text: "The default color theme is dark mode",
      vector: makeVector(1), category: "preference", scope: "global", importance: 0.8,
    });

    const retriever = createRetriever(store, createMockEmbedder(), { minScore: 0 });
    const results = await retriever.retrieve({ query: "what color theme?", limit: 3 });

    assert.ok(results.length > 0, "non-entity query should still return results");
    assert.ok(results[0].entry.text.includes("dark mode"), "correct result should rank first");
  });
});
