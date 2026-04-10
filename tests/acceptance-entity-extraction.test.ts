/**
 * Acceptance tests for Entity Extraction project.
 *
 * Primary metric: R@1 from 78% → ≥85%
 * Secondary: R@3 from 90% → ≥95%
 *
 * All tests must pass before merge to master.
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
    test: async () => ({ success: true as const, dimensions: VECTOR_DIM, model: "test-mock", hasFtsSupport: true }),
    cacheStats: { size: 0, hits: 0, misses: 0, hitRate: "0%" },
  } as any as Embedder;
}

describe("Entity Extraction — Acceptance Criteria", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "entity-ac-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("AC1: extractEntities produces entities for known inputs", async () => {
    const entry = await store.store({
      text: "Ryan deployed Gemma 4 on mbp-1",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.8,
    });

    assert.ok(entry, "entry should be stored");

    const metadata = JSON.parse(entry!.metadata || "{}");
    assert.ok(Array.isArray(metadata.entities), "metadata.entities should be an array");
    assert.ok(metadata.entities.length > 0, "should extract at least one entity");

    // Should contain key entities (case-insensitive check)
    const entities = metadata.entities.map((e: string) => e.toLowerCase());
    assert.ok(
      entities.some((e: string) => e.includes("ryan")),
      `entities should contain "ryan", got: ${entities}`
    );
  });

  it("AC2: extractEntities handles text with no entities", async () => {
    const entry = await store.store({
      text: "The webhook was deleted yesterday",
      vector: makeVector(2),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    assert.ok(entry, "entry should be stored");

    const metadata = JSON.parse(entry!.metadata || "{}");
    assert.ok(Array.isArray(metadata.entities), "metadata.entities should be an array (not null)");
    // Empty is fine — no crash, no null
  });

  it("AC3: entity overlap boosts retrieval of matching memories", async () => {
    // Store 10 memories — 3 mention "Ryan"
    const ryanTexts = [
      "Ryan prefers private repos by default",
      "Ryan's deployment rule: one model at a time on mbp-1",
      "Ryan disabled WhatsApp channel for bot use",
    ];
    const otherTexts = [
      "The Discord webhook was created for notifications",
      "Gatus uptime monitoring deployed at status.example.com",
      "SSH FIDO2 keys are supported on macOS",
      "Jellyfin cache PVC was resized to 50Gi",
      "The IMAP daemon detected new mail instantly",
      "QMD embedInterval was set to 15 minutes",
      "Dashboard image updated from old to new tag",
    ];

    for (let i = 0; i < ryanTexts.length; i++) {
      await store.store({
        text: ryanTexts[i],
        vector: makeVector(i + 100), // distinct vectors
        category: "preference",
        scope: "global",
        importance: 0.7,
      });
    }
    for (let i = 0; i < otherTexts.length; i++) {
      await store.store({
        text: otherTexts[i],
        vector: makeVector(i + 200),
        category: "fact",
        scope: "global",
        importance: 0.5,
      });
    }

    // Query for Ryan — entity boost should promote ryan-memories
    const retriever = createRetriever(store, createMockEmbedder(), { minScore: 0 });
    const results = await retriever.retrieve({ query: "What does Ryan prefer?", limit: 5 });

    // At least 2 of top 5 should be ryan-related
    const ryanResults = results.filter(r =>
      r.entry.text.toLowerCase().includes("ryan")
    );
    assert.ok(
      ryanResults.length >= 2,
      `Expected ≥2 ryan results in top 5, got ${ryanResults.length}: ${results.map(r => r.entry.text.slice(0, 50))}`
    );
  });

  it("AC4: entity boost does not regress R@3 below 95%", async () => {
    // This is a benchmark test — can only be fully validated with the real benchmark
    // Here we verify the mechanism doesn't break basic retrieval
    await store.store({
      text: "User prefers dark mode for all applications",
      vector: makeVector(1),
      category: "preference",
      scope: "global",
      importance: 0.8,
    });

    const retriever = createRetriever(store, createMockEmbedder(), { minScore: 0 });
    const results = await retriever.retrieve({ query: "dark mode preference", limit: 3 });

    assert.ok(results.length > 0, "should return results");
    assert.ok(
      results[0].entry.text.includes("dark mode"),
      "correct result should be top-ranked"
    );
  });

  it("AC5: entity backfill populates existing entries on startup", async () => {
    // Insert entry WITHOUT entities (simulating pre-upgrade data)
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash) VALUES (?, ?, 'fact', 'global', 0.5, ?, '{}', ?)"
    ).run("backfill-ent-1", "Ryan uses Qwen3.5 on mbp-1", Date.now(), "hash-bf-1");

    const before = JSON.parse(
      (store.db.prepare("SELECT metadata FROM memories WHERE id = 'backfill-ent-1'").get() as any).metadata
    );
    assert.ok(!before.entities, "should have no entities before backfill");

    // Close and reopen — backfill runs on init
    const dbPath = join(tmpDir, "test.sqlite");
    await store.close();
    store = new MemoryStore({ dbPath, vectorDim: VECTOR_DIM });

    const after = JSON.parse(
      (store.db.prepare("SELECT metadata FROM memories WHERE id = 'backfill-ent-1'").get() as any).metadata
    );
    assert.ok(Array.isArray(after.entities), "entities should be backfilled");
    assert.ok(after.entities.length > 0, "should extract entities from existing text");
  });

  it("AC6: agent provenance stored on every new memory", async () => {
    // Store with agentId in metadata
    const entry = await store.store({
      text: "Test memory with agent provenance",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.5,
      metadata: JSON.stringify({ agentId: "virgil" }),
    });

    assert.ok(entry);
    const metadata = JSON.parse(entry!.metadata || "{}");
    assert.equal(metadata.agentId, "virgil", "agentId should be preserved in metadata");
  });

  it("AC7: eviction threshold removes entries with importance ≤ 0.05", async () => {
    // Seed entries at various importance levels
    await store.store({
      text: "Important memory to keep",
      vector: makeVector(1),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    // Insert low-importance entries directly
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash) VALUES (?, ?, 'fact', 'global', 0.05, ?, ?)"
    ).run("evict-1", "Should be evicted", Date.now(), "hash-ev-1");
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash) VALUES (?, ?, 'fact', 'global', 0.03, ?, ?)"
    ).run("evict-2", "Also evicted", Date.now(), "hash-ev-2");
    store.db.prepare(
      "INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash) VALUES (?, ?, 'fact', 'global', 0.1, ?, ?)"
    ).run("keep-1", "Should survive", Date.now(), "hash-kp-1");

    assert.equal(store.totalMemories, 4);

    // Run deep sweep (which should include eviction)
    const { deepSweep } = await import("../src/dreaming.js");
    await deepSweep(store);

    // Entries ≤ 0.05 should be deleted
    assert.equal(
      store.db.prepare("SELECT COUNT(*) as c FROM memories WHERE id IN ('evict-1', 'evict-2')").get()?.c,
      0,
      "entries with importance ≤ 0.05 should be evicted"
    );
    // Entry at 0.1 survives
    assert.ok(
      store.db.prepare("SELECT id FROM memories WHERE id = 'keep-1'").get(),
      "entry at 0.1 should survive"
    );
  });
});
