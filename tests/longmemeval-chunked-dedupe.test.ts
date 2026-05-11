/**
 * Unit tests for dedupeChunkResultsBySession — the session-level
 * dedup layer added to longmemeval-benchmark.ts Phase 1 when the
 * benchmark switched from whole-session embeddings to chunked
 * embeddings. Without this dedup, the top-K would be overrun with
 * multiple chunks from the same session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dedupeChunkResultsBySession } from "./longmemeval-benchmark.js";

/** Minimal shape the function needs — just entry.text + entry.metadata. */
type Chunk = { entry: { text: string; metadata?: string | null } };

function chunk(sessionId: string, chunkIdx: number, text: string): Chunk {
  return { entry: { text, metadata: JSON.stringify({ sessionId, chunkIdx }) } };
}

describe("dedupeChunkResultsBySession", () => {
  it("returns the top-K distinct sessions in score order", () => {
    const results: Chunk[] = [
      chunk("session-A", 0, "A chunk 0 — most relevant"),
      chunk("session-A", 1, "A chunk 1 — also relevant"),
      chunk("session-B", 0, "B chunk 0"),
      chunk("session-C", 2, "C chunk 2"),
      chunk("session-A", 2, "A chunk 2"),
      chunk("session-D", 0, "D chunk 0"),
    ];
    const { retrievedSessionIds, retrievedTexts } = dedupeChunkResultsBySession(results, 3);
    assert.deepEqual(retrievedSessionIds, ["session-A", "session-B", "session-C"]);
    assert.equal(retrievedTexts[0], "A chunk 0 — most relevant");
    assert.equal(retrievedTexts[1], "B chunk 0");
    assert.equal(retrievedTexts[2], "C chunk 2");
  });

  it("keeps the first occurrence per session (max-sim aggregation)", () => {
    // Results sorted descending by score → the first chunk seen is the best
    const results: Chunk[] = [
      chunk("X", 3, "X best"),  // high score
      chunk("X", 0, "X second"),
      chunk("X", 1, "X third"),
      chunk("Y", 0, "Y only"),
    ];
    const { retrievedTexts } = dedupeChunkResultsBySession(results, 10);
    assert.equal(retrievedTexts[0], "X best", "should pick the highest-scoring X chunk");
    assert.equal(retrievedTexts[1], "Y only");
    assert.equal(retrievedTexts.length, 2);
  });

  it("stops at K even if more sessions are available", () => {
    const results: Chunk[] = [
      chunk("a", 0, "a"),
      chunk("b", 0, "b"),
      chunk("c", 0, "c"),
      chunk("d", 0, "d"),
      chunk("e", 0, "e"),
    ];
    const { retrievedSessionIds } = dedupeChunkResultsBySession(results, 3);
    assert.deepEqual(retrievedSessionIds, ["a", "b", "c"]);
  });

  it("handles fewer distinct sessions than K (returns all of them)", () => {
    const results: Chunk[] = [
      chunk("only-session", 0, "first chunk"),
      chunk("only-session", 1, "second chunk"),
      chunk("only-session", 2, "third chunk"),
    ];
    const { retrievedSessionIds } = dedupeChunkResultsBySession(results, 5);
    assert.deepEqual(retrievedSessionIds, ["only-session"]);
  });

  it("skips entries with missing or empty sessionId", () => {
    const results: Chunk[] = [
      { entry: { text: "no metadata", metadata: null } },
      { entry: { text: "empty sessionId", metadata: JSON.stringify({ sessionId: "" }) } },
      chunk("valid", 0, "valid session"),
      { entry: { text: "no sessionId key", metadata: JSON.stringify({ chunkIdx: 0 }) } },
    ];
    const { retrievedSessionIds } = dedupeChunkResultsBySession(results, 10);
    assert.deepEqual(retrievedSessionIds, ["valid"]);
  });

  it("skips entries with malformed metadata JSON", () => {
    const results: Chunk[] = [
      { entry: { text: "bad json", metadata: "{not json" } },
      chunk("valid", 0, "ok"),
    ];
    const { retrievedSessionIds } = dedupeChunkResultsBySession(results, 10);
    assert.deepEqual(retrievedSessionIds, ["valid"]);
  });

  it("returns empty arrays on empty input", () => {
    const { retrievedSessionIds, retrievedTexts } = dedupeChunkResultsBySession([], 5);
    assert.deepEqual(retrievedSessionIds, []);
    assert.deepEqual(retrievedTexts, []);
  });

  it("is order-preserving: input order drives output order", () => {
    // If results come back as A, B, C, ... the output should be A, B, C, ...
    // The dedup is "first occurrence wins" so this invariant matters.
    const results: Chunk[] = [
      chunk("C", 0, "C"),
      chunk("A", 0, "A"),
      chunk("B", 0, "B"),
    ];
    const { retrievedSessionIds } = dedupeChunkResultsBySession(results, 10);
    assert.deepEqual(retrievedSessionIds, ["C", "A", "B"]);
  });

  it("K=0 returns empty (edge case)", () => {
    const results: Chunk[] = [
      chunk("a", 0, "a"),
      chunk("b", 0, "b"),
    ];
    const { retrievedSessionIds } = dedupeChunkResultsBySession(results, 0);
    assert.deepEqual(retrievedSessionIds, []);
  });

  it("K=1 returns only the highest-scored session", () => {
    const results: Chunk[] = [
      chunk("winner", 0, "winner chunk"),
      chunk("runner-up", 0, "runner-up"),
    ];
    const { retrievedSessionIds, retrievedTexts } = dedupeChunkResultsBySession(results, 1);
    assert.deepEqual(retrievedSessionIds, ["winner"]);
    assert.deepEqual(retrievedTexts, ["winner chunk"]);
  });
});
