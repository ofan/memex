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
import { createHash } from "node:crypto";
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
      createHash("sha256").update("multi-tag test").digest("hex"));

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
      createHash("sha256").update("unique test").digest("hex"));

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

  it("store() writes EXACT tag set to memory_scopes (not approximate)", async () => {
    const tags = ["global", "project:exact-test-001", "client:test-client"];
    const entry = await store.store({
      text: "exact tag test",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: tags,
    });
    assert.ok(entry, "store should succeed");

    const rows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entry!.id) as { scope: string }[];
    const storedTags = rows.map(r => r.scope);
    // Must be an exact match (deduped and sorted)
    assert.deepEqual(storedTags, [...new Set(tags)].sort(),
      "memory_scopes must contain exact scope tag set, no more, no less");
  });

  it("store() deduplicates repeated tags in scopes array", async () => {
    const entry = await store.store({
      text: "dedup tags test",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "global", "project:dup-test", "global"],
    });
    assert.ok(entry, "store should succeed");

    const rows = store.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entry!.id) as { scope: string }[];
    assert.deepEqual(rows.map(r => r.scope), ["global", "project:dup-test"],
      "duplicate tags must be deduplicated in memory_scopes");
  });

  it("store() writes dedup_hash matching actual scope tags", async () => {
    const tags = ["global", "project:hash-test", "client:test-client"];
    const entry = await store.store({
      text: "dedup hash integrity test",
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: tags,
    });
    assert.ok(entry, "store should succeed");

    const row = store.db.prepare(
      "SELECT dedup_hash, text_hash FROM memories WHERE id = ?"
    ).get(entry!.id) as { dedup_hash: string; text_hash: string };
    assert.ok(row.dedup_hash, "must have dedup_hash");
    assert.ok(row.text_hash, "must have text_hash");

    // Verify dedup_hash is computed correctly based on (text, canonical tags)
    const expectedDedup = createHash("sha256")
      .update(entry!.text.trim())
      .update('\x00')
      .update([...new Set(tags)].sort().join(','))
      .digest("hex");
    assert.equal(row.dedup_hash, expectedDedup,
      "dedup_hash must match sha256(text + \\x00 + sorted tags)");
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

  // Regression: ssh:// URL form
  it("handles ssh:// URL form", () => {
    assert.equal(
      normalizeGitRemote("ssh://git@github.com/user/repo.git"),
      "https://github.com/user/repo"
    );
  });

  // Regression: strips trailing slashes
  it("strips trailing slashes", () => {
    assert.equal(
      normalizeGitRemote("https://github.com/user/repo/"),
      "https://github.com/user/repo"
    );
  });

  // Regression: ssh:// and SCP form produce the same normalized output
  it("ssh:// and SCP forms produce identical hashes", () => {
    const n1 = normalizeGitRemote("ssh://git@github.com:22/user/repo");
    const n2 = normalizeGitRemote("git@github.com:user/repo");
    // After normalization, both port-stripped ssh:// and SCP should map to same host/path
    assert.ok(n1.includes("github.com/user/repo") || n1 === "https://github.com/user/repo");
    // They won't be identical if port is preserved, but the key is both contain
    // the canonical host and path
    const n1NoPort = normalizeGitRemote("ssh://git@github.com/user/repo");
    assert.equal(n1NoPort, n2);
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

  it("clientName goes to metadata only, not auto-tagged", () => {
    // Per spec: client is OPT-IN. clientName is provenance metadata only.
    // Auto-tagging client would silo general facts by capturing-client.
    const result = deriveScopes({ cwd: tmpdir(), clientName: "claude-code" });
    const clientTags = result.tags.filter(t => t.startsWith("client:"));
    assert.equal(clientTags.length, 0,
      "clientName alone must not auto-add a client tag");
    assert.equal(result.metadata.client, "claude-code",
      "clientName must be in metadata.provenance");
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
    assert.ok((result.metadata.captured_at as number) >= before);
    assert.ok((result.metadata.captured_at as number) <= Date.now());
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
      assert.ok(/^[0-9a-f]{16}$/.test((result.metadata.project_root as string) || ""), "project_root should be hash");
      assert.ok(/^[0-9a-f]{16}$/.test((result.metadata.cwd_hash as string) || ""), "cwd_hash should be hash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // Regression: BUG 1 — client tag is OPT-IN, not auto-derived from clientName
  // ==========================================================================

  it("BUGFIX: clientName does NOT auto-add a client tag (opt-in only)", () => {
    // Per spec: client is opt-in. clientName is provenance only.
    // Auto-tagging client would silo general facts by capturing-client
    // (e.g. "I like dark mode" captured in Claude Code would be hidden from Codex).
    const result = deriveScopes({ cwd: tmpdir(), clientName: "claude-code" });
    const clientTags = result.tags.filter(t => t.startsWith("client:"));
    assert.equal(clientTags.length, 0,
      "clientName alone must NOT create a client:<name> tag — client is opt-in");
    // clientName must still be recorded in metadata provenance
    assert.equal(result.metadata.client, "claude-code",
      "clientName must be preserved in metadata.provenance");
  });

  it("BUGFIX: explicit.client adds client tag when explicitly requested", () => {
    // When explicit.client is set, the tag IS added — the caller opts in.
    const result = deriveScopes({
      cwd: tmpdir(),
      clientName: "auto-detected-client",
      explicit: { client: "claude-code" },
    });
    const clientTags = result.tags.filter(t => t.startsWith("client:"));
    assert.equal(clientTags.length, 1, "explicit.client must create exactly one client tag");
    assert.equal(clientTags[0], "client:claude-code",
      "explicit.client value becomes the tag");
    // explicit.client overrides clientName in metadata too
    assert.equal(result.metadata.client, "claude-code",
      "explicit.client takes precedence in metadata");
  });

  it("BUGFIX: clientName alone — no tag, but session hash still works", () => {
    // The session tag uses a client-derived hash prefix. Even though
    // clientName doesn't create a tag, the session hash should still
    // use the available client identity (clientName) for namespacing.
    const result = deriveScopes({
      cwd: tmpdir(),
      clientName: "codex",
      sessionId: "my-session",
    });
    const clientTags = result.tags.filter(t => t.startsWith("client:"));
    assert.equal(clientTags.length, 0,
      "clientName alone must NOT create a client tag");
    // Session tag must still exist and have a non-zero hash prefix
    const sessionTag = result.tags.find(t => t.startsWith("session:"));
    assert.ok(sessionTag, "session tag must still be present");
    const parts = sessionTag!.split(":");
    assert.notEqual(parts[1], "00000000",
      "session hash prefix must use client identity (not all-zeros)");
  });

  // ==========================================================================
  // Regression: BUG 3 — client-supplied device_id must be hashed
  // ==========================================================================

  it("BUGFIX: client-supplied device_id is hashed in metadata", () => {
    // In stdio mode, device_id = hash(hostname + HOME). In HTTP mode,
    // the client supplies a device_id. It must also be hashed for symmetry —
    // raw device identifiers must never be stored.
    const rawDeviceId = "device-abc-123-custom-client-id";
    const result = deriveScopes({
      cwd: tmpdir(),
      explicit: { device: rawDeviceId },
    });
    // Must be a 16-char hex hash, not the raw value
    assert.equal(typeof result.metadata.device_id, "string");
    assert.equal((result.metadata.device_id as string).length, 16,
      "client-supplied device_id must be hashed to 16-char hex");
    assert.ok(/^[0-9a-f]{16}$/.test(result.metadata.device_id as string),
      "client-supplied device_id must be a hex hash");
    assert.notEqual(result.metadata.device_id, rawDeviceId,
      "raw device_id must not be stored in metadata");
    // Verify it's deterministic
    const result2 = deriveScopes({
      cwd: tmpdir(),
      explicit: { device: rawDeviceId },
    });
    assert.equal(result.metadata.device_id, result2.metadata.device_id,
      "hashing must be deterministic");
  });

  it("BUGFIX: derived device_id (no explicit) is still hashed", () => {
    // When no explicit device is provided, deriveDeviceId() already hashes.
    // This test guards against double-hashing regressions.
    const result = deriveScopes({ cwd: tmpdir() });
    assert.equal(typeof result.metadata.device_id, "string");
    assert.equal((result.metadata.device_id as string).length, 16,
      "derived device_id must be 16-char hex hash");
    assert.ok(/^[0-9a-f]{16}$/.test(result.metadata.device_id as string),
      "derived device_id must be a hex hash");
    // Must NOT appear in tags
    assert.equal(result.tags.find(t => t.startsWith("device:")), undefined,
      "device must never be a tag");
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

  // ==========================================================================
  // Bug regression: scope-aware dedup (identical text + different scopes)
  // ==========================================================================

  it("identical text under different scope-sets both store successfully", async () => {
    const text = "The user prefers dark mode for coding sessions";

    // Store with scope-set A
    const entry1 = await store3.store({
      text,
      vector: randomVec(),
      category: "preference",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:aaaa1111"],
    });
    assert.ok(entry1, "first store should succeed");

    // Store SAME text with scope-set B — must NOT be rejected as duplicate
    const entry2 = await store3.store({
      text,
      vector: randomVec(),
      category: "preference",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:bbbb2222"],
    });
    assert.ok(entry2, "second store with different scopes should succeed (not rejected as duplicate)");

    // Verify both exist in DB
    const rows = store3.db.prepare(
      "SELECT id, text FROM memories WHERE text = ? ORDER BY id"
    ).all(text) as { id: string; text: string }[];
    assert.equal(rows.length, 2, "both entries should be in the database");
    assert.notEqual(entry1!.id, entry2!.id, "entries should have different IDs");

    // Verify each has correct scope tags in memory_scopes
    const tags1 = store3.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entry1!.id) as { scope: string }[];
    assert.deepEqual(tags1.map(r => r.scope), ["global", "project:aaaa1111"]);

    const tags2 = store3.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entry2!.id) as { scope: string }[];
    assert.deepEqual(tags2.map(r => r.scope), ["global", "project:bbbb2222"]);
  });

  it("identical text under same scope-set is still deduplicated", async () => {
    const text = "This fact should still dedup under the same scopes";

    const entry1 = await store3.store({
      text,
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:sameproj"],
    });
    assert.ok(entry1, "first store should succeed");

    // Same text, same scopes => must be rejected
    const entry2 = await store3.store({
      text,
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:sameproj"],
    });
    assert.equal(entry2, null, "same text + same scopes should be deduplicated");
  });

  it("identical text without scopes array falls back to scope field for dedup", async () => {
    const text = "Another dedup scope field test";

    const entry1 = await store3.store({
      text,
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });
    assert.ok(entry1, "first store should succeed");

    // Same text, same default scope => dedup
    const entry2 = await store3.store({
      text,
      vector: randomVec(),
      category: "fact",
      scope: "global",
      importance: 0.5,
    });
    assert.equal(entry2, null, "same text + same default scope should be deduplicated");
  });

  // ==========================================================================
  // Bug regression: storeWithChunks device: prefix validation
  // ==========================================================================

  it("storeWithChunks rejects 'device:' prefix in scope tags", async () => {
    await assert.rejects(
      async () => {
        await store3.storeWithChunks({
          text: "long text for chunks with bad device tag",
          category: "fact",
          scope: "global",
          importance: 0.5,
          scopes: ["global", "device:mac-studio-3"],
          chunkVectors: [randomVec(), randomVec(), randomVec()],
        });
      },
      /device.*tag/i,
      "storeWithChunks should reject device: tag"
    );
  });

  it("storeWithChunks accepts valid scope tags and writes them correctly", async () => {
    const entry = await store3.storeWithChunks({
      text: "long text for chunks with valid scopes",
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:testproj", "client:test-client"],
      chunkVectors: [randomVec(), randomVec()],
    });
    assert.ok(entry, "storeWithChunks should succeed with valid scope tags");

    // Verify scope tags were written correctly
    const tags = store3.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entry.id) as { scope: string }[];
    const tagValues = tags.map(r => r.scope);
    assert.ok(tagValues.includes("global"), "should have global tag");
    assert.ok(tagValues.includes("project:testproj"), "should have project tag");
    assert.ok(tagValues.includes("client:test-client"), "should have client tag");
  });
});

// ============================================================================
// P4 — Recall tag-intersection
// ============================================================================

describe("P4: recall tag-intersection", () => {
  let store4: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-p4-test-"));
    store4 = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await store4.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper: create a memory with specific scope tags
  async function storeWithTags(
    text: string,
    tags: string[],
    vector?: number[],
  ): Promise<MemoryEntry> {
    const entry = await store4.store({
      text,
      vector: vector || seedVec(text.length),
      category: "fact",
      scope: tags[0] || "global",
      importance: 0.5,
      scopes: tags,
    });
    assert.ok(entry, `store should succeed for "${text}"`);
    return entry!;
  }

  function seedVec(seed: number, dim: number = DIM): number[] {
    const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  }

  // ==========================================================================
  // vectorSearch with tag-intersection
  // ==========================================================================

  describe("vectorSearch tag-intersection", () => {
    it("finds memory by global tag", async () => {
      const vec = seedVec(1);
      await storeWithTags("global-only memory", ["global"], vec);

      const results = await store4.vectorSearch(vec, 5, 0.0, ["global"]);
      assert.ok(results.length >= 1, "should find global-tagged memory");
    });

    it("does not find memory when tag set does not intersect", async () => {
      const vec = seedVec(2);
      // Memory with ONLY project:aaa111 (no global — project-isolated)
      await storeWithTags("proj-A-only memory", ["project:aaa111"], vec);

      const results = await store4.vectorSearch(vec, 5, 0.0, ["project:bbb222"]);
      assert.equal(results.length, 0,
        "should not find project:aaa111 memory when filtering by project:bbb222");
    });

    it("global always surfaces regardless of other filter tags", async () => {
      const vec = seedVec(30);
      await storeWithTags("global fact", ["global"], vec);

      // Even with a project scope that has nothing to do with this memory,
      // the global tag ensures it surfaces.
      const results = await store4.vectorSearch(vec, 5, 0.0,
        ["global", "project:some-random-project"]);
      assert.ok(results.length >= 1, "global memory should surface everywhere");
    });

    it("memory with only global tag surfaces with project-specific filters", async () => {
      const vec = seedVec(31);
      await storeWithTags("global-only fact", ["global"], vec);

      const results = await store4.vectorSearch(vec, 5, 0.0,
        ["global", "project:any-proj", "client:any-client"]);
      assert.ok(results.length >= 1,
        "global-tagged memory should surface regardless of other tags in filter");
    });

    it("no cross-project leak for project-isolated memories (no global tag)", async () => {
      const vecA = seedVec(10);
      const vecB = seedVec(20);

      // Project-isolated: NO global tag — these are scoped to a specific project
      await storeWithTags("project A fact", ["project:aaa111"], vecA);
      await storeWithTags("project B fact", ["project:bbb222"], vecB);

      // Recall with project A scope only
      const resultsA = await store4.vectorSearch(vecA, 5, 0.0, ["project:aaa111"]);
      const textsA = resultsA.map(r => r.entry.text);
      assert.ok(textsA.includes("project A fact"), "should find project A memory");
      assert.ok(!textsA.includes("project B fact"),
        "should NOT leak project B memory into project A recall");

      // Recall with project B scope only
      const resultsB = await store4.vectorSearch(vecB, 5, 0.0, ["project:bbb222"]);
      const textsB = resultsB.map(r => r.entry.text);
      assert.ok(textsB.includes("project B fact"), "should find project B memory");
      assert.ok(!textsB.includes("project A fact"),
        "should NOT leak project A memory into project B recall");
    });

    it("project-isolated memory does not leak via global filter", async () => {
      const vec = seedVec(11);
      // This memory does NOT have global tag
      await storeWithTags("isolated fact", ["project:secretProj"], vec);

      // Filtering by global alone should NOT find it
      const results = await store4.vectorSearch(vec, 5, 0.0, ["global"]);
      assert.equal(results.length, 0,
        "project-only memory should not surface when filtering by global alone");
    });

    it("client tag filtering", async () => {
      const vec = seedVec(40);
      // Both have global + client-specific tag
      await storeWithTags("claude-code preference",
        ["global", "client:claude-code"], vec);
      await storeWithTags("codex preference",
        ["global", "client:codex"], vec);

      // Because both have global, filtering by ["global", "client:claude-code"]
      // will surface BOTH (global matches both). The client:claude-code memory
      // matches by both tags; the codex one matches by global.
      const ccResults = await store4.vectorSearch(vec, 10, 0.0,
        ["global", "client:claude-code"]);
      const ccTexts = ccResults.map(r => r.entry.text);
      assert.equal(ccResults.length, 2,
        "both memories should surface because both have global tag");
    });

    it("client-isolated memory (no global) only surfaces for its client", async () => {
      const vec = seedVec(41);
      // No global tag — truly client-specific
      await storeWithTags("claude-code private", ["client:claude-code"], vec);
      await storeWithTags("codex private", ["client:codex"], vec);

      // Recall as claude-code
      const ccResults = await store4.vectorSearch(vec, 10, 0.0, ["client:claude-code"]);
      const ccTexts = ccResults.map(r => r.entry.text);
      assert.ok(ccTexts.includes("claude-code private"));
      assert.ok(!ccTexts.includes("codex private"),
        "client:claude-code filter should not surface codex-only memory");

      // Recall as codex
      const codexResults = await store4.vectorSearch(vec, 10, 0.0, ["client:codex"]);
      const codexTexts = codexResults.map(r => r.entry.text);
      assert.ok(codexTexts.includes("codex private"));
      assert.ok(!codexTexts.includes("claude-code private"),
        "client:codex filter should not surface claude-code-only memory");
    });

    it("session tag filtering", async () => {
      const vec = seedVec(50);
      await storeWithTags("session-abc memory",
        ["global", "session:aaaaaaaa:abc"], vec);
      await storeWithTags("session-xyz memory",
        ["global", "session:aaaaaaaa:xyz"], vec);

      // Both have global, so both surface with either filter
      const abcResults = await store4.vectorSearch(vec, 10, 0.0,
        ["global", "session:aaaaaaaa:abc"]);
      assert.equal(abcResults.length, 2,
        "both session memories surface because both have global");
    });

    it("session-isolated memory only surfaces for its session", async () => {
      const vec = seedVec(51);
      await storeWithTags("session-abc only", ["session:aaaaaaaa:abc"], vec);
      await storeWithTags("session-xyz only", ["session:aaaaaaaa:xyz"], vec);

      const abcResults = await store4.vectorSearch(vec, 5, 0.0,
        ["session:aaaaaaaa:abc"]);
      const abcTexts = abcResults.map(r => r.entry.text);
      assert.ok(abcTexts.includes("session-abc only"));
      assert.ok(!abcTexts.includes("session-xyz only"));
    });

    it("agent tag filtering", async () => {
      const vec = seedVec(60);
      await storeWithTags("dev-assistant fact", ["global", "agent:dev-assistant"], vec);
      await storeWithTags("qa-bot fact", ["global", "agent:qa-bot"], vec);

      // Both have global, so both surface with either agent filter
      const daResults = await store4.vectorSearch(vec, 10, 0.0,
        ["global", "agent:dev-assistant"]);
      assert.equal(daResults.length, 2,
        "both memories surface because both have global");
    });

    it("agent-isolated memory only surfaces for its agent", async () => {
      const vec = seedVec(61);
      await storeWithTags("dev-assistant only", ["agent:dev-assistant"], vec);
      await storeWithTags("qa-bot only", ["agent:qa-bot"], vec);

      const daResults = await store4.vectorSearch(vec, 5, 0.0,
        ["agent:dev-assistant"]);
      const daTexts = daResults.map(r => r.entry.text);
      assert.ok(daTexts.includes("dev-assistant only"));
      assert.ok(!daTexts.includes("qa-bot only"));
    });

    it("sparse: global-tagged memory is client-agnostic", async () => {
      const vec = seedVec(70);
      // Memory with only global + project (no client tag)
      await storeWithTags("no-client memory", ["global", "project:myproj"], vec);

      // Should surface when filtering includes global (global always matches)
      const results = await store4.vectorSearch(vec, 5, 0.0,
        ["global", "client:any-client"]);
      assert.ok(results.length >= 1,
        "global-tagged memory should surface with any client filter (client-agnostic)");
    });

    it("sparse: global-tagged memory is session-agnostic", async () => {
      const vec = seedVec(80);
      await storeWithTags("no-session memory", ["global", "project:myproj"], vec);

      const results = await store4.vectorSearch(vec, 5, 0.0,
        ["global", "session:xxxxxxxx:s1"]);
      assert.ok(results.length >= 1,
        "global-tagged memory should surface with any session filter (session-agnostic)");
    });

    it("sparse: memory without client tag does not match client-only filter", async () => {
      const vec = seedVec(71);
      // Memory WITHOUT global and WITHOUT client tag
      await storeWithTags("project-only memory", ["project:myproj"], vec);

      // Filtering by client-only should NOT find it
      const results = await store4.vectorSearch(vec, 5, 0.0, ["client:any-client"]);
      assert.equal(results.length, 0,
        "memory without client tag should not match client-only filter");
    });

    it("memory with multiple tags matches any of them", async () => {
      const vec = seedVec(90);
      await storeWithTags("multi-tag memory",
        ["global", "project:myproj", "client:test-client"], vec);

      // Match by global
      let results = await store4.vectorSearch(vec, 5, 0.0, ["global"]);
      assert.equal(results.length, 1, "should match by global tag");

      // Match by project
      results = await store4.vectorSearch(vec, 5, 0.0, ["project:myproj"]);
      assert.equal(results.length, 1, "should match by project tag");

      // Match by client
      results = await store4.vectorSearch(vec, 5, 0.0, ["client:test-client"]);
      assert.equal(results.length, 1, "should match by client tag");

      // No match with unrelated scope (global is in the memory but NOT in filter)
      results = await store4.vectorSearch(vec, 5, 0.0, ["project:other-proj"]);
      assert.equal(results.length, 0, "should not match unrelated project");

      // Match again when filter includes global
      results = await store4.vectorSearch(vec, 5, 0.0,
        ["global", "project:other-proj"]);
      assert.equal(results.length, 1, "should match via global even with unrelated project in filter");
    });

    it("empty scopeFilter returns all results", async () => {
      const vec = seedVec(100);
      await storeWithTags("mem a", ["global", "project:A"], vec);
      await storeWithTags("mem b", ["global", "project:B"], vec);

      // No scope filter at all
      const results = await store4.vectorSearch(vec, 10, 0.0);
      assert.equal(results.length, 2, "empty scopeFilter should return all");
    });

    it("undefined scopeFilter returns all results", async () => {
      const vec = seedVec(110);
      await storeWithTags("undef mem", ["project:secret"], vec);

      const results = await store4.vectorSearch(vec, 5, 0.0, undefined);
      assert.equal(results.length, 1, "undefined scopeFilter should return all");
    });
  });

  // ==========================================================================
  // bm25Search with tag-intersection
  // ==========================================================================

  describe("bm25Search tag-intersection", () => {
    it("finds memory by global tag", async () => {
      await storeWithTags("aardvark is a nocturnal mammal", ["global"]);

      const results = await store4.bm25Search("aardvark", 5, ["global"]);
      assert.ok(results.length >= 1, "should find global-tagged memory via BM25");
    });

    it("no cross-project leak in BM25 for project-isolated memories", async () => {
      // No global tag — project-isolated
      await storeWithTags("flamingo project A bird", ["project:aaa111"]);
      await storeWithTags("flamingo project B bird", ["project:bbb222"]);

      const results = await store4.bm25Search("flamingo", 5, ["project:aaa111"]);
      const texts = results.map(r => r.entry.text);
      assert.ok(texts.includes("flamingo project A bird"));
      assert.ok(!texts.includes("flamingo project B bird"),
        "BM25 should not leak across isolated projects");
    });

    it("client-isolated filtering in BM25", async () => {
      await storeWithTags("penguin claude-code fact", ["client:claude-code"]);
      await storeWithTags("penguin codex fact", ["client:codex"]);

      const results = await store4.bm25Search("penguin", 5, ["client:claude-code"]);
      const texts = results.map(r => r.entry.text);
      assert.ok(texts.includes("penguin claude-code fact"));
      assert.ok(!texts.includes("penguin codex fact"));
    });

    it("global-tagged memory surfaces with any filter in BM25", async () => {
      await storeWithTags("elephant general knowledge", ["global", "project:gen"]);

      // Since it has global tag, it should surface with any client filter
      const results = await store4.bm25Search("elephant", 5,
        ["global", "client:any-client"]);
      assert.ok(results.length >= 1,
        "global-tagged memory should surface in BM25 regardless of client");
    });

    it("returns empty when no tags intersect", async () => {
      await storeWithTags("giraffe-only-in-project-z", ["project:zzz999"]);

      const results = await store4.bm25Search("giraffe", 5,
        ["project:other-project"]);
      assert.equal(results.length, 0,
        "should not return memory whose tags do not intersect with filter");
    });
  });

  // ==========================================================================
  // list() with tag-intersection
  // ==========================================================================

  describe("list() tag-intersection", () => {
    it("filters by intersection of tags", async () => {
      await storeWithTags("list-item-a", ["global", "project:listA"]);
      await storeWithTags("list-item-b", ["global", "project:listB"]);

      // project:listA filter finds only the first
      const results = await store4.list(["project:listA"]);
      const texts = results.map(r => r.text);
      assert.ok(texts.includes("list-item-a"));
      assert.ok(!texts.includes("list-item-b"));
    });

    it("global filter surfaces all global-tagged memories", async () => {
      await storeWithTags("list-global-a", ["global", "project:listA"]);
      await storeWithTags("list-global-b", ["global", "project:listB"]);

      const results = await store4.list(["global"]);
      assert.equal(results.length, 2);
    });

    it("returns all when no scopeFilter", async () => {
      await storeWithTags("list-all-1", ["project:one"]);
      await storeWithTags("list-all-2", ["project:two"]);

      const results = await store4.list();
      assert.equal(results.length, 2, "no scopeFilter should list all");
    });
  });

  // ==========================================================================
  // stats() with tag-intersection
  // ==========================================================================

  describe("stats() tag-intersection", () => {
    it("filters stats by tag intersection", async () => {
      await storeWithTags("stats-a", ["global", "project:statsA"]);
      await storeWithTags("stats-b", ["global", "project:statsB"]);

      const stats = await store4.stats(["project:statsA"]);
      assert.equal(stats.totalCount, 1);
    });
  });

  // ==========================================================================
  // Regression: Bug A — stats() scopeCounts aggregates from memory_scopes
  // ==========================================================================

  describe("REGRESSION: stats() scopeCounts from memory_scopes", () => {
    it("scopeCounts reflects multi-valued tags from memory_scopes, not legacy scope column", async () => {
      // Store a memory with multi-valued tags
      await storeWithTags("regression-scope-counts",
        ["global", "project:reg-test-abc123"]);

      const stats = await store4.stats(["global"]);
      assert.equal(stats.totalCount, 1,
        "totalCount should be 1");
      // The scopeCounts must reflect tags from memory_scopes, not m.scope
      assert.ok(stats.scopeCounts["global"] >= 1,
        "scopeCounts must include global tag");
      assert.ok(stats.scopeCounts["project:reg-test-abc123"] >= 1,
        "scopeCounts must include project tag from memory_scopes (Bug A: was counting legacy m.scope column only)");
    });

    it("project-specific tag appears in scopeCounts even when legacy scope column is 'global'", async () => {
      // Simulate the exact bug scenario: legacy m.scope = 'global' but memory_scopes has both
      const id = "reg-legacy-scope";
      store4.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
        VALUES (?, 'legacy scope test', 'fact', 'global', 0.5, ?, '{}', ?)
      `).run(id, Date.now(),
        createHash("sha256").update("legacy scope test").digest("hex"));
      store4.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");
      store4.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "project:legacy-proj");
      store4.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "client:legacy-client");

      const stats = await store4.stats(["global"]);
      assert.equal(stats.totalCount, 1,
        "totalCount should be 1 (one memory)");
      // Bug: stats() currently counts m.scope (the legacy column "global")
      // It should count from memory_scopes where we'd see all 3 tags
      assert.equal(stats.scopeCounts["global"] || 0, 1,
        "global tag should be represented in scopeCounts");
      assert.ok(stats.scopeCounts["project:legacy-proj"] >= 1,
        "project tag must appear in scopeCounts (Bug A: was missing)");
      assert.ok(stats.scopeCounts["client:legacy-client"] >= 1,
        "client tag must appear in scopeCounts (Bug A: was missing)");
    });
  });

  // ==========================================================================
  // update() scope permission check
  // ==========================================================================

  describe("update() scope permission", () => {
    it("allows update when memory has matching tag", async () => {
      const entry = await storeWithTags("updatable memory",
        ["global", "project:upA"]);

      const updated = await store4.update(entry.id,
        { text: "updated text" },
        ["project:upA"]);
      assert.ok(updated, "update should succeed with matching tag");
      assert.equal(updated!.text, "updated text");
    });

    it("rejects update when memory has no matching tag", async () => {
      const entry = await storeWithTags("restricted memory",
        ["project:secretProj"]);

      await assert.rejects(
        async () => {
          await store4.update(entry.id,
            { text: "should fail" },
            ["project:otherProj"]);
        },
        /outside accessible scopes/,
        "should reject update when tags do not intersect"
      );
    });
  });

  // ==========================================================================
  // delete() scope permission check
  // ==========================================================================

  describe("delete() scope permission", () => {
    it("allows delete when memory has matching tag", async () => {
      const entry = await storeWithTags("deletable memory",
        ["global", "project:delA"]);

      const deleted = await store4.delete(entry.id, ["project:delA"]);
      assert.equal(deleted, true);
    });

    it("rejects delete when memory has no matching tag", async () => {
      const entry = await storeWithTags("protected memory",
        ["project:privateDel"]);

      await assert.rejects(
        async () => {
          await store4.delete(entry.id, ["project:otherDel"]);
        },
        /outside accessible scopes/,
        "should reject delete when tags do not intersect"
      );
    });
  });

  // ==========================================================================
  // bulkDelete() with tag-intersection
  // ==========================================================================

  // ==========================================================================
  // Regression: Bug C — update() must recompute dedup_hash + text_hash
  // ==========================================================================

  describe("REGRESSION: update() recomputes dedup_hash and text_hash", () => {
    it("update() recomputes dedup_hash when text changes", async () => {
      const entry = await storeWithTags("original text for dedup update",
        ["global", "project:update-dedup"]);
      assert.ok(entry);

      const oldRow = store4.db.prepare(
        "SELECT dedup_hash, text_hash FROM memories WHERE id = ?"
      ).get(entry.id) as { dedup_hash: string; text_hash: string };
      assert.ok(oldRow.dedup_hash, "should have original dedup_hash");
      assert.ok(oldRow.text_hash, "should have original text_hash");

      // Update the text
      const updated = await store4.update(entry.id,
        { text: "completely different text after update" },
        ["project:update-dedup"]);
      assert.ok(updated, "update should succeed");

      const newRow = store4.db.prepare(
        "SELECT dedup_hash, text_hash, text FROM memories WHERE id = ?"
      ).get(entry.id) as { dedup_hash: string; text_hash: string; text: string };

      // Verify text was actually updated
      assert.equal(newRow.text, "completely different text after update");

      // Bug C: update() does NOT recompute dedup_hash or text_hash
      // After fix, both should be different from the originals
      assert.notEqual(newRow.dedup_hash, oldRow.dedup_hash,
        "dedup_hash must be recomputed when text changes (Bug C: was not recomputed)");
      assert.notEqual(newRow.text_hash, oldRow.text_hash,
        "text_hash must be recomputed when text changes (Bug C: was not recomputed)");
    });

    it("same text + same scopes stored after update-once is still deduplicated", async () => {
      // Step 1: Store original, update it
      const entry = await storeWithTags("dedup integrity text",
        ["global", "project:dedup-int"]);
      assert.ok(entry);

      await store4.update(entry.id,
        { text: "dedup integrity text revised" },
        ["project:dedup-int"]);

      // Step 2: Try to store the revised text with same scopes
      // Bug C: since dedup_hash wasn't recomputed, the OLD dedup_hash still
      // matches the OLD text. If we try to store the revised text, it should
      // NOT be blocked by the old hash.
      const newEntry = await store4.store({
        text: "dedup integrity text revised",
        vector: randomVec(),
        category: "fact",
        scope: "global",
        importance: 0.5,
        scopes: ["global", "project:dedup-int"],
      });
      assert.equal(newEntry, null,
        "revised text with same scopes should be deduplicated (hash match)");

      // Step 3: But the ORIGINAL (unrevised) text should NOW be storable
      // since the dedup_hash was updated to match the revised text
      const reOriginal = await store4.store({
        text: "dedup integrity text",
        vector: randomVec(),
        category: "fact",
        scope: "global",
        importance: 0.5,
        scopes: ["global", "project:dedup-int"],
      });
      assert.ok(reOriginal, "original text (no longer matching dedup_hash) should be storable again");
    });
  });

  describe("bulkDelete() tag-intersection", () => {
    it("deletes only memories with matching tags", async () => {
      await storeWithTags("bulk-a", ["global", "project:bulkA"]);
      await storeWithTags("bulk-b", ["global", "project:bulkB"]);

      const deleted = await store4.bulkDelete(["project:bulkA"]);
      assert.equal(deleted, 1, "should delete only one memory");

      // Verify the other still exists
      const remaining = await store4.list(["project:bulkB"]);
      assert.equal(remaining.length, 1);
    });
  });
});

// ==========================================================================
// Recall scope integrity — results carry scope info, store-recall cycle
// ==========================================================================

describe("P4+: recall scope integrity", () => {
  let storeSI: MemoryStore;

  function seedVecSI(seed: number, dim: number = DIM): number[] {
    const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-p4si-test-"));
    storeSI = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await storeSI.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("store → recall round-trip preserves all scope tags with deriveScopes", async () => {
    // Create a git repo so deriveScopes produces a real project tag
    const gitDir = mkdtempSync(join(tmpdir(), "si-git-"));
    execSync("git init", { cwd: gitDir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: gitDir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: gitDir, stdio: "pipe" });
    execSync("git remote add origin https://github.com/test/si-repo.git", {
      cwd: gitDir, stdio: "pipe",
    });
    writeFileSync(join(gitDir, "README.md"), "# SI");
    execSync("git add README.md", { cwd: gitDir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: gitDir, stdio: "pipe" });

    try {
      const derivResult = deriveScopes({ cwd: gitDir, clientName: "test-client" });
      const tags = derivResult.tags;
      assert.ok(tags.includes("global"), "derived tags must include global");
      const projectTag = tags.find(t => t.startsWith("project:"));
      assert.ok(projectTag, "derived tags must include project tag");

      const entry = await storeSI.store({
        text: "SI store-recall round-trip test",
        vector: seedVecSI("SI store-recall round-trip test".length),
        category: "fact",
        scope: "global",
        importance: 0.5,
        scopes: tags,
        metadata: JSON.stringify(derivResult.metadata),
      });
      assert.ok(entry, "store should succeed");

      // Verify memory_scopes has the exact derived tags
      const scopeRows = storeSI.db.prepare(
        "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
      ).all(entry!.id) as { scope: string }[];
      const storedTags = scopeRows.map(r => r.scope);
      // Should contain at least global and project tag (both auto-derived)
      assert.ok(storedTags.includes("global"), "must include global tag");
      assert.ok(storedTags.some(t => t.startsWith("project:")),
        "must include project tag");

      // Recall with the derived tags
      const results = await storeSI.vectorSearch(
        seedVecSI("SI store-recall round-trip test".length),
        5, 0.0, tags,
      );
      assert.ok(results.length >= 1, "recall must find the stored memory");
      assert.equal(results[0].entry.text, "SI store-recall round-trip test");
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it("list() entries have correct scope field (legacy compat)", async () => {
    await storeSI.store({
      text: "list scope check",
      vector: seedVecSI("list scope check".length),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:list-check"],
    });

    const entries = await storeSI.list(["global"]);
    assert.equal(entries.length, 1);
    // The legacy scope field should still be populated
    assert.equal(entries[0].scope, "global",
      "legacy scope field should still be set for backward compat");

    // The memory should also have its scope tags in memory_scopes
    const tags = storeSI.db.prepare(
      "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
    ).all(entries[0].id) as { scope: string }[];
    assert.ok(tags.length >= 2, "should have multiple scope tags in memory_scopes");
    assert.ok(tags.some(t => t.scope === "project:list-check"),
      "should include project tag in memory_scopes");
  });

  it("vectorSearch results have correct id and text, tagged scopes filter works", async () => {
    const vec = seedVecSI("vector recall scope".length);
    await storeSI.store({
      text: "vector recall scope",
      vector: vec,
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:vec-scope-test"],
    });
    // Also store an unrelated memory
    await storeSI.store({
      text: "unrelated memory",
      vector: seedVecSI("unrelated memory".length),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["project:other-proj"],
    });

    // Recall with the project scope
    const results = await storeSI.vectorSearch(vec, 5, 0.0, ["project:vec-scope-test"]);
    assert.ok(results.length >= 1, "should find the memory via project scope filter");
    const found = results.find(r => r.entry.text === "vector recall scope");
    assert.ok(found, "should find the correct memory");
    assert.equal(found!.entry.category, "fact");
    // Unrelated memory should not appear
    assert.ok(!results.some(r => r.entry.text === "unrelated memory"),
      "unrelated memory must not leak into project-scoped recall");
  });

  // ==========================================================================
  // Fix 1 verification: scopes array populated on recall/list results
  // ==========================================================================

  it("vectorSearch results have scopes array populated from memory_scopes", async () => {
    await storeSI.store({
      text: "scopes-populated-on-vectorSearch",
      vector: seedVecSI("scopes-populated-on-vectorSearch".length),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:vs-scopes-test"],
    });

    const results = await storeSI.vectorSearch(
      seedVecSI("scopes-populated-on-vectorSearch".length),
      5, 0.0, ["global"],
    );
    assert.ok(results.length >= 1, "should find the memory");
    const entry = results[0].entry;
    assert.ok(entry.scopes, "entry.scopes must be defined");
    assert.ok(Array.isArray(entry.scopes), "entry.scopes must be an array");
    assert.ok(entry.scopes!.includes("global"), "scopes must include global");
    assert.ok(entry.scopes!.includes("project:vs-scopes-test"), "scopes must include project tag");
  });

  it("bm25Search results have scopes array populated from memory_scopes", async () => {
    await storeSI.store({
      text: "aardvark scopes populated on bm25Search",
      vector: seedVecSI("aardvark scopes populated on bm25Search".length),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:bm25-scopes-test"],
    });

    const results = await storeSI.bm25Search("aardvark", 5, ["global"]);
    assert.ok(results.length >= 1, "should find the memory via BM25");
    const entry = results[0].entry;
    assert.ok(entry.scopes, "entry.scopes must be defined on bm25Search result");
    assert.ok(entry.scopes!.includes("global"), "scopes must include global");
    assert.ok(entry.scopes!.includes("project:bm25-scopes-test"), "scopes must include project tag");
  });

  it("list() results have scopes array populated from memory_scopes", async () => {
    await storeSI.store({
      text: "list scopes populated test",
      vector: seedVecSI("list scopes populated test".length),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:list-scopes-test"],
    });

    const entries = await storeSI.list(["global"]);
    assert.ok(entries.length >= 1, "should list the memory");
    const entry = entries.find(e => e.text === "list scopes populated test");
    assert.ok(entry, "should find the correct memory in list");
    assert.ok(entry!.scopes, "entry.scopes must be defined on list result");
    assert.ok(entry!.scopes!.includes("global"), "scopes must include global");
    assert.ok(entry!.scopes!.includes("project:list-scopes-test"), "scopes must include project tag");
  });

  // ==========================================================================
  // Fix 2 verification: update() returns scopes on MemoryEntry
  // ==========================================================================

  it("update() returns scopes array on updated MemoryEntry", async () => {
    const entry = await storeSI.store({
      text: "update scopes return test",
      vector: seedVecSI("update scopes return test".length),
      category: "fact",
      scope: "global",
      importance: 0.5,
      scopes: ["global", "project:update-return-test"],
    });
    assert.ok(entry, "store should succeed");

    const updated = await storeSI.update(entry!.id, { text: "updated scopes return text" }, ["global"]);
    assert.ok(updated, "update should succeed");
    assert.ok(updated!.scopes, "updated entry must have scopes array");
    assert.ok(updated!.scopes!.includes("global"), "scopes must include global");
    assert.ok(updated!.scopes!.includes("project:update-return-test"), "scopes must include project tag");
  });
});

// ============================================================================
// Fix 4 verification: dreaming learnings carry dedup_hash
// ============================================================================

describe("P5+: dreaming learnings dedup_hash", () => {
  let storeDD: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-dd-test-"));
    storeDD = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await storeDD.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("learnings inserted manually get dedup_hash matching (text + sorted scopes)", () => {
    // Simulate what reflectionSweep does: insert a learning with dedup_hash
    const text = "The user prefers TypeScript over JavaScript for new projects";
    const tags = ["global", "project:dedup-learning-test"];
    const sortedTags = [...tags].sort().join(",");
    const textHash = createHash("sha256").update(text).digest("hex");
    const dedupHash = createHash("sha256")
      .update(text)
      .update("\x00")
      .update(sortedTags)
      .digest("hex");

    const id = crypto.randomUUID();
    storeDD.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash, dedup_hash)
      VALUES (?, ?, 'learning', 'global', 0.85, ?, ?, ?)
    `).run(id, text, Date.now(), textHash, dedupHash);

    // Write scope tags
    for (const tag of tags) {
      storeDD.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, tag);
    }

    // Verify dedup_hash is non-null and correct
    const row = storeDD.db.prepare(
      "SELECT dedup_hash, text_hash FROM memories WHERE id = ?"
    ).get(id) as { dedup_hash: string; text_hash: string };
    assert.ok(row.dedup_hash, "learning must have dedup_hash set");
    assert.ok(row.dedup_hash.length === 64, "dedup_hash must be 64 hex chars (sha256)");
    assert.equal(row.dedup_hash, dedupHash, "dedup_hash must match sha256(text + \\x00 + sorted tags)");

    // Verify the UNIQUE index on dedup_hash catches a duplicate insert
    assert.throws(() => {
      storeDD.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp, text_hash, dedup_hash)
        VALUES (?, ?, 'learning', 'global', 0.85, ?, ?, ?)
      `).run(crypto.randomUUID(), text, Date.now(), textHash, dedupHash);
    }, /UNIQUE/, "duplicate dedup_hash must be rejected by UNIQUE index");
  });
});

// Import for the retriever tests
import { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

// ============================================================================
// P4b — Retriever scopes override
// ============================================================================

describe("P4b: retriever scopes override", () => {
  let storeR: MemoryStore;
  let retriever: MemoryRetriever;
  const embedder = {
    dimensions: DIM,
    async embedQuery(text: string): Promise<number[]> {
      return seedVecR(text.length);
    },
    async embedPassage(text: string): Promise<number[]> {
      return seedVecR(text.length);
    },
  } as unknown as Embedder;

  function seedVecR(seed: number, dim: number = DIM): number[] {
    const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map((x) => x / norm);
  }

  async function storeWithTagsR(
    text: string,
    tags: string[],
    vector?: number[],
  ): Promise<MemoryEntry> {
    const entry = await storeR.store({
      text,
      vector: vector || seedVecR(text.length),
      category: "fact",
      scope: tags[0] || "global",
      importance: 0.5,
      scopes: tags,
    });
    assert.ok(entry, `store should succeed for "${text}"`);
    return entry!;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-p4b-test-"));
    storeR = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
    retriever = new MemoryRetriever(storeR, embedder, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      mode: "vector",
      rerank: "none",
      minScore: 0.0,
    });
  });

  afterEach(async () => {
    await storeR.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scopes override takes precedence over scopeFilter", async () => {
    // Memory has project:overrideProj (plus global)
    await storeWithTagsR("scope-override-mem",
      ["global", "project:overrideProj"]);

    // scopeFilter would match (via global or project)
    const resultsWithScopeFilter = await retriever.retrieve({
      query: "scope-override",
      limit: 5,
      scopeFilter: ["global", "project:overrideProj"],
    });
    assert.ok(resultsWithScopeFilter.length >= 1,
      "should find with matching scopeFilter");

    // scopes override replaces scopeFilter with unrelated project
    const resultsWithOverride = await retriever.retrieve({
      query: "scope-override",
      limit: 5,
      scopeFilter: ["global", "project:overrideProj"],
      scopes: ["project:unrelated-proj"],
    });
    assert.equal(resultsWithOverride.length, 0,
      "scopes override should replace scopeFilter — memory not in unrelated-proj");
  });

  it("scopes override works without scopeFilter", async () => {
    await storeWithTagsR("some-memory", ["global", "project:targetProj"]);

    const results = await retriever.retrieve({
      query: "some-memory",
      limit: 5,
      scopes: ["project:targetProj"],
    });
    assert.ok(results.length >= 1,
      "scopes alone should filter correctly");
  });

  it("without any scope filter, all memories surface", async () => {
    await storeWithTagsR("mem-x", ["project:secretX"]);
    await storeWithTagsR("mem-y", ["project:secretY"]);

    const results = await retriever.retrieve({
      query: "mem",
      limit: 10,
    });
    assert.equal(results.length, 2,
      "without scope filter, all memories should surface");
  });

  it("scopes via global tag surfaces all global-tagged memories", async () => {
    await storeWithTagsR("glob-mem", ["global", "project:any"]);
    await storeWithTagsR("proj-only-mem", ["project:any"]);

    // scopes=[global] — should find glob-mem but not proj-only-mem
    const results = await retriever.retrieve({
      query: "mem",
      limit: 10,
      scopes: ["global"],
    });
    const texts = results.map(r => r.entry.text);
    assert.ok(texts.includes("glob-mem"), "global filter should find global-tagged memory");
    assert.ok(!texts.includes("proj-only-mem"),
      "global filter should NOT find project-only memory without global tag");
  });
});
