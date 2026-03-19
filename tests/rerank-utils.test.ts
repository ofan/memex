/**
 * Tests for buildRerankRequest() and parseRerankResponse() (from src/retriever.ts)
 *
 * Pure functions — no network, no mocks needed.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRerankRequest, parseRerankResponse } from "../src/retriever.js";
import type { RerankProvider } from "../src/retriever.js";

const QUERY = "dark mode settings";
const DOCS = ["User prefers dark mode", "Deploy to AWS", "Use PostgreSQL 15"];
const API_KEY = "test-key-123";
const MODEL = "bge-reranker-v2-m3";

describe("buildRerankRequest", () => {
  describe("jina provider", () => {
    it("uses Bearer auth and top_n", () => {
      const { headers, body } = buildRerankRequest("jina", API_KEY, MODEL, QUERY, DOCS, 3);
      assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
      assert.equal(headers["Content-Type"], "application/json");
      assert.equal(body.model, MODEL);
      assert.equal(body.query, QUERY);
      assert.deepEqual(body.documents, DOCS);
      assert.equal(body.top_n, 3);
      assert.equal(body.top_k, undefined);
    });
  });

  describe("siliconflow provider", () => {
    it("uses same format as jina (Bearer + top_n)", () => {
      const { headers, body } = buildRerankRequest("siliconflow", API_KEY, MODEL, QUERY, DOCS, 2);
      assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
      assert.equal(body.top_n, 2);
      assert.deepEqual(body.documents, DOCS);
    });
  });

  describe("voyage provider", () => {
    it("uses Bearer auth and top_k (not top_n)", () => {
      const { headers, body } = buildRerankRequest("voyage", API_KEY, MODEL, QUERY, DOCS, 5);
      assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
      assert.equal(body.top_k, 5);
      assert.equal(body.top_n, undefined);
      assert.deepEqual(body.documents, DOCS);
    });
  });

  describe("pinecone provider", () => {
    it("uses Api-Key header and wraps documents as objects", () => {
      const { headers, body } = buildRerankRequest("pinecone", API_KEY, MODEL, QUERY, DOCS, 3);
      assert.equal(headers["Api-Key"], API_KEY);
      assert.equal(headers["X-Pinecone-API-Version"], "2024-10");
      assert.equal(headers["Authorization"], undefined);
      assert.equal(body.top_n, 3);
      assert.deepEqual(body.documents, [
        { text: "User prefers dark mode" },
        { text: "Deploy to AWS" },
        { text: "Use PostgreSQL 15" },
      ]);
      assert.deepEqual(body.rank_fields, ["text"]);
    });
  });
});

describe("parseRerankResponse", () => {
  describe("jina/siliconflow provider", () => {
    it("parses results[] with relevance_score", () => {
      const data = {
        results: [
          { index: 0, relevance_score: 0.95 },
          { index: 2, relevance_score: 0.72 },
        ],
      };
      const items = parseRerankResponse("jina", data);
      assert.ok(items);
      assert.equal(items.length, 2);
      assert.deepEqual(items[0], { index: 0, score: 0.95 });
      assert.deepEqual(items[1], { index: 2, score: 0.72 });
    });

    it("also accepts data[] fallback", () => {
      const data = {
        data: [
          { index: 1, relevance_score: 0.88 },
        ],
      };
      const items = parseRerankResponse("siliconflow", data);
      assert.ok(items);
      assert.equal(items.length, 1);
      assert.equal(items[0].index, 1);
      assert.equal(items[0].score, 0.88);
    });

    it("prefers results[] over data[]", () => {
      const data = {
        results: [{ index: 0, relevance_score: 0.9 }],
        data: [{ index: 1, relevance_score: 0.5 }],
      };
      const items = parseRerankResponse("jina", data);
      assert.ok(items);
      assert.equal(items.length, 1);
      assert.equal(items[0].index, 0);
    });
  });

  describe("pinecone provider", () => {
    it("parses data[] with score", () => {
      const data = {
        data: [
          { index: 0, score: 0.91 },
          { index: 1, score: 0.65 },
        ],
      };
      const items = parseRerankResponse("pinecone", data);
      assert.ok(items);
      assert.equal(items.length, 2);
      assert.deepEqual(items[0], { index: 0, score: 0.91 });
    });

    it("also accepts results[] fallback", () => {
      const data = {
        results: [{ index: 2, score: 0.77 }],
      };
      const items = parseRerankResponse("pinecone", data);
      assert.ok(items);
      assert.equal(items[0].index, 2);
    });
  });

  describe("voyage provider", () => {
    it("parses data[] with relevance_score", () => {
      const data = {
        data: [
          { index: 0, relevance_score: 0.93 },
          { index: 1, relevance_score: 0.41 },
        ],
      };
      const items = parseRerankResponse("voyage", data);
      assert.ok(items);
      assert.equal(items.length, 2);
      assert.equal(items[0].score, 0.93);
    });

    it("also accepts score key", () => {
      const data = {
        data: [{ index: 0, score: 0.85 }],
      };
      const items = parseRerankResponse("voyage", data);
      assert.ok(items);
      assert.equal(items[0].score, 0.85);
    });
  });

  describe("edge cases", () => {
    it("returns null for empty results", () => {
      assert.equal(parseRerankResponse("jina", { results: [] }), null);
    });

    it("returns null for missing results/data", () => {
      assert.equal(parseRerankResponse("jina", {}), null);
    });

    it("skips items with non-numeric index", () => {
      const data = {
        results: [
          { index: "abc", relevance_score: 0.5 },
          { index: 1, relevance_score: 0.8 },
        ],
      };
      const items = parseRerankResponse("jina", data);
      assert.ok(items);
      assert.equal(items.length, 1);
      assert.equal(items[0].index, 1);
    });

    it("skips items with missing score", () => {
      const data = {
        results: [
          { index: 0 },
          { index: 1, relevance_score: 0.7 },
        ],
      };
      const items = parseRerankResponse("jina", data);
      assert.ok(items);
      assert.equal(items.length, 1);
    });

    it("coerces string scores to numbers", () => {
      const data = {
        results: [{ index: 0, relevance_score: "0.85" }],
      };
      const items = parseRerankResponse("jina", data);
      assert.ok(items);
      assert.equal(items[0].score, 0.85);
    });
  });
});
