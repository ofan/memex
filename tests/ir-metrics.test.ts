import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { recallAtK, precisionAtK, mrr, ndcgAtK } from "./helpers/ir-metrics.js";

const EPS = 1e-9;

describe("IR metrics", () => {
  describe("recallAtK", () => {
    it("recall@5 = 1.0 when all relevant in top 5", () => {
      const relevant = ["a", "b", "c"];
      const results = ["a", "x", "b", "y", "c", "z"];
      assert.strictEqual(recallAtK(relevant, results, 5), 1.0);
    });

    it("recall@3 = 0.5 when 1 of 2 relevant in top 3", () => {
      const relevant = ["a", "b"];
      const results = ["x", "a", "y", "b"];
      assert.ok(Math.abs(recallAtK(relevant, results, 3) - 0.5) < EPS);
    });

    it("recall@k = 0 when no relevant returned", () => {
      const relevant = ["a", "b"];
      const results = ["x", "y", "z"];
      assert.strictEqual(recallAtK(relevant, results, 3), 0);
    });
  });

  describe("precisionAtK", () => {
    it("precision@3 = 2/3 when 2 of 3 results relevant", () => {
      const relevant = ["a", "b", "c"];
      const results = ["a", "x", "b"];
      assert.ok(Math.abs(precisionAtK(relevant, results, 3) - 2 / 3) < EPS);
    });
  });

  describe("mrr", () => {
    it("mrr = 0.5 when first relevant at rank 2", () => {
      const relevant = ["a"];
      const results = ["x", "a", "y"];
      assert.ok(Math.abs(mrr(relevant, results) - 0.5) < EPS);
    });

    it("mrr = 1.0 when first relevant at rank 1", () => {
      const relevant = ["a", "b"];
      const results = ["a", "b", "x"];
      assert.strictEqual(mrr(relevant, results), 1.0);
    });

    it("mrr = 0 when no relevant found", () => {
      const relevant = ["a"];
      const results = ["x", "y", "z"];
      assert.strictEqual(mrr(relevant, results), 0);
    });
  });

  describe("ndcgAtK", () => {
    it("ndcg@3 perfect ranking = 1.0", () => {
      // Items with graded relevance: a=3, b=2, c=1
      // Perfect order: a, b, c
      const relevanceMap = new Map([["a", 3], ["b", 2], ["c", 1]]);
      const results = ["a", "b", "c"];
      assert.ok(Math.abs(ndcgAtK(relevanceMap, results, 3) - 1.0) < EPS);
    });

    it("ndcg@3 imperfect ranking < 1.0", () => {
      // Perfect order would be a, b, c but we return c, b, a
      const relevanceMap = new Map([["a", 3], ["b", 2], ["c", 1]]);
      const results = ["c", "b", "a"];
      const score = ndcgAtK(relevanceMap, results, 3);
      assert.ok(score < 1.0, `expected < 1.0, got ${score}`);
      assert.ok(score > 0, `expected > 0, got ${score}`);
    });

    it("ndcg@k = 0 when all irrelevant", () => {
      const relevanceMap = new Map([["a", 3], ["b", 2]]);
      const results = ["x", "y", "z"];
      assert.strictEqual(ndcgAtK(relevanceMap, results, 3), 0);
    });
  });
});
