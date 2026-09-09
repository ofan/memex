/**
 * Regression guard for the 2026-09-07 ANN-index destruction.
 *
 * Invariant: opening a store must NEVER drop `vectors_vec`. A dimension
 * mismatch is a deliberate maintenance operation, not a startup side effect.
 * These tests reproduce the exact call pattern that destroyed production
 * (opening a real DB with a bogus `vectorDim`) and assert the data survives.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, loadSqliteVec } from "../src/db.js";
import { MemoryStore } from "../src/memory.js";
import { createStore, insertEmbedding } from "../src/search.js";
import {
  ensureVecTableOnOpen,
  inspectVecTable,
  needsMaintenance,
  dropAndRecreateVecTable,
  populateManifestFromCurrentState,
  readManifestSummary,
  pendingManifestKeys,
  reconcileManifestWithVecTable,
  assertVecShadowIntegrity,
  VectorSchemaMismatchError,
} from "../src/vec-table.js";

const DIM = 8;
const vec = (seed: number) => {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed + i);
  return Array.from(v);
};
const seedVec = (db: any, key: string, values: number[]) => {
  db.prepare("DELETE FROM vectors_vec WHERE hash_seq = ?").run(key);
  db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)")
    .run(key, new Float32Array(values));
};
const rowids = (db: any) =>
  (db.prepare("SELECT count(*) c FROM vectors_vec_rowids").get() as { c: number }).c;

describe("vec-table: open path never drops vectors_vec", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "vec-guard-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("creates the table when absent (nothing to lose)", () => {
    const db = openDatabase(join(dir, "fresh.sqlite"));
    loadSqliteVec(db);
    const res = ensureVecTableOnOpen(db, DIM);
    assert.equal(res.created, true);
    assert.equal(inspectVecTable(db, DIM).compatible, true);
    db.close();
  });

  it("is a no-op when dims match", () => {
    const db = openDatabase(join(dir, "fresh.sqlite"));
    loadSqliteVec(db);
    const res = ensureVecTableOnOpen(db, DIM);
    assert.equal(res.created, false);
    db.close();
  });

  it("throws on mismatch instead of dropping, and vectors survive", () => {
    const db = openDatabase(join(dir, "mismatch.sqlite"));
    loadSqliteVec(db);
    ensureVecTableOnOpen(db, DIM);
    seedVec(db, "mem_deadbeef", vec(1));
    const before = rowids(db);
    assert.equal(before, 1);

    assert.throws(
      () => ensureVecTableOnOpen(db, 4),
      (err: unknown) => err instanceof VectorSchemaMismatchError,
      "mismatched dims must refuse, never rebuild",
    );

    // The table and its contents are untouched by the refused call.
    assert.equal(rowids(db), before, "refused open must not delete vectors");
    assert.equal(inspectVecTable(db, DIM).dims, DIM, "schema must not be rewritten");
    db.close();
  });

  it("flags a real mismatch via needsMaintenance but not a compatible index", () => {
    const db = openDatabase(join(dir, "mismatch.sqlite"));
    loadSqliteVec(db);
    assert.equal(needsMaintenance(db, DIM), false);
    assert.equal(needsMaintenance(db, 4), true);
    assert.equal(assertVecShadowIntegrity(db).ok, true);
    db.close();
  });
});

describe("vec-table: MemoryStore construction (the production scenario)", () => {
  let dir: string;
  let dbPath: string;
  let ids: string[] = [];
  let seededRows = 0;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "memstore-guard-"));
    dbPath = join(dir, "memex.sqlite");
    const store = new MemoryStore({ dbPath, vectorDim: DIM });
    for (const [i, text] of [
      "Project uses a shared SQLite database for memories and documents",
      "The retriever fuses lexical and vector signals before reranking",
    ].entries()) {
      const e = await store.store({
        text, vector: vec(i + 1), category: "fact", scope: "global",
        importance: 0.8, metadata: "{}",
      } as any);
      ids.push(e.id);
      seedVec(store.db as any, `mem_${e.id}`, vec(i + 1));
    }
    seededRows = rowids((store as any).db);
    assert.ok(seededRows >= 2, "seed must produce vectors");
    await store.close();
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("rejects a bogus vectorDim without destroying existing vectors", () => {
    // This is the exact mistake that wiped the live ANN index.
    assert.throws(
      () => new MemoryStore({ dbPath, vectorDim: 4 }),
      (err: unknown) => err instanceof VectorSchemaMismatchError,
    );

    const store = new MemoryStore({ dbPath, vectorDim: DIM });
    try {
      assert.equal(rowids((store as any).db), seededRows, "vectors must survive a bad open");
    } finally { store.close(); }
  });

  it("still serves vector search afterwards", async () => {
    const store = new MemoryStore({ dbPath, vectorDim: DIM });
    try {
      const hits = await store.vectorSearch(vec(1), 5, 0.0);
      assert.ok(hits.length > 0, "vectorSearch must return the surviving vectors");
      assert.ok(hits.some(h => ids.includes(h.entry.id)), "seeded memory must be retrievable");
    } finally { await store.close(); }
  });
});

describe("vec-table: search-store ensureVecTable is non-destructive", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "qmd-guard-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  it("refuses a dimension change and keeps document vectors", () => {
    const store = createStore(join(dir, "qmd.sqlite"));
    store.ensureVecTable(DIM);
    insertEmbedding(store.db, "abc123", 0, 0, new Float32Array(vec(2)), "test-model", new Date().toISOString());
    const before = rowids(store.db);

    assert.throws(
      () => store.ensureVecTable(16),
      (err: unknown) => err instanceof VectorSchemaMismatchError,
    );
    assert.equal(rowids(store.db), before, "refused ensure must not delete document vectors");
    store.close();
  });
});

describe("vec-table: explicit maintenance path (backup + manifest + rebuild)", () => {
  let dir: string;
  before(async () => { dir = await mkdtemp(join(tmpdir(), "vec-maint-")); });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  /**
   * Mirror production: one file holding both the document store (whose schema
   * owns content_vectors, the document manifest) and the memory store sharing
   * the same handle. Each test gets its own file so failures never cascade.
   */
  async function fixture(name: string, dims = DIM) {
    const path = join(dir, `${name}.sqlite`);
    const qmd = createStore(path);
    const store = new MemoryStore({ dbPath: path, vectorDim: dims, db: qmd.db });
    const e = await store.store({
      text: "Deployment pins the gateway to the cluster ingress", vector: vec(3),
      category: "decision", scope: "global", importance: 0.9, metadata: "{}",
    } as any);
    seedVec(qmd.db as any, `mem_${e.id}`, vec(3));
    insertEmbedding(qmd.db as any, "hashdef", 0, 0, new Float32Array(vec(4)), "test-model", new Date().toISOString());
    return { qmd, store, path, memId: e.id };
  }

  it("refuses to drop without explicit confirmation", async () => {
    const { qmd, store } = await fixture("noconfirm");
    try {
      populateManifestFromCurrentState(store.db);
      assert.throws(
        () => dropAndRecreateVecTable(store.db, 16, false),
        /without explicit confirmation/,
      );
      assert.ok(rowids(store.db) >= 2, "refusal must leave vectors intact");
    } finally { qmd.close(); }
  });

  it("refuses to drop without a rebuild manifest", () => {
    const db = openDatabase(join(dir, "nomanifest.sqlite"));
    loadSqliteVec(db);
    ensureVecTableOnOpen(db, DIM);
    seedVec(db, "mem_orphan", vec(5));
    assert.throws(
      () => dropAndRecreateVecTable(db, 16, true),
      /no rebuild manifest/,
    );
    assert.equal(rowids(db), 1, "refusal must leave vectors intact");
    db.close();
  });

  it("backs up recoverable vectors, recreates at the new dim, and requeues the manifest", async () => {
    const { qmd, store, memId } = await fixture("rebuild");
    try {
      const seeded = rowids(store.db);
      assert.ok(seeded >= 2, `fixture must seed vectors, got ${seeded}`);

      const populated = populateManifestFromCurrentState(store.db);
      assert.ok(populated.total >= 2, "manifest must see both mem_ and doc_ keys");
      assert.ok(populated.mem >= 1 && populated.doc >= 1, `mem=${populated.mem} doc=${populated.doc}`);

      const res = dropAndRecreateVecTable(store.db, 16, true);
      assert.equal(res.createdDims, 16);
      assert.equal(inspectVecTable(store.db, 16).compatible, true);
      assert.equal(rowids(store.db), 0, "new index starts empty");

      const summary = readManifestSummary(store.db)!;
      assert.ok(summary && summary.total >= 2);
      assert.equal(summary.pending, summary.total, "everything must be requeued as pending");
      assert.ok(summary.mem >= 1 && summary.doc >= 1);

      const keys = pendingManifestKeys(store.db);
      assert.ok(keys.mem.includes(memId), "memory keys must be resumable");
      assert.ok(keys.doc.some(d => d.hash === "hashdef"), "document keys must be resumable");

      // The backup is the whole point: it must still answer an ANN query.
      assert.ok(statSync(res.backedUpTo).size > 0, "backup file must be non-empty");
      const backup = openDatabase(res.backedUpTo);
      loadSqliteVec(backup);
      try {
        assert.equal(rowids(backup), seeded, "backup must preserve vector count");
        const hits = backup.prepare(
          "SELECT hash_seq FROM vectors_vec WHERE embedding MATCH ? AND k = 1",
        ).all(new Float32Array(vec(3))) as { hash_seq: string }[];
        assert.equal(hits.length, 1, "backup vectors must be queryable");
        assert.ok(hits[0].hash_seq.startsWith("mem_"), `got ${hits[0].hash_seq}`);
      } finally { backup.close(); }

      // Re-inserting one vector must flip exactly that manifest key to embedded.
      seedVec(store.db, `mem_${memId}`, Array.from(new Float32Array(16).fill(0.1)));
      const rec = reconcileManifestWithVecTable(store.db);
      assert.equal(rec.embedded, 1, "only the restored key should be marked embedded");
      assert.ok(rec.missing >= 1, "unrestored keys stay pending");
    } finally { qmd.close(); }
  });
});
