/**
 * Tests for src/embedder.ts
 *
 * Tests the Embedder class with a mock HTTP server to avoid external API calls.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Embedder, createEmbedder, getVectorDimensions } from "../src/embedder.js";

// ============================================================================
// Mock Embedding Server
// ============================================================================

function createMockEmbeddingServer(dimensions = 384) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const payload = JSON.parse(body);
      const inputs = Array.isArray(payload.input) ? payload.input : [payload.input];

      const data = inputs.map((input: string, index: number) => ({
        object: "embedding",
        index,
        embedding: new Array(dimensions).fill(0).map((_, i) => Math.sin(i * 0.1 + input.length)),
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data, model: payload.model, usage: { prompt_tokens: 10, total_tokens: 10 } }));
    });
  });

  return server;
}

// ============================================================================
// Tests
// ============================================================================

describe("getVectorDimensions", () => {
  it("returns known model dimensions", () => {
    assert.equal(getVectorDimensions("text-embedding-3-small"), 1536);
    assert.equal(getVectorDimensions("all-MiniLM-L6-v2"), 384);
    assert.equal(getVectorDimensions("BAAI/bge-m3"), 1024);
  });

  it("uses override dimensions", () => {
    assert.equal(getVectorDimensions("unknown-model", 512), 512);
    assert.equal(getVectorDimensions("text-embedding-3-small", 768), 768);
  });

  it("throws for unknown model without override", () => {
    assert.throws(() => getVectorDimensions("unknown-model"));
  });
});

describe("Embedder", () => {
  let server: ReturnType<typeof createMockEmbeddingServer>;
  let baseURL: string;
  let embedder: Embedder;

  beforeEach(async () => {
    server = createMockEmbeddingServer(384);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseURL = `http://127.0.0.1:${addr.port}/v1`;

    embedder = createEmbedder({
      provider: "openai-compatible",
      apiKey: "test-key",
      model: "all-MiniLM-L6-v2",
      baseURL,
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe("embedQuery", () => {
    it("returns vector with correct dimensions", async () => {
      const vec = await embedder.embedQuery("test query");
      assert.equal(vec.length, 384);
    });

    it("throws on empty text", async () => {
      await assert.rejects(() => embedder.embedQuery(""), /empty text/i);
      await assert.rejects(() => embedder.embedQuery("  "), /empty text/i);
    });
  });

  describe("embedPassage", () => {
    it("returns vector with correct dimensions", async () => {
      const vec = await embedder.embedPassage("This is a longer passage about something important.");
      assert.equal(vec.length, 384);
    });
  });

  describe("embed (backward compat)", () => {
    it("works as alias for embedPassage", async () => {
      const vec = await embedder.embed("test");
      assert.equal(vec.length, 384);
    });
  });

  describe("embedBatch", () => {
    it("returns vectors for multiple texts", async () => {
      const vecs = await embedder.embedBatch(["text one", "text two", "text three"]);
      assert.equal(vecs.length, 3);
      for (const v of vecs) {
        assert.equal(v.length, 384);
      }
    });

    it("handles empty input", async () => {
      const vecs = await embedder.embedBatch([]);
      assert.equal(vecs.length, 0);
    });
  });

  describe("caching", () => {
    it("caches repeated embeddings", async () => {
      await embedder.embedQuery("same text");
      await embedder.embedQuery("same text");
      const stats = embedder.cacheStats;
      assert.ok(stats.hits >= 1);
    });

    it("reports cache stats", () => {
      const stats = embedder.cacheStats;
      assert.ok("size" in stats);
      assert.ok("hits" in stats);
      assert.ok("misses" in stats);
      assert.ok("hitRate" in stats);
    });
  });

  describe("test()", () => {
    it("returns success with correct dimensions", async () => {
      const result = await embedder.test();
      assert.equal(result.success, true);
      assert.equal(result.dimensions, 384);
    });
  });
});
