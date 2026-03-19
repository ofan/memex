/**
 * Resiliency tests for embedding model change detection and re-embed state machine.
 * See docs/RESILIENCY.md for the full failure mode analysis.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.ts";

function randomVec(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random());
}

describe("resiliency: embedding state machine", () => {
  let tmpDir: string;
  let store: MemoryStore;
  const DIM = 4;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "resiliency-test-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // State detection
  // =========================================================================

  it("first_run: no stored model", () => {
    assert.equal(store.getEmbeddingStatus("model-A"), "first_run");
    assert.equal(store.needsReEmbed("model-A"), false);
  });

  it("consistent: stored model matches current", () => {
    store.setStoredEmbeddingModel("model-A");
    assert.equal(store.getEmbeddingStatus("model-A"), "consistent");
    assert.equal(store.needsReEmbed("model-A"), false);
  });

  it("model_changed: stored model differs from current", () => {
    store.setStoredEmbeddingModel("model-A");
    assert.equal(store.getEmbeddingStatus("model-B"), "model_changed");
    assert.equal(store.needsReEmbed("model-B"), true);
  });

  it("interrupted: target exists", () => {
    store.setStoredEmbeddingModel("model-A");
    store.setMeta("embedding_target", "model-B");
    assert.equal(store.getEmbeddingStatus("model-B"), "interrupted");
    assert.equal(store.needsReEmbed("model-B"), true);
  });

  it("interrupted: target exists even if current matches stored", () => {
    store.setStoredEmbeddingModel("model-A");
    store.setMeta("embedding_target", "model-B");
    // Config switched back to A, but target B still exists → interrupted
    assert.equal(store.getEmbeddingStatus("model-A"), "interrupted");
    assert.equal(store.needsReEmbed("model-A"), true);
  });

  // =========================================================================
  // Re-embed state machine
  // =========================================================================

  it("re-embed sets target before starting, clears after completion", async () => {
    // Seed data
    await store.store({ text: "test memory", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    let targetDuringEmbed: string | null = null;
    await store.reEmbedMemories(
      "model-B",
      async (texts) => {
        // Check state mid-embed
        targetDuringEmbed = store.getMeta("embedding_target");
        return texts.map(() => randomVec(DIM));
      },
    );

    assert.equal(targetDuringEmbed, "model-B", "target should be set during re-embed");
    assert.equal(store.getMeta("embedding_target"), null, "target should be cleared after completion");
    assert.equal(store.getStoredEmbeddingModel(), "model-B", "model should be updated after completion");
  });

  it("re-embed with empty store sets model and clears target", async () => {
    store.setStoredEmbeddingModel("model-A");
    const count = await store.reEmbedMemories("model-B", async () => []);
    assert.equal(count, 0);
    assert.equal(store.getStoredEmbeddingModel(), "model-B");
    assert.equal(store.getMeta("embedding_target"), null);
  });

  it("simulated interrupt: target persists, model unchanged", async () => {
    await store.store({ text: "memory 1", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    await store.store({ text: "memory 2", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    store.setStoredEmbeddingModel("model-A");

    // Simulate interrupt: manually set target without completing
    store.setMeta("embedding_target", "model-B");

    // State should show interrupted
    assert.equal(store.getEmbeddingStatus("model-B"), "interrupted");
    assert.equal(store.getStoredEmbeddingModel(), "model-A", "model should still be A");

    // Recovery: run re-embed to completion
    await store.reEmbedMemories(
      "model-B",
      async (texts) => texts.map(() => randomVec(DIM)),
    );

    assert.equal(store.getEmbeddingStatus("model-B"), "consistent");
    assert.equal(store.getStoredEmbeddingModel(), "model-B");
    assert.equal(store.getMeta("embedding_target"), null);
  });

  it("switch-back after interrupt: re-embeds to current config", async () => {
    await store.store({ text: "memory", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    store.setStoredEmbeddingModel("model-A");

    // Simulate interrupted A→B re-embed
    store.setMeta("embedding_target", "model-B");

    // User switches config back to A
    assert.equal(store.getEmbeddingStatus("model-A"), "interrupted");

    // Recovery: re-embed to A (the current config)
    await store.reEmbedMemories(
      "model-A",
      async (texts) => texts.map(() => randomVec(DIM)),
    );

    assert.equal(store.getEmbeddingStatus("model-A"), "consistent");
    assert.equal(store.getStoredEmbeddingModel(), "model-A");
    assert.equal(store.getMeta("embedding_target"), null);
  });

  // =========================================================================
  // Vector integrity
  // =========================================================================

  it("re-embed updates all vectors", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const entry = await store.store({
        text: `memory ${i}`, vector: randomVec(DIM),
        category: "fact", scope: "global", importance: 0.5,
      });
      ids.push(entry.id);
    }
    store.setStoredEmbeddingModel("model-A");

    // Re-embed with known vectors
    const knownVec = [0.1, 0.2, 0.3, 0.4];
    await store.reEmbedMemories(
      "model-B",
      async (texts) => texts.map(() => [...knownVec]),
    );

    // Verify all vectors were updated by searching
    const results = await store.vectorSearch(knownVec, 5, 0.0);
    assert.equal(results.length, 5, "all 5 memories should have vectors");
    // All should have very high similarity to knownVec
    for (const r of results) {
      assert.ok(r.score > 0.99, `score ${r.score} should be ~1.0 for identical vectors`);
    }
  });

  it("delete cleans up vector and FTS — no orphans", async () => {
    const entry = await store.store({
      text: "orphan test", vector: randomVec(DIM),
      category: "fact", scope: "global", importance: 0.5,
    });

    // Verify exists
    assert.equal(await store.hasId(entry.id), true);
    const bm25 = await store.bm25Search("orphan test", 5);
    assert.ok(bm25.length > 0, "should find via BM25 before delete");

    // Delete
    await store.delete(entry.id);

    // Verify cleaned up
    assert.equal(await store.hasId(entry.id), false);
    const bm25After = await store.bm25Search("orphan test", 5);
    assert.equal(bm25After.length, 0, "should not find via BM25 after delete");
    const vecAfter = await store.vectorSearch(randomVec(DIM), 10, 0.0);
    const orphan = vecAfter.find(r => r.entry.id === entry.id);
    assert.equal(orphan, undefined, "should not find vector after delete");
  });

  it("update with new text re-embeds vector", async () => {
    const origVec = [1, 0, 0, 0]; // normalized direction
    const entry = await store.store({
      text: "original text", vector: origVec,
      category: "fact", scope: "global", importance: 0.5,
    });

    const newVec = [0, 1, 0, 0]; // orthogonal
    await store.update(entry.id, { text: "updated text", vector: newVec });

    // Search should find updated vector, not original
    const results = await store.vectorSearch(newVec, 1, 0.0);
    assert.ok(results.length > 0);
    assert.equal(results[0].entry.text, "updated text");

    // Original direction should NOT match well
    const origResults = await store.vectorSearch(origVec, 1, 0.0);
    assert.ok(origResults.length > 0);
    // The score for original direction should be low (orthogonal vectors)
    assert.ok(origResults[0].score < 0.6, "original vector direction should score low after update");
  });

  // =========================================================================
  // Meta helpers
  // =========================================================================

  it("getMeta/setMeta/deleteMeta round-trip", () => {
    assert.equal(store.getMeta("test_key"), null);
    store.setMeta("test_key", "test_value");
    assert.equal(store.getMeta("test_key"), "test_value");
    store.deleteMeta("test_key");
    assert.equal(store.getMeta("test_key"), null);
  });
});
