/**
 * Plan Task 1: collections[] filter on searchFTS (whole-doc + section) and searchVec.
 * Verifies collection-scoped filtering without changing the no-filter default.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, searchFTS, insertContent, insertDocument } from "../src/search.js";

describe("searchFTS collections filter", () => {
  let dir: string, store: ReturnType<typeof createStore>;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "coll-fts-"));
    store = createStore(join(dir, "d.sqlite"));
    const now = new Date().toISOString();
    // Seed two collections, one doc each, distinct bodies sharing a common word.
    for (const [coll, body] of [["alpha", "alpha deploy flux common"], ["beta", "beta deploy helm common"]] as const) {
      insertContent(store.db, coll + "-h", body, now);
      insertDocument(store.db, coll, "d1", "T", coll + "-h", now, now);
    }
  });
  it("returns only docs in named collections", () => {
    const onlyA = searchFTS(store.db, "deploy common", 10, undefined, ["alpha"]);
    const onlyB = searchFTS(store.db, "deploy common", 10, undefined, ["beta"]);
    const both = searchFTS(store.db, "deploy common", 10, undefined, ["alpha", "beta"]);
    assert.ok(onlyA.length > 0 && onlyB.length > 0, "both collections have hits");
    assert.equal(both.length, onlyA.length + onlyB.length, "both = sum of singles");
    assert.ok(onlyA.every((r: any) => String(r.filepath).includes("/alpha/")), "alpha-only excludes beta");
    assert.ok(onlyB.every((r: any) => !String(r.filepath).includes("/alpha/")), "beta-only excludes alpha");
  });
  it("omitting collections keeps the no-filter default (returns all)", () => {
    const all = searchFTS(store.db, "deploy common", 10);
    assert.ok(all.length >= 2, "no filter returns both collections");
  });
  after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
});
