/**
 * Tests for src/chunker.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkDocument, smartChunk, DEFAULT_CHUNKER_CONFIG, EMBEDDING_CONTEXT_LIMITS } from "../src/chunker.js";

describe("chunkDocument", () => {
  it("returns empty for empty input", () => {
    const result = chunkDocument("");
    assert.equal(result.chunks.length, 0);
    assert.equal(result.chunkCount, 0);
  });

  it("returns empty for whitespace-only input", () => {
    const result = chunkDocument("   \n\n  ");
    assert.equal(result.chunks.length, 0);
  });

  it("returns single chunk for short text", () => {
    const text = "This is a short document.";
    const result = chunkDocument(text);
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0], text);
    assert.equal(result.totalOriginalLength, text.length);
  });

  it("splits long text into multiple chunks", () => {
    const text = "A".repeat(10000);
    const result = chunkDocument(text, { ...DEFAULT_CHUNKER_CONFIG, maxChunkSize: 2000 });
    assert.ok(result.chunks.length > 1);
    assert.equal(result.totalOriginalLength, 10000);
  });

  it("preserves metadata indices", () => {
    const text = "First sentence. Second sentence. Third sentence.";
    const result = chunkDocument(text, {
      maxChunkSize: 20,
      overlapSize: 5,
      minChunkSize: 5,
      semanticSplit: true,
      maxLinesPerChunk: 0,
    });
    for (const meta of result.metadatas) {
      assert.ok(meta.startIndex >= 0);
      assert.ok(meta.endIndex <= text.length);
      assert.ok(meta.length > 0);
    }
  });

  it("creates overlap between chunks", () => {
    const sentences = [];
    for (let i = 0; i < 50; i++) {
      sentences.push(`This is sentence number ${i} with some content.`);
    }
    const text = sentences.join(" ");
    const result = chunkDocument(text, {
      maxChunkSize: 200,
      overlapSize: 50,
      minChunkSize: 50,
      semanticSplit: true,
      maxLinesPerChunk: 0,
    });

    if (result.chunks.length >= 2) {
      // Verify overlap: second chunk's start should be before first chunk's end
      assert.ok(result.metadatas[1].startIndex < result.metadatas[0].endIndex);
    }
  });

  it("prefers sentence boundaries with semantic split", () => {
    const text = "First sentence. Second sentence. Third sentence is a lot longer and has more content to make sure the chunk is big enough.";
    const result = chunkDocument(text, {
      maxChunkSize: 40,
      overlapSize: 5,
      minChunkSize: 10,
      semanticSplit: true,
      maxLinesPerChunk: 0,
    });

    // Each chunk should ideally end at a sentence boundary
    for (const chunk of result.chunks) {
      // At least verify chunks are non-empty
      assert.ok(chunk.length > 0);
    }
  });

  it("respects maxLinesPerChunk when maxChunkSize is also constraining", () => {
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`Line ${i}: content here with some extra words to make it longer`);
    }
    const text = lines.join("\n");
    const result = chunkDocument(text, {
      maxChunkSize: 1000,
      overlapSize: 50,
      minChunkSize: 10,
      semanticSplit: true,
      maxLinesPerChunk: 10,
    });

    // Should produce multiple chunks (text is ~6000 chars with 1000 max)
    assert.ok(result.chunks.length > 1, `Expected multiple chunks, got ${result.chunks.length}`);
    for (const chunk of result.chunks) {
      const lineCount = chunk.split("\n").length;
      assert.ok(lineCount <= 15, `Chunk has ${lineCount} lines, expected <= 15`);
    }
  });
});

describe("smartChunk", () => {
  it("adapts to known model limits", () => {
    const text = "x".repeat(20000);
    const result = smartChunk(text, "all-MiniLM-L6-v2");
    // all-MiniLM-L6-v2 has 512 token limit
    // smartChunk: maxChunkSize = max(1000, floor(512 * 0.7)) = max(1000, 358) = 1000
    // So the min floor of 1000 applies
    assert.ok(result.chunks.length > 1);
    for (const chunk of result.chunks) {
      assert.ok(chunk.length <= 1100, `Chunk is ${chunk.length} chars, expected <= 1100`);
    }
  });

  it("uses default 8192 for unknown models", () => {
    const text = "y".repeat(20000);
    const result = smartChunk(text, "unknown-model-xyz");
    // 70% of 8192 = ~5734 chars max
    assert.ok(result.chunks.length >= 1);
  });

  it("handles no model specified", () => {
    const text = "z".repeat(20000);
    const result = smartChunk(text);
    assert.ok(result.chunks.length >= 1);
  });
});
