/**
 * Comprehensive tests for the SQLite-backed MemoryStore.
 *
 * Covers: store/retrieve, bulkStore, importEntry, vectorSearch, bm25Search,
 * update, delete, hasId, bulkDelete, list, stats, scope filtering,
 * rebuildFtsIndex, close.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import type { MemoryEntry } from "../src/memory.js";

const DIM = 4; // small vectors for fast tests

function randomVec(dim: number): number[] {
  return Array.from({ length: dim }, () => Math.random());
}

/** Deterministic unit vector seeded by a number. */
function seedVec(seed: number, dim: number = DIM): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

let tmpDir: string;
let store: MemoryStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mem-store-test-"));
  store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
});

afterEach(async () => {
  await store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// store / retrieve cycle
// ===========================================================================

describe("store()", () => {
  it("returns entry with generated id and timestamp", async () => {
    const before = Date.now();
    const entry = await store.store({
      text: "User prefers dark mode",
      vector: randomVec(DIM),
      category: "preference",
      scope: "global",
      importance: 0.8,
    });

    assert.ok(entry.id, "id should be non-empty");
    assert.equal(entry.text, "User prefers dark mode");
    assert.equal(entry.category, "preference");
    assert.equal(entry.scope, "global");
    assert.equal(entry.importance, 0.8);
    assert.ok(entry.timestamp >= before, "timestamp should be recent");
    assert.ok(entry.metadata, "metadata should default to '{}'");
  });

  it("entry is findable by hasId after store", async () => {
    const entry = await store.store({
      text: "test",
      vector: randomVec(DIM),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });
    assert.equal(await store.hasId(entry.id), true);
  });
});

// ===========================================================================
// bulkStore
// ===========================================================================

describe("bulkStore()", () => {
  it("inserts multiple entries atomically", async () => {
    const entries = await store.bulkStore([
      { text: "Fact A", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 },
      { text: "Fact B", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.6 },
      { text: "Fact C", vector: randomVec(DIM), category: "decision", scope: "project:x", importance: 0.9 },
    ]);

    assert.equal(entries.length, 3);
    for (const e of entries) {
      assert.ok(e.id);
      assert.ok(e.timestamp > 0);
      assert.equal(await store.hasId(e.id), true);
    }
  });
});

// ===========================================================================
// importEntry
// ===========================================================================

describe("importEntry()", () => {
  it("preserves caller-supplied id and timestamp", async () => {
    const entry = await store.importEntry({
      id: "custom-id-42",
      text: "Imported memory",
      vector: randomVec(DIM),
      category: "decision",
      scope: "global",
      importance: 0.9,
      timestamp: 1700000000000,
    });

    assert.equal(entry.id, "custom-id-42");
    assert.equal(entry.timestamp, 1700000000000);
    assert.equal(await store.hasId("custom-id-42"), true);
  });

  it("rejects empty id", async () => {
    await assert.rejects(
      () => store.importEntry({
        id: "",
        text: "no id",
        vector: randomVec(DIM),
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
      }),
      /requires a stable id/
    );
  });

  it("rejects wrong vector dimensions", async () => {
    await assert.rejects(
      () => store.importEntry({
        id: "dim-check",
        text: "wrong dims",
        vector: [1, 2, 3], // 3 instead of DIM=4
        category: "fact",
        scope: "global",
        importance: 0.5,
        timestamp: Date.now(),
      }),
      /dimension mismatch/i
    );
  });
});

// ===========================================================================
// vectorSearch
// ===========================================================================

describe("vectorSearch()", () => {
  it("returns results sorted by similarity, scores in [0,1]", async () => {
    const targetVec = seedVec(10);
    await store.store({ text: "Target", vector: targetVec, category: "fact", scope: "global", importance: 0.7 });
    await store.store({ text: "Distant", vector: seedVec(999), category: "fact", scope: "global", importance: 0.5 });

    const results = await store.vectorSearch(targetVec, 5, 0.0);
    assert.ok(results.length >= 1, "should find at least the target");

    // First result should be the target (exact match = highest score)
    assert.equal(results[0].entry.text, "Target");
    assert.ok(results[0].score >= 0 && results[0].score <= 1, `score should be in [0,1], got ${results[0].score}`);

    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i].score <= results[i - 1].score, "scores should be descending");
    }
  });

  it("respects scope filter", async () => {
    const vec = seedVec(20);
    await store.store({ text: "Private", vector: vec, category: "fact", scope: "agent:private", importance: 0.7 });

    // Global scope should not find agent:private
    const globalResults = await store.vectorSearch(vec, 5, 0.0, ["global"]);
    assert.equal(globalResults.length, 0);

    // Matching scope should find it
    const privateResults = await store.vectorSearch(vec, 5, 0.0, ["agent:private"]);
    assert.ok(privateResults.length >= 1);
  });

  it("respects minScore threshold", async () => {
    await store.store({ text: "Memory", vector: seedVec(30), category: "fact", scope: "global", importance: 0.7 });

    const results = await store.vectorSearch(seedVec(30), 5, 0.99);
    // All returned results must have score >= minScore
    for (const r of results) {
      assert.ok(r.score >= 0.99, `score ${r.score} should be >= 0.99`);
    }
  });

  it("limits result count", async () => {
    for (let i = 0; i < 10; i++) {
      await store.store({ text: `Mem ${i}`, vector: seedVec(40 + i * 0.01), category: "fact", scope: "global", importance: 0.5 });
    }

    const results = await store.vectorSearch(seedVec(40), 3, 0.0);
    assert.ok(results.length <= 3, `should return at most 3, got ${results.length}`);
  });

  it("returns empty for no scope match", async () => {
    await store.store({ text: "X", vector: seedVec(50), category: "fact", scope: "a", importance: 0.5 });
    const results = await store.vectorSearch(seedVec(50), 5, 0.0, ["b"]);
    assert.equal(results.length, 0);
  });
});

// ===========================================================================
// bm25Search
// ===========================================================================

describe("bm25Search()", () => {
  it("finds entries by keyword, scores in [0,1]", async () => {
    await store.store({ text: "Selenium prevents cancer in laboratory mice studies", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.7 });
    await store.store({ text: "TypeScript is a typed superset of JavaScript", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    const results = await store.bm25Search("selenium cancer");
    assert.ok(results.length >= 1, "should find at least one match");
    assert.ok(results[0].entry.text.includes("Selenium"), "first result should match");

    for (const r of results) {
      assert.ok(r.score >= 0 && r.score < 1, `bm25 score should be in [0,1), got ${r.score}`);
    }
  });

  it("respects scope filter", async () => {
    await store.store({ text: "Dark mode preference for editing", vector: randomVec(DIM), category: "preference", scope: "agent:x", importance: 0.8 });

    const noMatch = await store.bm25Search("dark mode", 5, ["global"]);
    assert.equal(noMatch.length, 0);

    const match = await store.bm25Search("dark mode", 5, ["agent:x"]);
    assert.ok(match.length >= 1);
  });

  it("returns empty for non-matching query", async () => {
    await store.store({ text: "Something about cats", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    const results = await store.bm25Search("xyzzyspoon");
    assert.equal(results.length, 0);
  });
});

// ===========================================================================
// update
// ===========================================================================

describe("update()", () => {
  it("updates text", async () => {
    const entry = await store.store({ text: "Old text", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    const updated = await store.update(entry.id, { text: "New text" });

    assert.ok(updated);
    assert.equal(updated!.text, "New text");
    assert.equal(updated!.id, entry.id);
    assert.equal(updated!.timestamp, entry.timestamp, "timestamp should be preserved");
  });

  it("updates importance", async () => {
    const entry = await store.store({ text: "Test", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    const updated = await store.update(entry.id, { importance: 0.95 });

    assert.ok(updated);
    assert.equal(updated!.importance, 0.95);
  });

  it("updates category", async () => {
    const entry = await store.store({ text: "Test", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    const updated = await store.update(entry.id, { category: "decision" });

    assert.ok(updated);
    assert.equal(updated!.category, "decision");
  });

  it("returns null for non-existing id", async () => {
    const result = await store.update("00000000-0000-0000-0000-000000000000", { text: "nope" });
    assert.equal(result, null);
  });

  it("throws on scope violation", async () => {
    const entry = await store.store({ text: "private", vector: randomVec(DIM), category: "fact", scope: "agent:x", importance: 0.5 });

    await assert.rejects(
      () => store.update(entry.id, { text: "hacked" }, ["global"]),
      /outside accessible scopes/
    );
  });

  it("FTS index is updated after text change", async () => {
    const entry = await store.store({ text: "original keyword xylophone", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    // Search for original keyword
    let results = await store.bm25Search("xylophone");
    assert.ok(results.length >= 1, "should find original text");

    // Update text
    await store.update(entry.id, { text: "updated keyword tambourine" });

    // Original keyword should not match anymore
    results = await store.bm25Search("xylophone");
    assert.equal(results.length, 0, "old keyword should not match after update");

    // New keyword should match
    results = await store.bm25Search("tambourine");
    assert.ok(results.length >= 1, "new keyword should match after update");
  });
});

// ===========================================================================
// delete
// ===========================================================================

describe("delete()", () => {
  it("returns true for existing entry", async () => {
    const entry = await store.store({ text: "Delete me", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    const result = await store.delete(entry.id);
    assert.equal(result, true);
    assert.equal(await store.hasId(entry.id), false);
  });

  it("returns false for non-existing entry", async () => {
    const result = await store.delete("00000000-0000-0000-0000-000000000000");
    assert.equal(result, false);
  });

  it("throws on scope violation", async () => {
    const entry = await store.store({ text: "private", vector: randomVec(DIM), category: "fact", scope: "agent:x", importance: 0.5 });

    await assert.rejects(
      () => store.delete(entry.id, ["global"]),
      /outside accessible scopes/
    );
  });

  it("FTS entry is removed after delete", async () => {
    const entry = await store.store({ text: "unique keyword accordion", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    let results = await store.bm25Search("accordion");
    assert.ok(results.length >= 1);

    await store.delete(entry.id);

    results = await store.bm25Search("accordion");
    assert.equal(results.length, 0, "FTS entry should be removed after delete");
  });
});

// ===========================================================================
// hasId
// ===========================================================================

describe("hasId()", () => {
  it("returns true for existing id", async () => {
    const entry = await store.store({ text: "exists", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    assert.equal(await store.hasId(entry.id), true);
  });

  it("returns false for non-existing id", async () => {
    assert.equal(await store.hasId("does-not-exist"), false);
  });
});

// ===========================================================================
// bulkDelete
// ===========================================================================

describe("bulkDelete()", () => {
  it("deletes by scope", async () => {
    await store.store({ text: "A", vector: randomVec(DIM), category: "fact", scope: "session:1", importance: 0.5 });
    await store.store({ text: "B", vector: randomVec(DIM), category: "fact", scope: "session:1", importance: 0.5 });
    await store.store({ text: "C", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    const count = await store.bulkDelete(["session:1"]);
    assert.equal(count, 2);

    const stats = await store.stats();
    assert.equal(stats.totalCount, 1);
  });

  it("deletes by scope AND timestamp", async () => {
    // Insert with specific timestamps via importEntry
    await store.importEntry({ id: "old-1", text: "Old", vector: randomVec(DIM), category: "fact", scope: "session:1", importance: 0.5, timestamp: 1000 });
    await store.importEntry({ id: "new-1", text: "New", vector: randomVec(DIM), category: "fact", scope: "session:1", importance: 0.5, timestamp: 9000 });

    const count = await store.bulkDelete(["session:1"], 5000);
    assert.equal(count, 1, "should only delete the old entry");
    assert.equal(await store.hasId("old-1"), false);
    assert.equal(await store.hasId("new-1"), true);
  });

  it("throws without any filter", async () => {
    await assert.rejects(
      () => store.bulkDelete([]),
      /requires at least/
    );
  });
});

// ===========================================================================
// list
// ===========================================================================

describe("list()", () => {
  it("returns entries sorted by timestamp descending", async () => {
    await store.importEntry({ id: "e1", text: "First", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5, timestamp: 1000 });
    await store.importEntry({ id: "e2", text: "Second", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5, timestamp: 3000 });
    await store.importEntry({ id: "e3", text: "Third", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5, timestamp: 2000 });

    const entries = await store.list();
    assert.equal(entries.length, 3);
    assert.equal(entries[0].text, "Second");  // newest
    assert.equal(entries[1].text, "Third");
    assert.equal(entries[2].text, "First");   // oldest
  });

  it("filters by scope", async () => {
    await store.store({ text: "A", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    await store.store({ text: "B", vector: randomVec(DIM), category: "fact", scope: "agent:x", importance: 0.5 });

    const globalEntries = await store.list(["global"]);
    assert.equal(globalEntries.length, 1);
    assert.equal(globalEntries[0].text, "A");
  });

  it("filters by category", async () => {
    await store.store({ text: "Pref", vector: randomVec(DIM), category: "preference", scope: "global", importance: 0.5 });
    await store.store({ text: "Fact", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    const prefs = await store.list(undefined, "preference");
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0].category, "preference");
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await store.importEntry({ id: `l${i}`, text: `Entry ${i}`, vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5, timestamp: 1000 + i * 100 });
    }

    const page1 = await store.list(undefined, undefined, 2, 0);
    assert.equal(page1.length, 2);

    const page2 = await store.list(undefined, undefined, 2, 2);
    assert.equal(page2.length, 2);

    // No overlap between pages
    const page1Ids = page1.map(e => e.id);
    const page2Ids = page2.map(e => e.id);
    for (const id of page2Ids) {
      assert.ok(!page1Ids.includes(id), `Page 2 ID ${id} should not overlap with page 1`);
    }
  });
});

// ===========================================================================
// stats
// ===========================================================================

describe("stats()", () => {
  it("returns correct counts", async () => {
    await store.store({ text: "A", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5, metadata: '{"source":"auto"}' });
    await store.store({ text: "B", vector: randomVec(DIM), category: "preference", scope: "global", importance: 0.8, metadata: '{"source":"manual"}' });
    await store.store({ text: "C", vector: randomVec(DIM), category: "fact", scope: "agent:x", importance: 0.6, metadata: '{"source":"auto"}' });

    const stats = await store.stats();
    assert.equal(stats.totalCount, 3);
    assert.equal(stats.scopeCounts["global"], 2);
    assert.equal(stats.scopeCounts["agent:x"], 1);
    assert.equal(stats.categoryCounts["fact"], 2);
    assert.equal(stats.categoryCounts["preference"], 1);
    assert.equal(stats.sourceCounts["auto"], 2);
    assert.equal(stats.sourceCounts["manual"], 1);
  });

  it("filters by scope", async () => {
    await store.store({ text: "A", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });
    await store.store({ text: "B", vector: randomVec(DIM), category: "fact", scope: "agent:x", importance: 0.5 });

    const stats = await store.stats(["global"]);
    assert.equal(stats.totalCount, 1);
    assert.equal(stats.scopeCounts["global"], 1);
    assert.ok(!stats.scopeCounts["agent:x"]);
  });
});

// ===========================================================================
// scope filtering across operations
// ===========================================================================

describe("scope filtering", () => {
  it("vectorSearch with multiple scopes", async () => {
    const vec = seedVec(100);
    await store.store({ text: "In A", vector: vec, category: "fact", scope: "a", importance: 0.5 });
    await store.store({ text: "In B", vector: vec, category: "fact", scope: "b", importance: 0.5 });
    await store.store({ text: "In C", vector: vec, category: "fact", scope: "c", importance: 0.5 });

    const results = await store.vectorSearch(vec, 10, 0.0, ["a", "b"]);
    assert.equal(results.length, 2);
    const texts = results.map(r => r.entry.text).sort();
    assert.deepEqual(texts, ["In A", "In B"]);
  });

  it("bm25Search with multiple scopes", async () => {
    await store.store({ text: "unique keyword harmonica in scope a", vector: randomVec(DIM), category: "fact", scope: "a", importance: 0.5 });
    await store.store({ text: "unique keyword harmonica in scope b", vector: randomVec(DIM), category: "fact", scope: "b", importance: 0.5 });
    await store.store({ text: "unique keyword harmonica in scope c", vector: randomVec(DIM), category: "fact", scope: "c", importance: 0.5 });

    const results = await store.bm25Search("harmonica", 10, ["a", "c"]);
    assert.equal(results.length, 2);
  });
});

// ===========================================================================
// rebuildFtsIndex
// ===========================================================================

describe("rebuildFtsIndex()", () => {
  it("rebuilds FTS index from memories table", async () => {
    await store.store({ text: "keyword clarinet", vector: randomVec(DIM), category: "fact", scope: "global", importance: 0.5 });

    // Should find via FTS before rebuild
    let results = await store.bm25Search("clarinet");
    assert.ok(results.length >= 1);

    // Rebuild should not break anything
    await store.rebuildFtsIndex();

    results = await store.bm25Search("clarinet");
    assert.ok(results.length >= 1, "FTS should still work after rebuild");
  });
});

// ===========================================================================
// hasFtsSupport
// ===========================================================================

describe("hasFtsSupport", () => {
  it("returns true for SQLite-backed store", () => {
    assert.equal(store.hasFtsSupport, true);
  });
});

// ===========================================================================
// dbPath
// ===========================================================================

describe("dbPath", () => {
  it("returns the configured path", () => {
    assert.ok(store.dbPath.endsWith("test.sqlite"));
  });
});

// ===========================================================================
// close
// ===========================================================================

describe("close()", () => {
  it("can be called without error", async () => {
    await store.close();
    // Re-create for afterEach
    store = new MemoryStore({ dbPath: join(tmpDir, "test2.sqlite"), vectorDim: DIM });
  });
});

// ===========================================================================
// chunked embedding (multi-vector)
// ===========================================================================

describe("chunked embedding (multi-vector)", () => {
  it("stores single vector for short text", async () => {
    const entry = await store.store({
      text: "User prefers dark mode",
      vector: seedVec(1),
      category: "preference",
      scope: "global",
      importance: 0.7,
    });
    const vecCount = store.getVectorCount(entry.id);
    assert.equal(vecCount, 1);
  });

  it("stores multiple vectors for long text", async () => {
    const longText = "Important fact. ".repeat(200); // ~3200 chars
    const chunks = store.chunkForEmbedding(longText);
    assert.ok(chunks.length >= 2, `Expected >=2 chunks, got ${chunks.length}`);

    const chunkVectors = chunks.map((_, i) => seedVec(10 + i));

    const entry = await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    const vecCount = store.getVectorCount(entry.id);
    assert.equal(vecCount, chunkVectors.length);
  });

  it("vectorSearch returns max-sim score across chunks", async () => {
    const longText = "First chunk about cooking. ".repeat(50) +
                     "Second chunk about astronomy and stars. ".repeat(50);
    const chunks = store.chunkForEmbedding(longText);

    const cookingVec = seedVec(100);
    const astronomyVec = seedVec(200);
    const chunkVectors = chunks.length >= 2
      ? [cookingVec, astronomyVec, ...chunks.slice(2).map((_, i) => seedVec(300 + i))]
      : [cookingVec];

    await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    const results = await store.vectorSearch(astronomyVec, 5, 0.0);
    assert.ok(results.length > 0, "Should find the memory");

    const topScore = results[0].score;
    assert.ok(topScore > 0.9, `Expected high score from matching chunk, got ${topScore}`);
  });

  it("delete removes all chunk vectors", async () => {
    const longText = "Some content here. ".repeat(200);
    const chunks = store.chunkForEmbedding(longText);
    const chunkVectors = chunks.map((_, i) => seedVec(50 + i));

    const entry = await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    assert.ok(store.getVectorCount(entry.id) >= 2);
    await store.delete(entry.id);
    assert.equal(store.getVectorCount(entry.id), 0);
  });

  it("update replaces all chunk vectors", async () => {
    const longText = "Original content. ".repeat(200);
    const chunks = store.chunkForEmbedding(longText);
    const chunkVectors = chunks.map((_, i) => seedVec(60 + i));

    const entry = await store.storeWithChunks({
      text: longText,
      chunkVectors,
      category: "fact",
      scope: "global",
      importance: 0.7,
    });

    const origCount = store.getVectorCount(entry.id);
    assert.ok(origCount >= 2);

    const newVec = seedVec(99);
    await store.update(entry.id, { text: "Updated short text", vector: newVec });

    assert.equal(store.getVectorCount(entry.id), 1);
  });

  it("chunkForEmbedding returns single chunk for short text", () => {
    const chunks = store.chunkForEmbedding("Short text");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], "Short text");
  });
});
