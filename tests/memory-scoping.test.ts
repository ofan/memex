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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir, hostname } from "node:os";
import { execSync } from "node:child_process";
import { MemoryStore, validateStoragePath } from "../src/memory.js";
import { deriveScopes, normalizeGitRemote, hashValue } from "../src/scope-derive.js";
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

// ============================================================================
// P2 — Scope derivation (src/scope-derive.ts)
// ============================================================================

describe("P2: hashValue", () => {
  it("returns 16-char hex string", () => {
    const h = hashValue("hello");
    assert.equal(h.length, 16);
    assert.ok(/^[0-9a-f]{16}$/.test(h));
  });

  it("is deterministic", () => {
    assert.equal(hashValue("test"), hashValue("test"));
  });

  it("produces different hashes for different inputs", () => {
    assert.notEqual(hashValue("a"), hashValue("b"));
  });
});

describe("P2: normalizeGitRemote", () => {
  it("strips trailing .git", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/user/repo.git"),
      "https://github.com/user/repo"
    );
  });

  it("converts SSH form to HTTPS", () => {
    assert.equal(
      normalizeGitRemote("git@github.com:user/repo.git"),
      "https://github.com/user/repo"
    );
  });

  it("lowercases hostname", () => {
    assert.equal(
      normalizeGitRemote("https://GitHub.COM/User/Repo"),
      "https://github.com/User/Repo"
    );
  });

  it("already normalized remote is unchanged", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/user/repo"),
      "https://github.com/user/repo"
    );
  });

  it("handles empty string", () => {
    assert.equal(normalizeGitRemote(""), "");
  });
});

describe("P2: deriveScopes", () => {
  let gitDir: string;

  function initGit(remote?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "scope-test-git-"));
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
    writeFileSync(join(dir, "README.md"), "# test");
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
    if (remote) {
      execSync(`git remote add origin ${remote}`, { cwd: dir, stdio: "pipe" });
    }
    return dir;
  }

  it("returns global tag always", () => {
    const result = deriveScopes({ cwd: tmpdir() });
    assert.ok(result.tags.includes("global"), "global tag should always be present");
  });

  it("derives project tag from git remote", () => {
    const dir = initGit("https://github.com/myorg/myrepo.git");
    try {
      const result = deriveScopes({ cwd: dir });
      assert.ok(result.tags.includes("global"));
      const projectTag = result.tags.find(t => t.startsWith("project:"));
      assert.ok(projectTag, "should have project tag");
      const normalizedRemote = normalizeGitRemote("https://github.com/myorg/myrepo.git");
      const expectedHash = hashValue(normalizedRemote);
      assert.equal(projectTag, `project:${expectedHash}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses CLAUDE_PROJECT_DIR for cwd when set", () => {
    const dir = initGit("https://github.com/other/proj.git");
    try {
      const result = deriveScopes({
        cwd: "/some/random/path/not/git",
        env: { CLAUDE_PROJECT_DIR: dir },
      });
      assert.ok(result.tags.includes("global"));
      const projectTag = result.tags.find(t => t.startsWith("project:"));
      assert.ok(projectTag, "should derive project from CLAUDE_PROJECT_DIR");
      const expectedHash = hashValue(normalizeGitRemote("https://github.com/other/proj.git"));
      assert.equal(projectTag, `project:${expectedHash}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to local-path hash when no git remote", () => {
    const dir = initGit();
    try {
      const result = deriveScopes({ cwd: dir });
      assert.ok(result.tags.includes("global"));
      const projectTag = result.tags.find(t => t.startsWith("project:"));
      assert.ok(projectTag, "should have project tag even without remote");
      const expectedHash = hashValue(dir);
      assert.equal(projectTag, `project:${expectedHash}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to cwd hash when not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "scope-non-git-"));
    try {
      const result = deriveScopes({ cwd: dir });
      assert.ok(result.tags.includes("global"));
      const projectTag = result.tags.find(t => t.startsWith("project:"));
      assert.ok(projectTag, "should have project tag from cwd hash");
      const expectedHash = hashValue(dir);
      assert.equal(projectTag, `project:${expectedHash}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits project tag when no signal at all", () => {
    const result = deriveScopes({ cwd: "/nonexistent/path/12345" });
    assert.deepEqual(result.tags, ["global"], "should only have global when no signal");
  });

  it("includes client tag when clientName provided", () => {
    const result = deriveScopes({ cwd: tmpdir(), clientName: "claude-code" });
    assert.ok(result.tags.includes("client:claude-code"));
  });

  it("includes agent tag when explicit agentId provided", () => {
    const result = deriveScopes({
      cwd: tmpdir(),
      explicit: { agent: "dev-assistant" },
    });
    assert.ok(result.tags.includes("agent:dev-assistant"));
  });

  it("includes session tag when sessionId provided", () => {
    const result = deriveScopes({
      cwd: tmpdir(),
      sessionId: "my-session-123",
    });
    const sessionTag = result.tags.find(t => t.startsWith("session:"));
    assert.ok(sessionTag, "should include session tag");
    assert.ok(sessionTag!.includes("my-session-123"), "session tag should include session id");
  });

  it("session tag includes client name hash prefix", () => {
    const result = deriveScopes({
      cwd: tmpdir(),
      clientName: "claude-code",
      sessionId: "my-session",
    });
    const sessionTag = result.tags.find(t => t.startsWith("session:"));
    assert.ok(sessionTag, "should include session tag");
    const parts = sessionTag!.split(":");
    assert.equal(parts.length, 3, "session tag should have 3 parts (session:hash:id)");
    assert.equal(parts[0], "session");
    assert.equal(parts[1].length, 8, "first part should be 8-char hash");
  });

  it("device info is in metadata only, never in tags", () => {
    const result = deriveScopes({ cwd: tmpdir() });
    const deviceTag = result.tags.find(t => t.startsWith("device:"));
    assert.equal(deviceTag, undefined, "device must not appear in tags");
    assert.ok(result.metadata.device_id, "device_id should be in metadata");
    assert.ok(typeof result.metadata.device_id === "string");
    assert.ok(result.metadata.device_id.length > 0);
  });

  it("metadata includes project_root hash when in git repo", () => {
    const dir = initGit("https://github.com/test/repo.git");
    try {
      const result = deriveScopes({ cwd: dir });
      assert.ok(result.metadata.project_root, "project_root should be in metadata");
      assert.equal(result.metadata.project_root, hashValue(dir), "project_root should be hashed path");
      assert.ok(result.metadata.git_remote, "git_remote should be in metadata");
      assert.equal(
        result.metadata.git_remote,
        normalizeGitRemote("https://github.com/test/repo.git")
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("metadata includes cwd_hash", () => {
    const result = deriveScopes({ cwd: "/some/path" });
    assert.equal(result.metadata.cwd_hash, hashValue("/some/path"));
  });

  it("metadata includes captured_at timestamp", () => {
    const before = Date.now();
    const result = deriveScopes({ cwd: tmpdir() });
    assert.ok(result.metadata.captured_at >= before);
    assert.ok(result.metadata.captured_at <= Date.now());
  });

  it("metadata includes client name when provided", () => {
    const result = deriveScopes({ cwd: tmpdir(), clientName: "test-client" });
    assert.equal(result.metadata.client, "test-client");
  });

  it("explicit client tag overrides implicit clientName", () => {
    const result = deriveScopes({
      cwd: tmpdir(),
      clientName: "implicit-client",
      explicit: { client: "explicit-client" },
    });
    const clientTags = result.tags.filter(t => t.startsWith("client:"));
    assert.equal(clientTags.length, 1, "should have exactly one client tag");
    assert.equal(clientTags[0], "client:explicit-client");
  });

  it("raw paths are never stored in metadata", () => {
    const dir = initGit("https://github.com/test/repo.git");
    try {
      const result = deriveScopes({ cwd: dir });
      const metaStr = JSON.stringify(result.metadata);
      assert.ok(!metaStr.includes(dir), "raw path should not appear in metadata");
      assert.ok(/^[0-9a-f]{16}$/.test(result.metadata.project_root || ""), "project_root should be hash");
      assert.ok(/^[0-9a-f]{16}$/.test(result.metadata.cwd_hash || ""), "cwd_hash should be hash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// P3 — Store path integration
// ============================================================================

describe("P3: store with scopes", () => {
  let store3: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-p3-test-"));
    store3 = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await store3.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store() accepts scopes array and writes multiple memory_scopes rows", async () => {
    const derivResult = deriveScopes({ cwd: tmpdir() });
    const tags = [...derivResult.tags, "client:test-client"];

    const entry = await store3.store({
      text: "multi-scope memory",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: tags,
    });

    assert.ok(entry, "store should succeed");
    const rows = store3.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entry!.id) as { scope: string }[];

    const storedScopes = rows.map(r => r.scope);
    assert.ok(storedScopes.includes("global"), "should include global");
    assert.ok(storedScopes.includes("client:test-client"), "should include client tag");
    const projectTag = storedScopes.find(s => s.startsWith("project:"));
    assert.ok(projectTag, "should include project tag");
  });

  it("store() captures provenance metadata from deriveScopes", async () => {
    const derivResult = deriveScopes({ cwd: tmpdir(), clientName: "test-client" });

    const entry = await store3.store({
      text: "provenance memory",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: derivResult.tags,
      metadata: JSON.stringify(derivResult.metadata),
    });

    assert.ok(entry, "store should succeed");
    const meta = JSON.parse(entry!.metadata || "{}");
    assert.ok(meta.cwd_hash, "cwd_hash should be in metadata");
    assert.ok(meta.device_id, "device_id should be in metadata");
    assert.ok(meta.captured_at, "captured_at should be in metadata");
  });

  it("rejects 'device:' prefix as a tag", async () => {
    await assert.rejects(
      async () => {
        await store3.store({
          text: "should not store",
          vector: randomVec(),
          category: "fact",
          scope: "global",
          importance: 0.5,
          scopes: ["global", "device:abc123"],
        });
      },
      /device.*tag/i,
      "should reject device: tag"
    );
  });

  it("stores without scopes array defaults to single scope entry", async () => {
    const entry = await store3.store({
      text: "default scope",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });

    assert.ok(entry, "store should succeed");
    const rows = store3.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ?"
    ).all(entry!.id) as { scope: string }[];
    assert.equal(rows.length, 1, "should have one scope row");
    assert.equal(rows[0].scope, "global");
  });
});
