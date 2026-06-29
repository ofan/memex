/**
 * Tools Scoping Regression Tests
 *
 * TDD regression tests for bugs found in code review of the memory-scoping
 * implementation. Each test MUST fail before the fix and pass after.
 *
 * Bug 1: memory_recall destructures scopes/agent_id/session_id but never
 *        passes them to any recall code path — scoped recall is dead code.
 * Bug 2: memory_recall uses scopeManager.getAccessibleScopes() (static, no
 *        project) instead of deriveScopes() — project-scoped recall broken.
 * Bug 3: memory_update unconditionally sets metadata={source:'agent'},
 *        DISCARDING all provenance (device_id, project_root, etc.)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { MemoryStore } from "../src/memory.js";
import { MemoryScopeManager } from "../src/scopes.js";
import { MemoryRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../src/retriever.js";
import type { Embedder } from "../src/embedder.js";
import type { MemoryEntry } from "../src/memory.js";
import { registerMemoryRecallTool, registerMemoryStoreTool, registerMemoryUpdateTool } from "../src/tools.js";
import { deriveScopes } from "../src/scope-derive.js";

const DIM = 4;

function seedVec(seed: number, dim: number = DIM): number[] {
  const v = Array.from({ length: dim }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function makeFakeEmbedder(): Embedder {
  const embed = (text: string): number[] => seedVec(text.length);
  return {
    dimensions: DIM,
    embedQuery: async (t: string) => embed(t),
    embedPassage: async (t: string) => embed(t),
    embed: async (t: string) => embed(t),
    embedBatch: async (ts: string[]) => ts.map(embed),
    embedBatchQuery: async (ts: string[]) => ts.map(embed),
    embedBatchPassage: async (ts: string[]) => ts.map(embed),
  } as any;
}

function createMockApi() {
  const tools: Record<string, { name: string; execute: Function }> = {};
  return {
    tools,
    registerTool(def: any, meta?: any) {
      const name = meta?.name || def.name;
      tools[name] = { name, execute: def.execute };
    },
  };
}

function makeContext(store: MemoryStore, embedder: Embedder, scopeManager: MemoryScopeManager, agentId?: string): any {
  const retriever = new MemoryRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    mode: "hybrid",
    rerank: "none",
    minScore: 0.0,
    hardMinScore: 0.0,
    recencyWeight: 0,
    timeDecayHalfLifeDays: 0,
  });
  return { retriever, store, scopeManager, embedder, agentId, track: undefined };
}

// ============================================================================
// Bug 1 & 2: memory_recall scoped recall wiring
// ============================================================================

describe("Bug 1 & 2: memory_recall scoped recall", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let embedder: Embedder;
  let projectADir: string;
  let projectBDir: string;
  let projectATag: string;
  let projectBTag: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-tools-scope-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
    embedder = makeFakeEmbedder();

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

    const derivA = deriveScopes({ cwd: projectADir });
    projectATag = derivA.tags.find((t: string) => t.startsWith("project:"))!;
    const derivB = deriveScopes({ cwd: projectBDir });
    projectBTag = derivB.tags.find((t: string) => t.startsWith("project:"))!;
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function storeWithTags(text: string, tags: string[]): Promise<MemoryEntry> {
    const vec = seedVec(text.length);
    const entry = await store.store({
      text, vector: vec, category: "fact",
      scope: tags[0] || "global", importance: 0.6, scopes: tags,
    });
    assert.ok(entry, `store should succeed for "${text}"`);
    return entry!;
  }

  it("BUG1: explicit scopes filter recall - project A memory NOT in project B recall", async () => {
    await storeWithTags("Project A architecture uses Redis", [projectATag]);
    await storeWithTags("Project B architecture uses Postgres", [projectBTag]);
    store.rebuildFtsIndex();

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryRecallTool(api as any, ctx);

    const result = await api.tools.memory_recall.execute("test-id", {
      query: "architecture", limit: 10, scopes: [projectATag],
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;

    assert.ok(text.includes("Redis") || text.includes("Project A"),
      `Should find project A memory in recall. Got: ${text}`);
    assert.ok(!text.includes("Postgres"),
      `BUG: Project B memory leaked into project A scoped recall. Got: ${text}`);
  });

  it("BUG1: scopes param overrides default scopeFilter", async () => {
    await storeWithTags("Memory for override test - alpha", ["global", "custom:alpha"]);
    await storeWithTags("Memory for override test - beta", ["global", "custom:beta"]);
    store.rebuildFtsIndex();

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryRecallTool(api as any, ctx);

    const result = await api.tools.memory_recall.execute("test-id", {
      query: "override test", limit: 10, scopes: ["custom:alpha"],
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;

    assert.ok(text.includes("alpha"), `Should find alpha memory. Got: ${text}`);
    assert.ok(!text.includes("beta"),
      `BUG: beta memory leaked when scoping to custom:alpha. Got: ${text}`);
  });

  it("BUG1: agent_id derives agent tag and filters recall", async () => {
    await storeWithTags("Dev assistant memory about Python", ["agent:dev-assistant"]);
    await storeWithTags("QA bot memory about testing", ["agent:qa-bot"]);
    store.rebuildFtsIndex();

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager, "dev-assistant");
    registerMemoryRecallTool(api as any, ctx);

    const result = await api.tools.memory_recall.execute("test-id", {
      query: "memory about", limit: 10, agent_id: "dev-assistant",
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;

    assert.ok(text.includes("Python"),
      `Should find dev-assistant memory. Got: ${text}`);
    assert.ok(!text.includes("testing"),
      `BUG: QA bot memory leaked into dev-assistant recall. Got: ${text}`);
  });

  it("BUG1: session_id derives session tag and filters recall", async () => {
    const deriv1 = deriveScopes({ cwd: tmpDir, sessionId: "sess-111" });
    const sessionTag1 = deriv1.tags.find((t: string) => t.startsWith("session:"))!;
    const deriv2 = deriveScopes({ cwd: tmpDir, sessionId: "sess-222" });
    const sessionTag2 = deriv2.tags.find((t: string) => t.startsWith("session:"))!;

    await storeWithTags("Session 1 discussion about deployment", [sessionTag1]);
    await storeWithTags("Session 2 discussion about monitoring", [sessionTag2]);
    store.rebuildFtsIndex();

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryRecallTool(api as any, ctx);

    const result = await api.tools.memory_recall.execute("test-id", {
      query: "discussion about", limit: 10, session_id: "sess-111",
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const text = content[0].text;

    assert.ok(text.includes("deployment"),
      `Should find session 1 memory. Got: ${text}`);
    assert.ok(!text.includes("monitoring"),
      `BUG: Session 2 memory leaked into session 1 recall. Got: ${text}`);
  });

  it("BUG2: recall derives project tag from cwd, not just getAccessibleScopes", async () => {
    await storeWithTags("Project A specifics: uses Fastify", [projectATag]);
    await storeWithTags("Project B specifics: uses Express", [projectBTag]);
    store.rebuildFtsIndex();

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryRecallTool(api as any, ctx);

    const origCwd = process.cwd;
    try {
      process.cwd = () => projectADir;

      const result = await api.tools.memory_recall.execute("test-id", {
        query: "specifics uses", limit: 10,
      });

      const content = result.content as Array<{ type: string; text: string }>;
      const details = result.details as any;
      const text = content[0].text;

      const scopes = details?.scopes;
      if (scopes) {
        assert.ok(scopes.includes(projectATag) || scopes.includes("global"),
          `BUG: scope filter missing project tag. Got: ${JSON.stringify(scopes)}`);
      }

      assert.ok(text.includes("Fastify") || text.includes("Project A"),
        `Should find project A memory via derived project scope. Got: ${text}`);
      assert.ok(!text.includes("Express"),
        `BUG: Project B memory leaked. Got: ${text}`);
    } finally {
      process.cwd = origCwd;
    }
  });

  it("BUG2: store/recall symmetry - both use deriveScopes", async () => {
    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const origCwd = process.cwd;

    try {
      process.cwd = () => projectADir;
      const ctx = makeContext(store, embedder, scopeManager);

      registerMemoryStoreTool(api as any, ctx);
      registerMemoryRecallTool(api as any, ctx);

      const storeResult = await api.tools.memory_store.execute("store-1", {
        text: "Symmetry test: project A deployment uses Docker",
        category: "fact", importance: 0.7,
      });

      const storeContent = storeResult.content as Array<{ type: string; text: string }>;
      assert.ok(storeContent[0].text.includes("Stored"), "Store should succeed");

      store.rebuildFtsIndex();

      const recallResult = await api.tools.memory_recall.execute("recall-1", {
        query: "deployment Docker", limit: 10,
      });

      const recallContent = recallResult.content as Array<{ type: string; text: string }>;
      const text = recallContent[0].text;

      assert.ok(text.includes("Docker") || text.includes("Symmetry"),
        `BUG: recall/store asymmetry. Got: ${text}`);
    } finally {
      process.cwd = origCwd;
    }
  });
});

// ============================================================================
// Bug 3: memory_update discards provenance metadata
// ============================================================================

describe("Bug 3: memory_update preserves provenance metadata", () => {
  let tmpDir: string;
  let store: MemoryStore;
  let embedder: Embedder;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mem-tools-update-"));
    store = new MemoryStore({ dbPath: join(tmpDir, "test.sqlite"), vectorDim: DIM });
    embedder = makeFakeEmbedder();
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("BUG3: preserves device_id, project_root, git_remote, git_branch, client, captured_at, entities", async () => {
    const provenanceMeta = JSON.stringify({
      device_id: "abc123device",
      project_root: "def456root",
      git_remote: "https://github.com/org/repo",
      git_branch: "main",
      client: "claude-code",
      captured_at: Date.now(),
      entities: ["entity1", "entity2"],
    });

    const entry = await store.store({
      text: "Memory with rich provenance",
      vector: seedVec(42), category: "fact", scope: "global",
      importance: 0.6, scopes: ["global"], metadata: provenanceMeta,
    });
    assert.ok(entry, "store should succeed");

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryUpdateTool(api as any, ctx);

    const result = await api.tools.memory_update.execute("update-1", {
      memoryId: entry.id, importance: 0.9,
    });

    const content = result.content as Array<{ type: string; text: string }>;
    assert.ok(content[0].text.includes("Updated"), "Update should succeed");

    const row = store.db.prepare(
      "SELECT metadata FROM memories WHERE id = ?"
    ).get(entry.id) as { metadata: string };
    const meta = JSON.parse(row.metadata || "{}");

    assert.equal(meta.source, "agent", "source should be set to 'agent'");
    assert.equal(meta.device_id, "abc123device",
      `BUG3: device_id was discarded. Got: ${JSON.stringify(meta)}`);
    assert.equal(meta.project_root, "def456root",
      `BUG3: project_root was discarded. Got: ${JSON.stringify(meta)}`);
    assert.equal(meta.git_remote, "https://github.com/org/repo",
      `BUG3: git_remote was discarded. Got: ${JSON.stringify(meta)}`);
    assert.equal(meta.git_branch, "main",
      `BUG3: git_branch was discarded. Got: ${JSON.stringify(meta)}`);
    assert.equal(meta.client, "claude-code",
      `BUG3: client was discarded. Got: ${JSON.stringify(meta)}`);
    assert.ok(meta.captured_at != null,
      `BUG3: captured_at was discarded. Got: ${JSON.stringify(meta)}`);
    assert.ok(Array.isArray(meta.entities) && meta.entities.length > 0,
      `BUG3: entities were discarded. Got: ${JSON.stringify(meta)}`);
  });

  it("BUG3: sets source:'agent' on memories with no prior metadata", async () => {
    const entry = await store.store({
      text: "Memory with no metadata at all",
      vector: seedVec(99), category: "fact", scope: "global",
      importance: 0.5, scopes: ["global"],
    });
    assert.ok(entry, "store should succeed");

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryUpdateTool(api as any, ctx);

    const result = await api.tools.memory_update.execute("update-2", {
      memoryId: entry.id, importance: 0.8,
    });

    const content = result.content as Array<{ type: string; text: string }>;
    assert.ok(content[0].text.includes("Updated"), "Update should succeed");

    const row = store.db.prepare(
      "SELECT metadata FROM memories WHERE id = ?"
    ).get(entry.id) as { metadata: string };
    const meta = JSON.parse(row.metadata || "{}");
    assert.equal(meta.source, "agent",
      "source should be set to 'agent' even on previously-empty metadata");
  });

  it("BUG3: preserves metadata when text is updated (re-embedding path)", async () => {
    const provenanceMeta = JSON.stringify({
      device_id: "device-xyz",
      project_root: "prj-abc",
      captured_at: Date.now(),
      source: "import",
    });

    const entry = await store.store({
      text: "Original text for provenance test",
      vector: seedVec(77), category: "fact", scope: "global",
      importance: 0.6, scopes: ["global"], metadata: provenanceMeta,
    });
    assert.ok(entry, "store should succeed");

    const api = createMockApi();
    const scopeManager = new MemoryScopeManager();
    const ctx = makeContext(store, embedder, scopeManager);
    registerMemoryUpdateTool(api as any, ctx);

    const result = await api.tools.memory_update.execute("update-3", {
      memoryId: entry.id, text: "Updated text with preserved provenance",
    });

    const content = result.content as Array<{ type: string; text: string }>;
    assert.ok(content[0].text.includes("Updated"), "Text update should succeed");

    const row = store.db.prepare(
      "SELECT metadata FROM memories WHERE id = ?"
    ).get(entry.id) as { metadata: string };
    const meta = JSON.parse(row.metadata || "{}");

    assert.equal(meta.source, "agent", "source should be upgraded to 'agent'");
    assert.equal(meta.device_id, "device-xyz",
      `BUG3: device_id lost in text-update path. Got: ${JSON.stringify(meta)}`);
    assert.equal(meta.project_root, "prj-abc",
      `BUG3: project_root lost in text-update path. Got: ${JSON.stringify(meta)}`);
    assert.ok(meta.captured_at != null,
      `BUG3: captured_at lost in text-update path. Got: ${JSON.stringify(meta)}`);
  });
});
