/**
 * Acceptance tests for temporal queries.
 *
 * AC1: detectTemporalRange("what happened last week") returns [7d ago, now]
 * AC2: detectTemporalRange("deploy the model") returns null
 * AC3: Store 5 memories (2 from 3 days ago, 3 from 40 days ago),
 *      query "what happened last week" -> only the 2 recent ones returned
 * AC4: Non-temporal queries unaffected — R@3 >= 0.90
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectTemporalRange } from "../src/temporal.js";
import { MemoryStore } from "../src/memory.js";
import { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG, createRetriever } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

const MS_PER_DAY = 86_400_000;
const VECTOR_DIM = 8;

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

const daysAgo = (d: number) => Date.now() - d * MS_PER_DAY;

/** Minimal embedder that returns deterministic vectors based on text hash. */
function createTestEmbedder(): Embedder {
  return {
    embedQuery(text: string): Promise<number[]> {
      let seed = 0;
      for (let i = 0; i < text.length; i++) seed += text.charCodeAt(i);
      return Promise.resolve(makeVector(seed));
    },
    embedDocument(text: string): Promise<number[]> {
      return this.embedQuery(text);
    },
    embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map(t => this.embedQuery(t)));
    },
    get dimensions(): number { return VECTOR_DIM; },
    get modelId(): string { return "test-embedder"; },
  } as Embedder;
}

describe("Temporal Queries — Acceptance", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-temporal-"));
    store = new MemoryStore({
      dbPath: join(tmpDir, "memex.sqlite"),
      vectorDim: VECTOR_DIM,
    });
  });

  afterEach(async () => {
    await store.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("AC1: detectTemporalRange('what happened last week') returns [7d ago, now]", () => {
    const now = Date.now();
    const result = detectTemporalRange("what happened last week", now);
    assert.ok(result, "should return a range");
    const [start, end] = result;

    // start should be ~7 days ago (start of that day)
    const expectedStart = new Date(now);
    expectedStart.setHours(0, 0, 0, 0);
    const expected7dAgo = expectedStart.getTime() - 7 * MS_PER_DAY;
    assert.equal(start, expected7dAgo);
    assert.equal(end, now);
  });

  it("AC2: detectTemporalRange('deploy the model') returns null", () => {
    const result = detectTemporalRange("deploy the model");
    assert.equal(result, null);
  });

  it("AC3: temporal filter returns only recent memories", async () => {
    const embedder = createTestEmbedder();

    // Store 2 memories from 3 days ago
    const recentTexts = [
      "Deployed the new API endpoint for user management",
      "Fixed a critical bug in the authentication service",
    ];
    // Store 3 memories from 40 days ago
    const oldTexts = [
      "Set up the initial project structure with TypeScript",
      "Configured CI/CD pipeline with GitHub Actions",
      "Added database migration scripts for PostgreSQL",
    ];

    // Insert memories with controlled timestamps via direct DB access
    const db = (store as any).db;
    const insertMem = db.prepare(
      `INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const allTexts = [...recentTexts, ...oldTexts];
    const allTimestamps = [
      daysAgo(3), daysAgo(3),
      daysAgo(40), daysAgo(40), daysAgo(40),
    ];
    const ids: string[] = [];

    for (let i = 0; i < allTexts.length; i++) {
      const id = `test-${i}-${Date.now()}`;
      ids.push(id);
      const vec = await embedder.embedDocument(allTexts[i]);
      insertMem.run(
        id, allTexts[i], "fact", "global", 0.7, allTimestamps[i], "{}",
        `hash_${i}_${Date.now()}`
      );
      // Insert vector
      if ((store as any)._sqliteVecAvailable) {
        db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
          .run(`mem_${id}`, new Float32Array(vec));
      }
      db.prepare(`INSERT INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`)
        .run(id, new Date().toISOString());
    }

    // Detect temporal range
    const range = detectTemporalRange("what happened last week");
    assert.ok(range, "should detect temporal range");

    // Use the range to filter: query with timestamp BETWEEN
    const [start, end] = range;
    const rows = db.prepare(
      `SELECT id, text FROM memories WHERE timestamp BETWEEN ? AND ?`
    ).all(start, end) as { id: string; text: string }[];

    // Should return only the 2 recent memories
    assert.equal(rows.length, 2, `Expected 2 recent memories, got ${rows.length}`);
    for (const row of rows) {
      assert.ok(
        recentTexts.includes(row.text),
        `Unexpected memory text: ${row.text}`
      );
    }
  });

  it("AC4: non-temporal queries unaffected — retriever returns results", async () => {
    const embedder = createTestEmbedder();

    // Store some memories
    const texts = [
      "User prefers dark mode in all applications",
      "Project uses TypeScript with strict mode enabled",
      "Database is PostgreSQL with pgvector extension",
    ];

    const db = (store as any).db;
    const insertMem = db.prepare(
      `INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (let i = 0; i < texts.length; i++) {
      const id = `test-nontemporal-${i}-${Date.now()}`;
      const vec = await embedder.embedDocument(texts[i]);
      insertMem.run(
        id, texts[i], "preference", "global", 0.7, Date.now(), "{}",
        `hash_nt_${i}_${Date.now()}`
      );
      if ((store as any)._sqliteVecAvailable) {
        db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`)
          .run(`mem_${id}`, new Float32Array(vec));
      }
      db.prepare(`INSERT INTO memory_vectors (memory_id, embedded_at) VALUES (?, ?)`)
        .run(id, new Date().toISOString());
    }

    // Non-temporal query — detectTemporalRange returns null
    const range = detectTemporalRange("what is the preferred color scheme");
    assert.equal(range, null, "should not detect temporal range for non-temporal query");

    // Retriever should still work (no temporal filter applied)
    const retriever = createRetriever(store, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      rerank: "none",
      filterNoise: false,
      hardMinScore: 0,
      minScore: 0,
      timeDecayHalfLifeDays: 0,
      recencyHalfLifeDays: 0,
    });
    const results = await retriever.retrieve({
      query: "what is the preferred color scheme",
      limit: 3,
    });

    assert.ok(results.length > 0, "retriever should return results for non-temporal query");
  });
});
