/**
 * Plan Task 2: upsertDocument / forgetDocument with vector cleanup (B7).
 * Verifies idempotent upsert by (collection, docId), old-vector cleanup on
 * re-push with edited text, and full cleanup on forget.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, insertEmbedding } from "../src/search.js";
import { upsertDocument, forgetDocument } from "../src/doc-indexer.js";

const vec = (n: number) => { const v = new Float32Array(8); for (let i = 0; i < 8; i++) v[i] = Math.sin(n + i); return v; };

describe("upsertDocument / forgetDocument (B7)", () => {
  let dir: string, store: any;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "upsert-"));
    store = createStore(join(dir, "d.sqlite"));
    store.ensureVecTable(8);
  });
  it("upserts by (collection, docId) and is idempotent", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d1", text: "hello world foo", title: "D1" });
    await upsertDocument(store.db, { collection: "proj", docId: "d1", text: "hello world foo", title: "D1" });
    const c = (store.db.prepare("SELECT count(*) c FROM documents WHERE collection=? AND path=?").get("proj", "d1") as any).c;
    assert.equal(c, 1, "re-push replaces via ON CONFLICT, not duplicates");
  });
  it("re-push with edited text removes OLD-hash vectors (B7)", async () => {
    // v1 upsert + seed its embedding under v1's hash
    await upsertDocument(store.db, { collection: "proj", docId: "d2", text: "version one content here", title: "D2" });
    const v1Hash = (store.db.prepare("SELECT hash FROM documents WHERE collection=? AND path=?").get("proj", "d2") as any).hash;
    insertEmbedding(store.db, v1Hash, 0, 0, vec(1), "test", new Date().toISOString());
    assert.equal((store.db.prepare("SELECT count(*) c FROM content_vectors WHERE hash=?").get(v1Hash) as any).c, 1, "v1 vector seeded");
    // re-push with different text → new hash
    await upsertDocument(store.db, { collection: "proj", docId: "d2", text: "version two totally different words now", title: "D2" });
    // B7: the OLD hash's vectors must be gone (cleanupOrphanedVectors ran inside upsert)
    const leftoverCV = (store.db.prepare("SELECT count(*) c FROM content_vectors WHERE hash=?").get(v1Hash) as any).c;
    assert.equal(leftoverCV, 0, "old-hash content_vectors removed (B7)");
    const leftoverVV = (store.db.prepare("SELECT count(*) c FROM vectors_vec WHERE hash_seq LIKE ?").get(v1Hash + "_%") as any).c;
    assert.equal(leftoverVV, 0, "old-hash vectors_vec removed (B7)");
  });
  it("forget removes doc + sections + vectors", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d3", text: "to be deleted now", title: "D3" });
    forgetDocument(store.db, "proj", "d3");
    const c = (store.db.prepare("SELECT count(*) c FROM documents WHERE collection=? AND path=?").get("proj", "d3") as any).c;
    assert.equal(c, 0, "document gone");
  });
  after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
});
