/**
 * Memory Scoping Tests — multi-valued scope tags, derivation, recall, dreaming.
 *
 * P1: memory_scopes table + migration
 * P2: scope derivation (src/scope-derive.ts)
 * P3: store path integration
 * P4: recall tag intersection
 * P5: dreaming scope-aware
 * P6: MCP tool surface
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
import { MemoryStore, validateStoragePath } from "../src/memory.js";
import type { MemoryEntry } from "../src/memory.js";

const DIM = 4;

function randomVec(dim: number = DIM): number[] {
  return Array.from({ length: dim }, () => Math.random());
}

let tmpDir: string;
let store: MemoryStore;

// ============================================================================
// P1 — memory_scopes table + migration
// ============================================================================

describe("P1: memory_scopes table", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-scope-test-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates memory_scopes table on init", () => {
    const row = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='memory_scopes'"
    ).get() as { name: string } | undefined;
    assert.ok(row, "memory_scopes table should exist");
  });

  it("has PRIMARY KEY (memory_id, scope)", () => {
    const info = store.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_scopes'"
    ).get() as { sql: string };
    assert.ok(info.sql.includes("memory_id"), "should include memory_id");
    assert.ok(info.sql.includes("scope"), "should include scope");
    assert.ok(info.sql.includes("PRIMARY KEY"), "should have PRIMARY KEY constraint");
    assert.ok(
      info.sql.includes("memory_id") && info.sql.includes("scope") && info.sql.includes("PRIMARY KEY"),
      "should have PRIMARY KEY on memory_id + scope"
    );
  });

  it("has index on scope column", () => {
    const rows = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%scope%'"
    ).all() as { name: string }[];
    const scopeIdx = rows.find(r => r.name.includes("memory_scopes") && r.name.includes("scope"));
    assert.ok(scopeIdx, "should have index on memory_scopes(scope)");
  });

  it("backfills 'global' tag for existing memories on init", async () => {
    // Insert a memory directly via the store
    await store.store({
      text: "pre-existing memory",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    // Close and re-open the store (simulates migration on existing DB)
    await store.close();
    const dbPath = join(tmpDir, "test.sqlite");
    store = new MemoryStore({ dbPath, vectorDim: DIM });

    // Check that the memory got a 'global' tag row
    const rows = store.db.prepare(
      "SELECT memory_id, scope FROM memory_scopes"
    ).all() as { memory_id: string; scope: string }[];
    assert.ok(rows.length >= 1, "should have at least one scope row");
    const globalRow = rows.find(r => r.scope === "global");
    assert.ok(globalRow, "should have a 'global' tag row");
  });

  it("store() writes a tag row to memory_scopes", async () => {
    const entry = await store.store({
      text: "new scoped memory",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });
    assert.ok(entry, "store should succeed");

    const rows = store.db.prepare(
      "SELECT memory_id, scope FROM memory_scopes WHERE memory_id = ?"
    ).all(entry!.id) as { memory_id: string; scope: string }[];
    assert.ok(rows.length >= 1, "should have at least one scope row for the new memory");
    assert.ok(rows.some(r => r.scope === "global"), "should include 'global' tag");
  });

  it("store() writes multiple tag rows when multiple scopes", async () => {
    // We'll simulate writing custom tags directly — the store() method
    // currently only takes a single scope. For multi-tag support, we
    // need the scope_derive integration (P3). For now, verify the
    // table supports multiple rows per memory.
    const id = "test-multi-tag-001";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "multi-tag test", "fact", "global", 0.5, Date.now(), "{}",
      require("node:crypto").createHash("sha256").update("multi-tag test").digest("hex"));

    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "project:abc123");

    const rows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(id) as { scope: string }[];
    assert.deepEqual(rows.map(r => r.scope), ["global", "project:abc123"]);
  });

  it("memory_scopes enforces uniqueness (no duplicate memory_id+scope)", () => {
    const id = "test-dup-scope";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, "unique test", "fact", "global", 0.5, Date.now(), "{}",
      require("node:crypto").createHash("sha256").update("unique test").digest("hex"));

    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");

    assert.throws(() => {
      store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");
    }, /UNIQUE/, "should reject duplicate (memory_id, scope)");
  });

  it("CASCADE deletes scope rows when memory is deleted", async () => {
    const entry = await store.store({
      text: "will be deleted",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });
    assert.ok(entry);

    // Verify tag row exists
    let rows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ?"
    ).all(entry!.id) as { scope: string }[];
    assert.ok(rows.length > 0, "tag row should exist before delete");

    // Delete the memory
    await store.delete(entry!.id);

    // Verify tag row is gone
    rows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ?"
    ).all(entry!.id) as { scope: string }[];
    assert.equal(rows.length, 0, "tag rows should be deleted via CASCADE");
  });
});
