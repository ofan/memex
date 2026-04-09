import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateBeirQuery, summarizeBeirQueries } from "./helpers/beir-eval.js";

const EPS = 1e-9;

describe("BEIR eval helper", () => {
  it("computes per-query graded IR metrics from qrels", () => {
    const qrels = new Map<string, number>([
      ["d1", 3],
      ["d2", 2],
      ["d3", 1],
    ]);

    const metrics = evaluateBeirQuery("q1", qrels, ["d2", "dx", "d1", "d3"], [1, 3, 10]);

    assert.equal(metrics.queryId, "q1");
    assert.ok(Math.abs(metrics.mrr - 1.0) < EPS);
    assert.ok(Math.abs(metrics.recall[1] - (1 / 3)) < EPS);
    assert.ok(Math.abs(metrics.recall[3] - (2 / 3)) < EPS);
    assert.ok(Math.abs(metrics.recall[10] - 1.0) < EPS);
    assert.ok(metrics.ndcgAt10 > 0);
    assert.ok(metrics.ndcgAt10 < 1.0);
  });

  it("aggregates macro-average metrics across queries", () => {
    const summary = summarizeBeirQueries([
      {
        queryId: "q1",
        mrr: 1.0,
        ndcgAt10: 0.8,
        recall: { 5: 1.0, 10: 1.0 },
      },
      {
        queryId: "q2",
        mrr: 0.5,
        ndcgAt10: 0.4,
        recall: { 5: 0.5, 10: 1.0 },
      },
    ]);

    assert.equal(summary.queryCount, 2);
    assert.ok(Math.abs(summary.mrr - 0.75) < EPS);
    assert.ok(Math.abs(summary.ndcgAt10 - 0.6) < EPS);
    assert.ok(Math.abs(summary.recallAt[5] - 0.75) < EPS);
    assert.ok(Math.abs(summary.recallAt[10] - 1.0) < EPS);
  });
});
