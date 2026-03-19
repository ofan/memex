/**
 * Tests for src/store.ts (LanceDB storage layer)
 *
 * Uses real LanceDB with temp directories for isolated tests.
 * These tests verify CRUD operations, vector search, BM25, scope filtering.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore, validateStoragePath } from "../src/memory.js";

const VECTOR_DIM = 8; // Small for fast tests

function makeVector(seed: number): number[] {
  // Deterministic unit vector for reproducible search results
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "store-test-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: VECTOR_DIM });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  describe("store", () => {
    it("stores a memory entry", async () => {
      const entry = await store.store({
        text: "User prefers dark mode",
        vector: makeVector(1),
        category: "preference",
        scope: "global",
        importance: 0.8,
      });

      assert.ok(entry.id, "entry should have an id");
      assert.equal(entry.text, "User prefers dark mode");
      assert.equal(entry.category, "preference");
      assert.equal(entry.scope, "global");
      assert.equal(entry.importance, 0.8);
      assert.ok(entry.timestamp > 0);
    });

    it("auto-generates id and timestamp", async () => {
      const entry = await store.store({
        text: "Auto-generated fields",
        vector: makeVector(2),
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      assert.ok(entry.id.length > 0);
      assert.ok(entry.timestamp > Date.now() - 10000);
    });

    it("rejects wrong vector dimensions on importEntry", async () => {
      await assert.rejects(
        () => store.importEntry({
          id: "test-dim-check",
          text: "Wrong dims",
          vector: [1, 2, 3], // Wrong: 3 instead of VECTOR_DIM
          category: "fact",
          scope: "global",
          importance: 0.7,
          timestamp: Date.now(),
        }),
        /dimension mismatch/i
      );
    });
  });

  describe("vectorSearch", () => {
    it("finds stored entries by vector similarity", async () => {
      const vec = makeVector(10);
      await store.store({
        text: "Target memory",
        vector: vec,
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      // Search with the same vector (should be a perfect match)
      const results = await store.vectorSearch(vec, 5, 0.1, ["global"]);
      assert.ok(results.length >= 1);
      assert.equal(results[0].entry.text, "Target memory");
      assert.ok(results[0].score > 0.5, `score ${results[0].score} should be high`);
    });

    it("respects scope filter", async () => {
      const vec = makeVector(20);
      await store.store({
        text: "Private memory",
        vector: vec,
        category: "fact",
        scope: "agent:private",
        importance: 0.7,
      });

      // Search in global scope should not find agent:private
      const globalResults = await store.vectorSearch(vec, 5, 0.1, ["global"]);
      assert.equal(globalResults.length, 0);

      // Search in agent:private should find it
      const privateResults = await store.vectorSearch(vec, 5, 0.1, ["agent:private"]);
      assert.ok(privateResults.length >= 1);
    });

    it("respects minScore threshold", async () => {
      const vec = makeVector(30);
      await store.store({
        text: "Stored memory",
        vector: vec,
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      // Very different vector should have low similarity
      const orthogonal = makeVector(999);
      const results = await store.vectorSearch(orthogonal, 5, 0.99, ["global"]);
      // With very high minScore, only near-exact matches pass
      // Result might or might not pass depending on cosine similarity
      for (const r of results) {
        assert.ok(r.score >= 0.99);
      }
    });

    it("limits results", async () => {
      const vec = makeVector(40);
      for (let i = 0; i < 5; i++) {
        await store.store({
          text: `Memory ${i}`,
          vector: makeVector(40 + i * 0.01), // Slightly different vectors
          category: "fact",
          scope: "global",
          importance: 0.7,
        });
      }

      const results = await store.vectorSearch(vec, 2, 0.1, ["global"]);
      assert.ok(results.length <= 2);
    });
  });

  describe("hasId", () => {
    it("returns true for existing entry", async () => {
      const entry = await store.store({
        text: "Test entry",
        vector: makeVector(50),
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      assert.equal(await store.hasId(entry.id), true);
    });

    it("returns false for non-existing entry", async () => {
      // Need at least one entry to initialize the table
      await store.store({
        text: "Init",
        vector: makeVector(51),
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      assert.equal(await store.hasId("nonexistent-id"), false);
    });
  });

  describe("delete", () => {
    it("deletes entry by id", async () => {
      const entry = await store.store({
        text: "To be deleted",
        vector: makeVector(60),
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      const deleted = await store.delete(entry.id);
      assert.equal(deleted, true);

      assert.equal(await store.hasId(entry.id), false);
    });

    it("returns false for non-existing entry", async () => {
      // Initialize table first
      await store.store({
        text: "Init",
        vector: makeVector(61),
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      const deleted = await store.delete("00000000-0000-0000-0000-000000000000");
      assert.equal(deleted, false);
    });
  });

  describe("importEntry", () => {
    it("preserves id and timestamp", async () => {
      const entry = await store.importEntry({
        id: "preserved-id-123",
        text: "Imported memory",
        vector: makeVector(70),
        category: "decision",
        scope: "global",
        importance: 0.9,
        timestamp: 1700000000000,
      });

      assert.equal(entry.id, "preserved-id-123");
      assert.equal(entry.timestamp, 1700000000000);
    });

    it("rejects entries without id", async () => {
      await assert.rejects(
        () => store.importEntry({
          id: "",
          text: "No id",
          vector: makeVector(71),
          category: "fact",
          scope: "global",
          importance: 0.7,
          timestamp: Date.now(),
        }),
        /requires a stable id/
      );
    });
  });

  describe("hasFtsSupport", () => {
    it("reports FTS availability", async () => {
      // Trigger initialization
      await store.store({
        text: "FTS test",
        vector: makeVector(80),
        category: "fact",
        scope: "global",
        importance: 0.7,
      });

      // hasFtsSupport should be a boolean
      assert.equal(typeof store.hasFtsSupport, "boolean");
    });
  });
});

describe("validateStoragePath", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "validate-path-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  it("accepts valid writable directory", () => {
    const resolved = validateStoragePath(tmpDir);
    assert.ok(resolved.length > 0);
  });

  it("creates missing directories", () => {
    const nested = join(tmpDir, "deep", "nested", "dir");
    const resolved = validateStoragePath(nested);
    assert.ok(resolved.length > 0);
  });
});

// =============================================================================
// QMD FTS query builder
// =============================================================================

import { buildFTS5Query } from "../src/search.js";

describe("buildFTS5Query", () => {
  it("returns null for empty/whitespace input", () => {
    assert.equal(buildFTS5Query(""), null);
    assert.equal(buildFTS5Query("   "), null);
  });

  it("uses prefix matching for single terms", () => {
    const result = buildFTS5Query("selenium");
    assert.equal(result, '"selenium"*');
  });

  it("uses OR matching for multi-term queries", () => {
    const result = buildFTS5Query("selenium prevent cancer");
    assert.ok(result !== null);
    assert.ok(!result.includes(" AND "), `Expected OR matching, got: ${result}`);
    assert.ok(result.includes(" OR "), `Expected OR in query, got: ${result}`);
    assert.equal(result, '"selenium"* OR "prevent"* OR "cancer"*');
  });

  it("sanitizes special characters", () => {
    const result = buildFTS5Query("hello-world foo.bar");
    assert.ok(result !== null);
    assert.ok(!result.includes("-"), `Should strip hyphens: ${result}`);
    assert.ok(!result.includes("."), `Should strip dots: ${result}`);
  });

  it("splits dotted identifiers into separate terms", () => {
    const result = buildFTS5Query("app.example.com");
    assert.ok(result !== null);
    // Should split into 3 terms, not concatenate to "appexamplecom"
    assert.ok(result.includes('"app"*'), `Should contain app: ${result}`);
    assert.ok(result.includes('"example"*'), `Should contain example: ${result}`);
    assert.ok(result.includes('"com"*'), `Should contain com: ${result}`);
  });

  it("splits hyphenated model names into separate terms", () => {
    const result = buildFTS5Query("bge-reranker-v2-m3");
    assert.ok(result !== null);
    assert.ok(result.includes('"bge"*'), `Should contain bge: ${result}`);
    assert.ok(result.includes('"reranker"*'), `Should contain reranker: ${result}`);
    assert.ok(result.includes('"v2"*'), `Should contain v2: ${result}`);
    assert.ok(result.includes('"m3"*'), `Should contain m3: ${result}`);
  });
});
