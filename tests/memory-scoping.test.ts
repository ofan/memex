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

// Import for the retriever tests
import { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";

// ============================================================================
// P4b — Retriever scopes override
// ============================================================================

describe("P4b: retriever scopes override", () => {
  let storeR: MemoryStore;
  let retriever: MemoryRetriever;
  const embedder: Embedder = {
    dimensions: DIM,
    async embedQuery(text: string): Promise<number[]> {
      return seedVecR(text.length);
    },
    async embedPassage(text: string): Promise<number[]> {
      return seedVecR(text.length);
    },
  };

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
