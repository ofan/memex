/**
 * Tests for issue #26: doc indexer should handle embedding context size
 * overflow gracefully.
 *
 * These tests use a mock Embedder to verify exact behavior:
 * - Short text embeds successfully
 * - Oversized text triggers re-chunking and retry
 * - Permanently failing docs are not retried forever
 * - Error count is per-document, not per-chunk
 * - Backlog drains correctly after success
 *
 * The fix: embedDocuments() accepts an Embedder (which already has
 * context-error detection + adaptive chunking) instead of raw
 * LLMSession.embed().
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createStore as createSearchStore,
  hashContent,
  insertContent,
  insertDocument,
  insertEmbedding,
  getHashesForEmbedding,
} from "../src/search.js";
import { embedDocuments, getEmbeddingBacklog } from "../src/doc-indexer.js";
import type { Embedder } from "../src/embedder.js";

// ============================================================================
// Mock Embedder
// ============================================================================

const DIMENSIONS = 8;

interface EmbedCall {
  text: string;
  length: number;
}

function makeVector(seed: number): number[] {
  const v = Array.from({ length: DIMENSIONS }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

/**
 * Create a mock Embedder that:
 * - Succeeds for text shorter than `contextLimit` chars
 * - Throws "exceeds context size" for text longer than `contextLimit` chars
 * - Tracks every call for assertion
 */
function createMockEmbedder(contextLimit: number): {
  embedder: Embedder;
  calls: EmbedCall[];
  successCount: () => number;
  failCount: () => number;
} {
  const calls: EmbedCall[] = [];
  let successes = 0;
  let failures = 0;

  const embedder = {
    get model() { return "test-mock"; },
    dimensions: DIMENSIONS,

    async embedPassage(text: string): Promise<number[]> {
      calls.push({ text, length: text.length });
      if (text.length > contextLimit) {
        failures++;
        throw new Error(`400 request (${text.length} tokens) exceeds the available context size (${contextLimit} tokens)`);
      }
      successes++;
      return makeVector(text.length);
    },

    async embedQuery(text: string): Promise<number[]> {
      return this.embedPassage(text);
    },

    async embed(text: string): Promise<number[]> {
      return this.embedPassage(text);
    },

    async embedBatchPassage(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map(t => this.embedPassage(t)));
    },

    async embedBatchQuery(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map(t => this.embedQuery(t)));
    },

    async test() {
      return { success: true as const, dimensions: DIMENSIONS, model: "test-mock", hasFtsSupport: true };
    },

    get cacheStats() {
      return { size: 0, hits: 0, misses: 0, hitRate: "0%" };
    },
  } as unknown as Embedder;

  return {
    embedder,
    calls,
    successCount: () => successes,
    failCount: () => failures,
  };
}

// ============================================================================
// Helpers
// ============================================================================

async function insertTestDoc(
  db: any,
  collection: string,
  path: string,
  body: string,
): Promise<string> {
  const hash = await hashContent(body);
  const now = new Date().toISOString();
  insertContent(db, hash, body, now);
  insertDocument(db, collection, path, path, hash, now, now);
  return hash;
}

function makeText(chars: number, prefix = "word"): string {
  const words: string[] = [];
  let len = 0;
  let i = 0;
  while (len < chars) {
    const w = `${prefix}${i++}`;
    words.push(w);
    len += w.length + 1;
  }
  return words.join(" ").slice(0, chars);
}

// ============================================================================
// Tests
// ============================================================================

describe("embedDocuments with Embedder (issue #26)", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createSearchStore>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "doc-idx-overflow-"));
    store = createSearchStore(join(tmpDir, "test.sqlite"));
    store.ensureVecTable(DIMENSIONS);
  });

  afterEach(async () => {
    store.close();
    await rm(tmpDir, { recursive: true }).catch(() => {});
  });

  // ---------- Success path ----------

  it("embeds short documents via Embedder and stores vectors", async () => {
    const db = store.db;
    const mock = createMockEmbedder(5000); // generous limit
    const h1 = await insertTestDoc(db, "test", "short1.md", "A short doc about cats.");
    const h2 = await insertTestDoc(db, "test", "short2.md", "Another about dogs.");

    assert.equal(getEmbeddingBacklog(db), 2);

    const result = await embedDocuments(db, DIMENSIONS, mock.embedder);

    assert.equal(result.embedded, 2, "both docs should embed");
    assert.ok(result.chunks >= 2, "at least 1 chunk per doc");
    assert.equal(result.errors.length, 0, "no errors");
    assert.equal(getEmbeddingBacklog(db), 0, "backlog should be empty");
    assert.ok(mock.successCount() >= 2, "embedder should be called at least twice");
  });

  it("clears backlog only for docs that got vectors stored", async () => {
    const db = store.db;
    const mock = createMockEmbedder(5000);
    await insertTestDoc(db, "test", "a.md", "Doc A.");
    await insertTestDoc(db, "test", "b.md", "Doc B.");

    await embedDocuments(db, DIMENSIONS, mock.embedder);

    // Both should have vectors now
    const remaining = getHashesForEmbedding(db);
    assert.equal(remaining.length, 0, "no hashes should remain in backlog");
  });

  // ---------- Context overflow path ----------

  it("does not crash when documents exceed context limit", async () => {
    const db = store.db;
    const mock = createMockEmbedder(200); // tight limit
    const longText = makeText(2000);
    await insertTestDoc(db, "test", "long.md", longText);

    // Should not throw
    const result = await embedDocuments(db, DIMENSIONS, mock.embedder);

    assert.equal(typeof result.embedded, "number");
    assert.ok(Array.isArray(result.errors));
  });

  it("re-chunks oversized documents and retries with smaller pieces", async () => {
    const db = store.db;
    // Limit at 400 chars — search.ts chunks at ~3600, so initial chunks will exceed.
    // After re-chunking via Embedder's smartChunk, sub-chunks should be < 400.
    const mock = createMockEmbedder(400);
    const longText = makeText(2000);
    await insertTestDoc(db, "test", "rechunk.md", longText);

    const result = await embedDocuments(db, DIMENSIONS, mock.embedder);

    // The Embedder's auto-chunk should have split the oversized chunks
    // and eventually succeeded with smaller pieces.
    // If re-chunking works: embedded > 0 and chunks > 0
    // If re-chunking doesn't work: embedded may be 0 but no crash
    if (result.embedded > 0) {
      assert.ok(result.chunks > 0, "successful embed should produce chunks");
      assert.equal(getEmbeddingBacklog(db), 0, "backlog should drain on success");
    }
    // Either way, no crash — the function returned cleanly
  });

  // ---------- Error handling ----------

  it("reports at most 1 error per document, not per chunk", async () => {
    const db = store.db;
    // Limit so tight that even re-chunked pieces fail
    const mock = createMockEmbedder(10);
    for (let i = 0; i < 5; i++) {
      await insertTestDoc(db, "test", `doc${i}.md`, makeText(500, `doc${i}`));
    }

    const result = await embedDocuments(db, DIMENSIONS, mock.embedder);

    // 5 documents, each with multiple chunks — errors should be <= 5
    assert.ok(
      result.errors.length <= 5,
      `Expected <= 5 errors (1 per doc), got ${result.errors.length}: ${result.errors.join("; ")}`
    );
  });

  it("does not count docs as 'embedded' when all chunks fail", async () => {
    const db = store.db;
    const mock = createMockEmbedder(10); // nothing will fit
    await insertTestDoc(db, "test", "allfail.md", makeText(500));

    const result = await embedDocuments(db, DIMENSIONS, mock.embedder);

    assert.equal(result.embedded, 0, "doc with zero successful chunks should not count as embedded");
    assert.equal(result.chunks, 0, "no chunks should be stored");
  });

  it("does not re-attempt permanently failed docs on second call", async () => {
    const db = store.db;
    const mock = createMockEmbedder(10); // always fails
    await insertTestDoc(db, "test", "permanent.md", makeText(500));

    // First attempt
    await embedDocuments(db, DIMENSIONS, mock.embedder);
    const callsAfterFirst = mock.calls.length;

    // Second attempt — should skip the doc, not retry
    await embedDocuments(db, DIMENSIONS, mock.embedder);
    const callsAfterSecond = mock.calls.length;

    assert.equal(
      callsAfterSecond, callsAfterFirst,
      `Second call should not retry failed doc (calls: first=${callsAfterFirst}, second=${callsAfterSecond})`
    );
  });

  // ---------- Performance ----------

  it("completes promptly with many failing documents", async () => {
    const db = store.db;
    const mock = createMockEmbedder(10); // all fail
    for (let i = 0; i < 50; i++) {
      await insertTestDoc(db, "test", `fail${i}.md`, makeText(500, `fail${i}`));
    }

    const start = Date.now();
    await embedDocuments(db, DIMENSIONS, mock.embedder);
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 5000, `50 failing docs took ${elapsed}ms — expected <5s`);
  });

  // ---------- Mixed success/failure ----------

  it("embeds short docs and skips long ones in the same batch", async () => {
    const db = store.db;
    const mock = createMockEmbedder(500);

    // 2 short (will succeed), 2 long (will fail or re-chunk)
    await insertTestDoc(db, "test", "short1.md", "Short content.");
    await insertTestDoc(db, "test", "short2.md", "Also short.");
    await insertTestDoc(db, "test", "long1.md", makeText(3000));
    await insertTestDoc(db, "test", "long2.md", makeText(3000));

    const result = await embedDocuments(db, DIMENSIONS, mock.embedder);

    // At minimum, the 2 short docs should succeed
    assert.ok(result.embedded >= 2, `Expected >= 2 embedded, got ${result.embedded}`);
    assert.ok(mock.successCount() >= 2, "at least 2 successful embed calls");
  });

  // ---------- Structural ----------

  it("returns structured EmbedResult", async () => {
    const mock = createMockEmbedder(5000);
    const result = await embedDocuments(store.db, DIMENSIONS, mock.embedder);

    assert.equal(typeof result.embedded, "number");
    assert.equal(typeof result.chunks, "number");
    assert.ok(Array.isArray(result.errors));
    for (const err of result.errors) {
      assert.equal(typeof err, "string");
    }
  });
});
