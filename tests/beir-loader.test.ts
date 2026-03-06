import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BEIR_DATASETS, loadBeirDataset } from "./helpers/beir-loader.ts";

describe("BEIR dataset loader", () => {
  it("lists available datasets", () => {
    assert.deepStrictEqual([...BEIR_DATASETS], ["fiqa", "nq", "scifact"]);
  });

  it("loads fiqa with maxQueries=5, maxCorpus=100", async () => {
    const ds = await loadBeirDataset("fiqa", { maxQueries: 5, maxCorpus: 100 });

    assert.equal(ds.name, "fiqa");

    // Queries
    assert.equal(ds.queries.length, 5);
    for (const q of ds.queries) {
      assert.ok(q.id, "query must have id");
      assert.ok(typeof q.text === "string" && q.text.length > 0, "query must have non-empty text");
    }

    // Corpus
    assert.equal(ds.corpus.length, 100);
    for (const doc of ds.corpus) {
      assert.ok(doc.id, "doc must have id");
      assert.ok(typeof doc.title === "string", "doc title must be a string (can be empty)");
      assert.ok(typeof doc.text === "string" && doc.text.length > 0, "doc must have non-empty text");
    }

    // Qrels
    assert.ok(ds.qrels instanceof Map, "qrels must be a Map");
    assert.ok(ds.qrels.size > 0, "qrels must have entries");
    for (const [qid, rels] of ds.qrels) {
      assert.ok(typeof qid === "string", "qrel query id must be string");
      assert.ok(rels instanceof Map, "qrel relevance judgments must be a Map");
      for (const [docId, score] of rels) {
        assert.ok(typeof docId === "string", "qrel doc id must be string");
        assert.ok(typeof score === "number", "qrel score must be number");
      }
    }

    // Each returned query has at least one relevance judgment
    for (const q of ds.queries) {
      const rels = ds.qrels.get(q.id);
      assert.ok(rels && rels.size > 0, `query ${q.id} must have at least one relevance judgment`);
    }
  });

  it("caches files for subsequent calls", async () => {
    const start = Date.now();
    // Second call should be fast (cached)
    const ds = await loadBeirDataset("fiqa", { maxQueries: 2, maxCorpus: 10 });
    const elapsed = Date.now() - start;
    assert.equal(ds.queries.length, 2);
    assert.equal(ds.corpus.length, 10);
    // Cached load should be fast (no network), but be generous for CI
    assert.ok(elapsed < 10000, `cached load took ${elapsed}ms, expected < 10s`);
  });
});
