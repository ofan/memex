/**
 * Memory Scoping — End-to-End Integration Tests
 *
 * Verifies the full pipeline: store -> recall -> dreaming under scoped contexts.
 * Uses MemoryStore directly (no MCP transport) to test the complete integration
 * across multiple projects, clients, sessions, and agents.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { MemoryStore } from "../src/memory.js";
import { deriveScopes } from "../src/scope-derive.js";
import { lightSweep, reflectionSweep, deepSweep, runDreamCycle } from "../src/dreaming.js";
import type { MemoryEntry } from "../src/memory.js";

const DIM = 4;

function seedVec(seed: number, dim: number = DIM): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

// ============================================================================
// E2E: Store under multiple contexts, recall from each
// ============================================================================

describe("E2E: store under multiple contexts", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let projectADir: string;
  let projectBDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-e2e-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });

    // Create two git repos simulating different projects
    projectADir = join(tmpDir, "project-a");
    mkdirSync(projectADir, { recursive: true });
    execSync("git init", { cwd: projectADir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: projectADir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: projectADir, stdio: "pipe" });
    execSync("git remote add origin https://github.com/org/project-a.git", { cwd: projectADir, stdio: "pipe" });
    writeFileSync(join(projectADir, "README.md"), "# Project A");
    execSync("git add README.md", { cwd: projectADir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: projectADir, stdio: "pipe" });

    projectBDir = join(tmpDir, "project-b");
    mkdirSync(projectBDir, { recursive: true });
    execSync("git init", { cwd: projectBDir, stdio: "pipe" });
    execSync("git config user.email test@test.com", { cwd: projectBDir, stdio: "pipe" });
    execSync("git config user.name Test", { cwd: projectBDir, stdio: "pipe" });
    execSync("git remote add origin https://github.com/org/project-b.git", { cwd: projectBDir, stdio: "pipe" });
    writeFileSync(join(projectBDir, "README.md"), "# Project B");
    execSync("git add README.md", { cwd: projectBDir, stdio: "pipe" });
    execSync("git commit -m init", { cwd: projectBDir, stdio: "pipe" });
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // Cross-project isolation
  // ==========================================================================

  it("no cross-project leak — project-isolated memories (BM25)", async () => {
    const derivA = deriveScopes({ cwd: projectADir });
    const projectATag = derivA.tags.find(t => t.startsWith("project:"))!;
    const idA = "e2e-a-" + Date.now();
    const textA = "Project A architecture uses microservices";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'fact', 'project-only', 0.5, ?, '{}', ?)
    `).run(idA, textA, Date.now(), createHash("sha256").update(textA).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(idA, projectATag);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + idA, new Float32Array(seedVec(textA.length))
    );

    const derivB = deriveScopes({ cwd: projectBDir });
    const projectBTag = derivB.tags.find(t => t.startsWith("project:"))!;
    const idB = "e2e-b-" + Date.now();
    const textB = "Project B database uses Postgres";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'fact', 'project-only', 0.5, ?, '{}', ?)
    `).run(idB, textB, Date.now(), createHash("sha256").update(textB).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(idB, projectBTag);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + idB, new Float32Array(seedVec(textB.length))
    );

    store.rebuildFtsIndex();

    // Recall from project A context
    const resultsA = store.bm25Search("architecture", 10, [projectATag]);
    const textsA = (await resultsA).map(r => r.entry.text);
    assert.ok(textsA.includes(textA), "should find project A memory");
    assert.ok(!textsA.includes(textB), "should NOT leak project B memory");

    // Recall from project B context
    const resultsB = store.bm25Search("database", 10, [projectBTag]);
    const textsB = (await resultsB).map(r => r.entry.text);
    assert.ok(textsB.includes(textB), "should find project B memory");
    assert.ok(!textsB.includes(textA), "should NOT leak project A memory");
  });

  it("global memories surface in all projects", async () => {
    const derivA = deriveScopes({ cwd: projectADir });
    const projectATag = derivA.tags.find(t => t.startsWith("project:"))!;
    const derivB = deriveScopes({ cwd: projectBDir });
    const projectBTag = derivB.tags.find(t => t.startsWith("project:"))!;

    const id = "e2e-global-" + Date.now();
    const text = "User prefers dark mode across all editors";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'preference', 'global', 0.5, ?, '{}', ?)
    `).run(id, text, Date.now(), createHash("sha256").update(text).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id, new Float32Array(seedVec(text.length))
    );
    store.rebuildFtsIndex();

    const resultsA = await store.bm25Search("dark mode", 10, ["global", projectATag]);
    assert.ok(resultsA.some(r => r.entry.text.includes("dark mode")), "should surface in project A");

    const resultsB = await store.bm25Search("dark mode", 10, ["global", projectBTag]);
    assert.ok(resultsB.some(r => r.entry.text.includes("dark mode")), "should surface in project B");
  });

  it("project-only memory does not surface via global filter alone", async () => {
    const derivA = deriveScopes({ cwd: projectADir });
    const projectTag = derivA.tags.find(t => t.startsWith("project:"))!;

    const id = "e2e-proj-only-" + Date.now();
    const text = "Secret project A deployment key is xyz789";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'fact', 'project-only', 0.5, ?, '{}', ?)
    `).run(id, text, Date.now(), createHash("sha256").update(text).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, projectTag);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id, new Float32Array(seedVec(text.length))
    );
    store.rebuildFtsIndex();

    const results = await store.bm25Search("deployment", 10, ["global"]);
    assert.ok(!results.some(r => r.entry.text.includes("xyz789")),
      "project-only memory should not surface with global-only filter");
  });

  // ==========================================================================
  // Client scoping
  // ==========================================================================

  it("client-scoped memories filter correctly", async () => {
    const now = Date.now();

    const ccId = "e2e-cc-" + now;
    const ccText = "Claude Code keybindings use vim mode";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'preference', 'client-only', 0.5, ?, '{}', ?)
    `).run(ccId, ccText, now, createHash("sha256").update(ccText).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(ccId, "client:claude-code");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + ccId, new Float32Array(seedVec(ccText.length))
    );

    const cxId = "e2e-cx-" + now;
    const cxText = "Codex keybindings use emacs mode";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'preference', 'client-only', 0.5, ?, '{}', ?)
    `).run(cxId, cxText, now, createHash("sha256").update(cxText).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(cxId, "client:codex");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + cxId, new Float32Array(seedVec(cxText.length))
    );
    store.rebuildFtsIndex();

    const ccResults = await store.bm25Search("keybindings", 10, ["client:claude-code"]);
    const ccTexts = ccResults.map(r => r.entry.text);
    assert.ok(ccTexts.includes(ccText), "should find Claude Code memory");
    assert.ok(!ccTexts.includes(cxText), "should NOT leak Codex memory");

    const cxResults = await store.bm25Search("keybindings", 10, ["client:codex"]);
    const cxTexts = cxResults.map(r => r.entry.text);
    assert.ok(cxTexts.includes(cxText), "should find Codex memory");
    assert.ok(!cxTexts.includes(ccText), "should NOT leak Claude Code memory");
  });

  // ==========================================================================
  // Session scoping
  // ==========================================================================

  it("session-scoped memories filter correctly", async () => {
    const now = Date.now();
    const sid1 = "sess-abc-123";
    const sid2 = "sess-xyz-789";

    const id1 = "e2e-s1-" + now;
    const text1 = "Discussed deployment strategy for v2.0";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'fact', 'session-only', 0.5, ?, '{}', ?)
    `).run(id1, text1, now, createHash("sha256").update(text1).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id1, "session:00000000:" + sid1);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id1, new Float32Array(seedVec(text1.length))
    );

    const id2 = "e2e-s2-" + now;
    const text2 = "Discussed caching layer for API";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'fact', 'session-only', 0.5, ?, '{}', ?)
    `).run(id2, text2, now, createHash("sha256").update(text2).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id2, "session:00000000:" + sid2);
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id2, new Float32Array(seedVec(text2.length))
    );
    store.rebuildFtsIndex();

    const s1Results = await store.bm25Search("discussed", 10, ["session:00000000:" + sid1]);
    const s1Texts = s1Results.map(r => r.entry.text);
    assert.ok(s1Texts.some(t => t.includes("deployment")), "should find session 1 memory");
    assert.ok(!s1Texts.some(t => t.includes("caching")), "should NOT leak session 2");

    const s2Results = await store.bm25Search("discussed", 10, ["session:00000000:" + sid2]);
    const s2Texts = s2Results.map(r => r.entry.text);
    assert.ok(s2Texts.some(t => t.includes("caching")), "should find session 2 memory");
    assert.ok(!s2Texts.some(t => t.includes("deployment")), "should NOT leak session 1");
  });

  // ==========================================================================
  // Agent scoping
  // ==========================================================================

  it("agent-scoped memories filter correctly", async () => {
    const now = Date.now();

    const id1 = "e2e-ag1-" + now;
    const text1 = "Dev-assistant uses Python 3.12";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'preference', 'agent-only', 0.5, ?, '{}', ?)
    `).run(id1, text1, now, createHash("sha256").update(text1).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id1, "agent:dev-assistant");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id1, new Float32Array(seedVec(text1.length))
    );

    const id2 = "e2e-ag2-" + now;
    const text2 = "QA-bot uses pytest 8.0";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'preference', 'agent-only', 0.5, ?, '{}', ?)
    `).run(id2, text2, now, createHash("sha256").update(text2).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id2, "agent:qa-bot");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id2, new Float32Array(seedVec(text2.length))
    );
    store.rebuildFtsIndex();

    const devResults = await store.bm25Search("Python pytest", 10, ["agent:dev-assistant"]);
    const devTexts = devResults.map(r => r.entry.text);
    assert.ok(devTexts.some(t => t.includes("Python")), "should find dev-assistant memory");
    assert.ok(!devTexts.some(t => t.includes("pytest")), "should NOT leak qa-bot memory");

    const qaResults = await store.bm25Search("Python pytest", 10, ["agent:qa-bot"]);
    const qaTexts = qaResults.map(r => r.entry.text);
    assert.ok(qaTexts.some(t => t.includes("pytest")), "should find qa-bot memory");
    assert.ok(!qaTexts.some(t => t.includes("Python")), "should NOT leak dev-assistant memory");
  });

  // ==========================================================================
  // Sparse behavior
  // ==========================================================================

  it("sparse: memory without client tag is client-agnostic", async () => {
    const id = "e2e-no-client-" + Date.now();
    const text = "User uses TypeScript for all new projects";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'preference', 'global', 0.5, ?, '{}', ?)
    `).run(id, text, Date.now(), createHash("sha256").update(text).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id, new Float32Array(seedVec(text.length))
    );
    store.rebuildFtsIndex();

    const results = await store.bm25Search("TypeScript", 10, ["global", "client:any-client"]);
    assert.ok(results.length >= 1, "global memory should surface with any client filter");
  });

  it("sparse: global-only memory is project-agnostic", async () => {
    const derivA = deriveScopes({ cwd: projectADir });
    const projectATag = derivA.tags.find(t => t.startsWith("project:"))!;

    const id = "e2e-no-proj-" + Date.now();
    const text = "Node.js version 22 is LTS";
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp, metadata, text_hash)
      VALUES (?, ?, 'fact', 'global', 0.5, ?, '{}', ?)
    `).run(id, text, Date.now(), createHash("sha256").update(text).digest("hex"));
    store.db.prepare("INSERT INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, "global");
    store.db.prepare("INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)").run(
      "mem_" + id, new Float32Array(seedVec(text.length))
    );
    store.rebuildFtsIndex();

    const results = await store.bm25Search("Node.js", 10, ["global", projectATag]);
    assert.ok(results.length >= 1, "global-only memory should surface in any project");
  });
});

// ============================================================================
// E2E: Dreaming scoping
// ============================================================================

describe("E2E: dreaming respects scope", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-e2e-dream-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dedup: same text under different scope-sets both survive", async () => {
    const text = "Common deployment pattern: blue-green";
    const now = Date.now();

    const idA = "e2e-dedup-a-" + now;
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp)
      VALUES (?, ?, 'fact', 'global', 0.5, ?)
    `).run(idA, text, now - 3600_000);
    for (const tag of ["global", "project:abc123"]) {
      store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(idA, tag);
    }

    const idB = "e2e-dedup-b-" + now;
    store.db.prepare(`
      INSERT INTO memories (id, text, category, scope, importance, timestamp)
      VALUES (?, ?, 'fact', 'global', 0.5, ?)
    `).run(idB, text, now - 1800_000);
    for (const tag of ["global", "project:def456"]) {
      store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(idB, tag);
    }

    assert.equal(store.totalMemories, 2);

    const result = await lightSweep(store);

    assert.equal(result.deduped, 0, "should NOT dedup across different scope-sets");
    assert.equal(store.totalMemories, 2, "both should survive");
  });

  it("dedup: same text under same scope-set deduplicates", async () => {
    const text = "Production uses Kubernetes v1.30";
    const now = Date.now();

    for (let i = 0; i < 2; i++) {
      const id = "e2e-same-scope-" + i + "-" + now;
      store.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp)
        VALUES (?, ?, 'fact', 'global', 0.5, ?)
      `).run(id, text, now - (2 - i) * 3600_000);
      for (const tag of ["global", "project:kubernetes123"]) {
        store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, tag);
      }
    }

    assert.equal(store.totalMemories, 2);

    const result = await lightSweep(store);

    assert.equal(result.deduped, 1, "should dedup within same scope-set");
    assert.equal(store.totalMemories, 1, "one should survive");
  });

  it("reflection learnings inherit single-context tags", async () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      const id = "e2e-reflect-" + i + "-" + now;
      store.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp)
        VALUES (?, ?, 'fact', 'global', 0.7, ?)
      `).run(id, "Important fact " + i + " about deployment", now - i * 86400_000);
      for (const tag of ["global", "project:abc123"]) {
        store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, tag);
      }
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Deployment strategy emphasizes blue-green over canary." } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    try {
      const result = await reflectionSweep(store, {
        endpoint: "http://fake-llm/v1/chat/completions",
        model: "test",
      });

      assert.equal(result.learnings, 1);

      const learning = store.db.prepare(
        "SELECT id FROM memories WHERE category = 'learning'"
      ).get() as { id: string };
      assert.ok(learning, "learning should exist");

      const scopeRows = store.db.prepare(
        "SELECT scope FROM memory_scopes WHERE memory_id = ? ORDER BY scope"
      ).all(learning.id) as { scope: string }[];
      const inheritedScopes = scopeRows.map(r => r.scope);
      assert.ok(inheritedScopes.includes("global"), "learning must have global tag");
      assert.ok(inheritedScopes.includes("project:abc123"),
        "learning must inherit project:abc123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reflection learnings use global-only for mixed-context batch", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const idA = "e2e-mix-a-" + i + "-" + now;
      store.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp)
        VALUES (?, ?, 'fact', 'global', 0.7, ?)
      `).run(idA, "Project ABC fact " + i, now - i * 86400_000);
      for (const tag of ["global", "project:abc123"]) {
        store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(idA, tag);
      }

      const idB = "e2e-mix-b-" + i + "-" + now;
      store.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp)
        VALUES (?, ?, 'fact', 'global', 0.7, ?)
      `).run(idB, "Project DEF fact " + i, now - (i + 5) * 86400_000);
      for (const tag of ["global", "project:def456"]) {
        store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(idB, tag);
      }
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Multiple projects share common deployment patterns." } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });

    try {
      const result = await reflectionSweep(store, {
        endpoint: "http://fake-llm/v1/chat/completions",
        model: "test",
      });

      assert.equal(result.learnings, 1);

      const learning = store.db.prepare(
        "SELECT id FROM memories WHERE category = 'learning'"
      ).get() as { id: string };
      const scopeRows = store.db.prepare(
        "SELECT scope FROM memory_scopes WHERE memory_id = ?"
      ).all(learning.id) as { scope: string }[];
      assert.equal(scopeRows.length, 1, "mixed-context learning should have only 1 scope tag");
      assert.equal(scopeRows[0].scope, "global", "mixed-context learning should have only global tag");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("full dream cycle works with scoped memories", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const id = "e2e-dream-cycle-" + i + "-" + now;
      store.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp)
        VALUES (?, ?, 'fact', 'global', 0.5, ?)
      `).run(id, "Scoped fact " + i, now - i * 10 * 86400_000);
      for (const tag of ["global", "project:myproj"]) {
        store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run(id, tag);
      }
    }

    for (let i = 0; i < 3; i++) {
      store.db.prepare(`
        INSERT INTO memories (id, text, category, scope, importance, timestamp)
        VALUES (?, ?, 'other', 'global', 0.3, ?)
      `).run("e2e-stale-" + i + "-" + now, "Stale fact " + i, now - 100 * 86400_000);
      store.db.prepare("INSERT OR IGNORE INTO memory_scopes (memory_id, scope) VALUES (?, ?)").run("e2e-stale-" + i + "-" + now, "global");
    }

    const result = await runDreamCycle(store, {
      enabled: true,
      phases: { light: true, deep: true, reflection: false },
    });

    assert.ok(result.light, "light sweep should run");
    assert.ok(result.deep, "deep sweep should run");
    assert.equal(result.errors.length, 0, "no errors in dream cycle");
    assert.ok(result.duration_ms >= 0, "should report duration");

    const scopeCount = (store.db.prepare(
      "SELECT COUNT(*) as c FROM memory_scopes"
    ).get() as { c: number }).c;
    assert.ok(scopeCount >= 6, "should have scope tags");
  });
});

// ============================================================================
// E2E: Store -> Recall round-trip with derived scopes
// ============================================================================

describe("E2E: store -> recall round-trip", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-e2e-rt-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function storeScoped(
    text: string,
    tags: string[],
    vector?: number[],
    metadata?: string,
  ): Promise<MemoryEntry> {
    const entry = await store.store({
      text,
      vector: vector || seedVec(text.length),
      category: "fact",
      scope: tags[0] || "global",
      importance: 0.6,
      scopes: tags,
      metadata,
    });
    assert.ok(entry, "store should succeed");
    return entry!;
  }

  it("memory stored with project tag is recalled in that project", async () => {
    const projectTag = "project:aaaa1111bbbb2222";
    await storeScoped("HTTPS certificate renewal uses Certbot",
      ["global", projectTag]);

    const results = await store.vectorSearch(
      seedVec("HTTPS certificate renewal uses Certbot".length),
      5, 0.0, ["global", projectTag],
    );
    assert.ok(results.length >= 1, "should recall via vector search");
    assert.ok(results[0].entry.text.includes("Certbot"));

    store.rebuildFtsIndex();
    const bm25Results = await store.bm25Search("certificate renewal", 5,
      ["global", projectTag]);
    assert.ok(bm25Results.length >= 1, "should recall via BM25");
  });

  it("memory stored with client tag is not recalled with different client filter", async () => {
    const id = "e2e-ccvt-" + Date.now();
    const text = "Claude Code uses vim bindings";
    await storeScoped("Claude Code uses vim bindings", ["client:claude-code"]);
    store.rebuildFtsIndex();

    const results = await store.bm25Search("vim bindings", 10, ["client:codex"]);
    assert.equal(results.length, 0,
      "client-specific memory should not surface for different client");
  });

  it("list() respects tag-intersection", async () => {
    await storeScoped("Item in project A", ["global", "project:list-a"]);
    await storeScoped("Item in project B", ["global", "project:list-b"]);

    const resultsA = await store.list(["project:list-a"]);
    const textsA = resultsA.map(r => r.text);
    assert.ok(textsA.some(t => t.includes("project A")));
    assert.ok(!textsA.some(t => t.includes("project B")));
  });

  it("stats() respects tag-intersection", async () => {
    await storeScoped("Stats A", ["global", "project:stats-a"]);
    await storeScoped("Stats B", ["global", "project:stats-b"]);

    const statsA = await store.stats(["project:stats-a"]);
    assert.equal(statsA.totalCount, 1, "stats should filter by project");

    const statsAll = await store.stats(["global"]);
    assert.equal(statsAll.totalCount, 2, "global filter should see both");
  });

  it("bulkDelete() respects tag-intersection", async () => {
    await storeScoped("Delete A", ["global", "project:bulk-a"]);
    await storeScoped("Delete B", ["global", "project:bulk-b"]);

    const deleted = await store.bulkDelete(["project:bulk-a"]);
    assert.equal(deleted, 1, "should delete only one memory");

    const remaining = await store.list(["project:bulk-b"]);
    assert.equal(remaining.length, 1, "other should remain");
  });

  it("update() respects tag-intersection for permission check", async () => {
    const entry = await storeScoped("Update me", ["global", "project:updatable"]);
    const isolated = await storeScoped("Don't touch me", ["project:other-isolated"]);

    const updated = await store.update(entry.id,
      { text: "Updated text" }, ["project:updatable"]);
    assert.ok(updated, "update should succeed");

    await assert.rejects(
      async () => {
        await store.update(isolated.id, { text: "hacked" }, ["project:updatable"]);
      },
      /outside accessible scopes/,
      "should reject update when tags don't intersect"
    );
  });

  it("delete() respects tag-intersection for permission check", async () => {
    const deletable = await storeScoped("Delete me", ["global", "project:del-me"]);
    const protectedMem = await storeScoped("Protected memory", ["project:different"]);

    const deletedOk = await store.delete(deletable.id, ["project:del-me"]);
    assert.equal(deletedOk, true);

    await assert.rejects(
      async () => {
        await store.delete(protectedMem.id, ["project:del-me"]);
      },
      /outside accessible scopes/,
      "should reject delete when tags don't intersect"
    );
  });

  it("provenance metadata preserved through store and recall", async () => {
    const meta = JSON.stringify({
      cwd_hash: "abc123",
      device_id: "device-00ff",
      project_root: "root-01ee",
      captured_at: Date.now(),
      source: "agent",
    });

    const entry = await storeScoped(
      "Memory with provenance",
      ["global", "project:prov"],
      undefined,
      meta,
    );

    const stored = JSON.parse(entry.metadata || "{}");
    assert.equal(stored.cwd_hash, "abc123");
    assert.equal(stored.device_id, "device-00ff");
    assert.equal(stored.project_root, "root-01ee");
    assert.equal(stored.source, "agent");
  });
});
