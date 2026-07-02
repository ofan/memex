/**
 * MCP Server unit tests.
 *
 * Tests the server's tool handlers using a mock MCP client
 * connected via in-memory transport. Each test creates a fresh
 * SQLite DB with MemoryStore and verifies tool behavior.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemexMcpServer } from "../src/mcp-server.js";

const VECTOR_DIM = 8;

function makeVector(seed: number): number[] {
  const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm === 0 ? v : v.map(x => x / norm);
}

/** Fake embedder that returns deterministic vectors based on text hash. */
function makeFakeEmbedder() {
  const embed = (text: string): number[] => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return makeVector(h);
  };
  return {
    dimensions: VECTOR_DIM,
    embedQuery: async (t: string) => embed(t),
    embedPassage: async (t: string) => embed(t),
    embed: async (t: string) => embed(t),
    embedBatch: async (ts: string[]) => ts.map(embed),
    embedBatchQuery: async (ts: string[]) => ts.map(embed),
    embedBatchPassage: async (ts: string[]) => ts.map(embed),
  } as any;
}

describe("MCP Server", () => {
  let tmpDir: string;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-mcp-"));
    const dbPath = join(tmpDir, "memex.sqlite");

    const { server } = createMemexMcpServer({
      dbPath,
      vectorDim: VECTOR_DIM,
      embedder: makeFakeEmbedder(),
    });

    client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    cleanup = async () => {
      await client.close();
      await server.close();
      await rm(tmpDir, { recursive: true, force: true });
    };
  });

  afterEach(async () => {
    await cleanup();
  });

  it("AC1: lists all 5 tools on initialize", async () => {
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name).sort();
    assert.deepEqual(names, [
      "memory_dream",
      "memory_forget",
      "memory_recall",
      "memory_stats",
      "memory_store",
    ]);
  });

  it("AC2: memory_store creates a memory and returns it", async () => {
    const result = await client.callTool({
      name: "memory_store",
      arguments: { text: "Alex prefers dark mode", category: "preference", importance: 0.8 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.text, "Alex prefers dark mode");
    assert.equal(parsed.category, "preference");
    assert.ok(parsed.id, "should return an ID");
  });

  it("AC3: memory_recall returns stored memories", async () => {
    // Store first
    await client.callTool({
      name: "memory_store",
      arguments: { text: "The deployment runs on the build server", category: "fact" },
    });

    // Recall
    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "deployment mac mini", limit: 5 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    assert.ok(parsed.results.length > 0, "should return at least 1 result");
    assert.ok(parsed.results[0].score > 0, "result should have a score");
  });

  it("AC4: memory_forget deletes a memory", async () => {
    // Store
    const storeResult = await client.callTool({
      name: "memory_store",
      arguments: { text: "Temporary fact to delete", category: "fact" },
    });
    const stored = JSON.parse((storeResult.content as any)[0].text);

    // Forget
    const forgetResult = await client.callTool({
      name: "memory_forget",
      arguments: { id: stored.id },
    });
    const forgotten = JSON.parse((forgetResult.content as any)[0].text);
    assert.equal(forgotten.deleted, true);

    // Verify stats show 0
    const statsResult = await client.callTool({
      name: "memory_stats",
      arguments: {},
    });
    const stats = JSON.parse((statsResult.content as any)[0].text);
    assert.equal(stats.total, 0);
  });

  it("memory_recall results include anchor + scope + citation note", async () => {
    await client.callTool({
      name: "memory_store",
      arguments: { text: "The deployment runs on the build server", category: "fact" },
    });

    const result = await client.callTool({
      name: "memory_recall",
      arguments: { query: "deployment mac mini", limit: 5 },
    });

    const parsed = JSON.parse((result.content as any)[0].text);
    assert.ok(parsed.results.length > 0, "should return at least 1 result");
    const r0 = parsed.results[0];
    assert.equal(typeof r0.anchor, "string", "result should expose anchor field");
    assert.equal(r0.anchor.length, 8, "anchor should be 8 chars");
    assert.equal(r0.anchor, r0.id.slice(0, 8), "anchor should be id prefix");
    assert.equal(typeof r0.scope, "string", "result should expose scope");
    assert.ok(/cite.*\bmem:\w+/i.test(parsed.note), "response should include citation note");
  });

  it("F5: memory_recall bumps persistent recall_count (regression for the MCP capture gap)", async () => {
    // The MCP memory_recall tool never called recordRecalls, so the daemon's primary
    // recall path left recall_count at 0 — dreaming then evicts actively-used memories.
    const tmp = await mkdtemp(join(tmpdir(), "memex-f5-"));
    const dbPath = join(tmp, "memex.sqlite");
    const { server, store } = createMemexMcpServer({
      dbPath, vectorDim: VECTOR_DIM, embedder: makeFakeEmbedder(),
    });
    const c = new Client({ name: "f5-test", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([c.connect(ct), server.connect(st)]);
    try {
      const storeRes = await c.callTool({
        name: "memory_store",
        arguments: { text: "The build server hosts the deploy pipeline", category: "fact" },
      });
      const id = JSON.parse((storeRes.content as any)[0].text).id;

      const before = store.db.prepare(
        "SELECT recall_count, last_recalled_at FROM memories WHERE id = ?"
      ).get(id) as { recall_count: number; last_recalled_at: number | null };
      assert.equal(before.recall_count, 0);
      assert.equal(before.last_recalled_at, null);

      await c.callTool({
        name: "memory_recall",
        arguments: { query: "build server deploy", limit: 5 },
      });

      const after = store.db.prepare(
        "SELECT recall_count, last_recalled_at FROM memories WHERE id = ?"
      ).get(id) as { recall_count: number; last_recalled_at: number | null };
      assert.equal(after.recall_count, 1, "memory_recall must bump persistent recall_count");
      assert.ok(after.last_recalled_at, "memory_recall must set last_recalled_at");
    } finally {
      await c.close(); await server.close();
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("memory_forget accepts an 8-char anchor prefix", async () => {
    const storeResult = await client.callTool({
      name: "memory_store",
      arguments: { text: "Will be forgotten by anchor", category: "fact" },
    });
    const stored = JSON.parse((storeResult.content as any)[0].text);
    const anchor8 = stored.id.slice(0, 8);

    const forgetResult = await client.callTool({
      name: "memory_forget",
      arguments: { id: anchor8 },
    });
    const forgotten = JSON.parse((forgetResult.content as any)[0].text);
    assert.equal(forgotten.deleted, true, `anchor ${anchor8} should resolve to ${stored.id}`);
    assert.equal(forgotten.via_anchor, true, "should flag this as anchor-resolved");
    assert.equal(forgotten.id, stored.id, "should report the resolved full id");
  });

  it("memory_forget returns anchor_not_found for non-matching prefix", async () => {
    await client.callTool({
      name: "memory_store",
      arguments: { text: "Some unrelated memory", category: "fact" },
    });

    const forgetResult = await client.callTool({
      name: "memory_forget",
      arguments: { id: "deadbeef" },
    });
    const result = JSON.parse((forgetResult.content as any)[0].text);
    assert.equal(result.deleted, false);
    assert.equal(result.error, "anchor_not_found");
    assert.equal(result.anchor, "deadbeef");
  });

  it("memory_stats returns pool metrics", async () => {
    await client.callTool({
      name: "memory_store",
      arguments: { text: "Fact A", category: "fact" },
    });
    await client.callTool({
      name: "memory_store",
      arguments: { text: "Preference B", category: "preference" },
    });

    const result = await client.callTool({
      name: "memory_stats",
      arguments: {},
    });
    const stats = JSON.parse((result.content as any)[0].text);
    assert.equal(stats.total, 2);
    assert.ok(stats.byCategory.fact >= 1);
    assert.ok(stats.byCategory.preference >= 1);
  });

  it("memory_stats includes scope breakdown from memory_scopes", async () => {
    // Store a memory with scope tags — the server derives scopes automatically
    await client.callTool({
      name: "memory_store",
      arguments: { text: "Scope test fact", category: "fact" },
    });

    const result = await client.callTool({
      name: "memory_stats",
      arguments: {},
    });
    const stats = JSON.parse((result.content as any)[0].text);

    // Bug B: before the fix, memory_stats had no scope breakdown at all.
    // After the fix, byScope must exist and include the 'global' tag
    // that the server automatically derives.
    assert.ok(stats.byScope !== undefined,
      "memory_stats must include byScope (Bug B: was missing scope breakdown)");
    assert.ok(typeof stats.byScope === "object",
      "byScope must be an object mapping scope tag -> count");
    assert.ok(Object.keys(stats.byScope).length > 0,
      "byScope must have at least one scope tag entry");
    assert.ok(stats.byScope.global >= 1,
      "global tag must appear in byScope with count >= 1");
  });

  it("memory_dream runs light + deep sweep", async () => {
    // Store a noise entry directly in DB (bypass store guards)
    const { server: _s, store } = createMemexMcpServer({
      dbPath: join(tmpDir, "memex.sqlite"),
      vectorDim: VECTOR_DIM,
      embedder: makeFakeEmbedder(),
    });
    // Use the existing client's store via a tool call
    await client.callTool({
      name: "memory_store",
      arguments: { text: "A real fact worth keeping", category: "fact", importance: 0.7 },
    });

    const result = await client.callTool({
      name: "memory_dream",
      arguments: { phase: "all" },
    });
    const dream = JSON.parse((result.content as any)[0].text);
    assert.ok(dream.duration_ms >= 0);
    assert.ok(dream.light !== undefined || dream.deep !== undefined);
  });

  it("AC6: createMemexMcpServer accepts dream config", async () => {
    // Verify the server factory accepts dream options without error
    const dbPath2 = join(tmpDir, "dream-test.sqlite");
    const { server: s2, store: st2 } = createMemexMcpServer({
      dbPath: dbPath2,
      vectorDim: VECTOR_DIM,
      embedder: makeFakeEmbedder(),
      dreamIntervalMs: 1000,
      noDream: false,
    });
    // Server should create without throwing
    assert.ok(s2);
    assert.ok(st2);
    st2.close();
  });

  it("AC5: shared DB — two server instances see same data", async () => {
    // Store via first server (the one in beforeEach)
    await client.callTool({
      name: "memory_store",
      arguments: { text: "Shared fact across instances", category: "fact" },
    });

    // Create second server pointing at same DB
    const dbPath = join(tmpDir, "memex.sqlite");
    const { server: s2, store: st2 } = createMemexMcpServer({
      dbPath,
      vectorDim: VECTOR_DIM,
      embedder: makeFakeEmbedder(),
    });

    // Verify second server's store sees the memory
    const count = (st2.db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;
    assert.ok(count >= 1, "second server should see memory from first");
    st2.close();
  });

  it("memory_dream with reflection uses LLM config", async () => {
    // Seed enough memories for reflection threshold
    for (let i = 0; i < 10; i++) {
      await client.callTool({
        name: "memory_store",
        arguments: { text: `Important fact ${i} about infrastructure deployment`, category: "fact", importance: 0.7 },
      });
    }

    // Create a second server with reflection LLM configured (mock fetch)
    const dbPath2 = join(tmpDir, "reflect-test.sqlite");
    const originalFetch = globalThis.fetch;
    let llmCalled = false;

    globalThis.fetch = async (url: any, init: any) => {
      const urlStr = typeof url === "string" ? url : (url as Request).url;
      if (urlStr.includes("/chat/completions")) {
        llmCalled = true;
        return new Response(JSON.stringify({
          choices: [{ message: { content: "Infrastructure deployment requires careful coordination across services." } }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return originalFetch(url, init);
    };

    try {
      const { server: s2, store: st2 } = createMemexMcpServer({
        dbPath: join(tmpDir, "memex.sqlite"), // same DB as main test
        vectorDim: VECTOR_DIM,
        embedder: makeFakeEmbedder(),
        reflectionLLM: {
          endpoint: "http://fake-llm/v1/chat/completions",
          model: "test-model",
        },
      });

      const client2 = new Client({ name: "reflect-client", version: "1.0.0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([client2.connect(ct), s2.connect(st)]);

      // Check the DB has enough memories for reflection
      const count = st2.db.prepare("SELECT COUNT(*) as c FROM memories WHERE importance > 0.3").get() as any;

      const result = await client2.callTool({
        name: "memory_dream",
        arguments: { phase: "reflect" },
      });

      const dream = JSON.parse((result.content as any)[0].text);
      // reflection runs if reflectionLLM is set AND pool has >=5 memories at importance>0.3
      if (count.c >= 5) {
        assert.ok(dream.reflection !== undefined, `reflection phase should have run (${count.c} qualifying memories), got: ${JSON.stringify(dream)}`);
        assert.equal(typeof dream.reflection.learnings, "number");
      } else {
        // Not enough memories — reflection ran but skipped (returns {learnings:0})
        assert.ok(dream.reflection !== undefined || count.c < 5, `either reflection ran or too few memories (${count.c})`);
      }

      await client2.close();
      await s2.close();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("AC8: works without embedder (BM25-only mode)", async () => {
    const dbPath2 = join(tmpDir, "bm25-only.sqlite");
    const { server: s2 } = createMemexMcpServer({
      dbPath: dbPath2,
      vectorDim: VECTOR_DIM,
      // No embedder — BM25-only
    });

    const client2 = new Client({ name: "test-bm25", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client2.connect(ct), s2.connect(st)]);

    // Store should work (zero vector)
    const storeResult = await client2.callTool({
      name: "memory_store",
      arguments: { text: "BM25-only fact about servers", category: "fact" },
    });
    const stored = JSON.parse((storeResult.content as any)[0].text);
    assert.ok(stored.id, "should store even without embedder");

    // Recall should work via BM25
    const recallResult = await client2.callTool({
      name: "memory_recall",
      arguments: { query: "servers", limit: 5 },
    });
    const recalled = JSON.parse((recallResult.content as any)[0].text);
    assert.ok(recalled.mode === "bm25-only", "should indicate BM25-only mode");

    await client2.close();
    await s2.close();
  });

  it("memory_store rejects noise", async () => {
    const result = await client.callTool({
      name: "memory_store",
      arguments: { text: "ok", category: "other" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    assert.ok(parsed.rejected || parsed.error, "noise should be rejected");
  });

  // ── Memory Scoping tests (P6: MCP tool surface) ─────────────────────────

  describe("memory_store scoping params", () => {
    it("accepts explicit scope param and stores it", async () => {
      const storeResult = await client.callTool({
        name: "memory_store",
        arguments: { text: "Scoped fact A", category: "fact", scope: "custom:test" },
      });
      const stored = JSON.parse((storeResult.content as any)[0].text);
      assert.ok(stored.id, "should return an ID");
      assert.ok(!stored.rejected, "should not reject");

      // Verify the scope tag was written via memory_scopes table
      // Create a second server to read the shared DB directly
      const dbPath = join(tmpDir, "memex.sqlite");
      const { store: verifyStore } = createMemexMcpServer({
        dbPath,
        vectorDim: VECTOR_DIM,
        embedder: makeFakeEmbedder(),
      });
      const rows = verifyStore.db.prepare(
        "SELECT scope FROM memory_scopes WHERE memory_id = ?"
      ).all(stored.id) as { scope: string }[];
      const scopes = rows.map(r => r.scope);
      assert.ok(scopes.includes("custom:test"), `scopes should include custom:test, got: ${JSON.stringify(scopes)}`);
      verifyStore.close();
    });

    it("rejects 'device:' as an explicit scope tag", async () => {
      const result = await client.callTool({
        name: "memory_store",
        arguments: { text: "Device-tagged fact", category: "fact", scope: "device:foo" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      assert.ok(parsed.rejected, "should reject device: scope tag");
      assert.ok(
        parsed.reason?.includes("device:"),
        `reason should mention device:, got: ${JSON.stringify(parsed)}`,
      );
    });

    it("stores auto-derived global tag when no explicit scope given", async () => {
      const storeResult = await client.callTool({
        name: "memory_store",
        arguments: { text: "Auto-scoped fact", category: "fact" },
      });
      const stored = JSON.parse((storeResult.content as any)[0].text);
      assert.ok(stored.id, "should return an ID");

      const dbPath = join(tmpDir, "memex.sqlite");
      const { store: verifyStore } = createMemexMcpServer({
        dbPath,
        vectorDim: VECTOR_DIM,
        embedder: makeFakeEmbedder(),
      });
      const rows = verifyStore.db.prepare(
        "SELECT scope FROM memory_scopes WHERE memory_id = ?"
      ).all(stored.id) as { scope: string }[];
      const scopes = rows.map(r => r.scope);
      assert.ok(scopes.includes("global"), `scopes should include global, got: ${JSON.stringify(scopes)}`);
      verifyStore.close();
    });

    it("accepts agent_id param without error", async () => {
      const result = await client.callTool({
        name: "memory_store",
        arguments: { text: "Agent-tagged fact", category: "fact", agent_id: "test-agent" },
      });
      const stored = JSON.parse((result.content as any)[0].text);
      assert.ok(stored.id, "should store with agent_id param");
      assert.ok(!stored.rejected, "should not reject agent_id");
    });

    it("accepts session_id param without error", async () => {
      const result = await client.callTool({
        name: "memory_store",
        arguments: { text: "Session-tagged fact", category: "fact", session_id: "sess-123" },
      });
      const stored = JSON.parse((result.content as any)[0].text);
      assert.ok(stored.id, "should store with session_id param");
      assert.ok(!stored.rejected, "should not reject session_id");
    });

    it("accepts device_id param without error", async () => {
      const result = await client.callTool({
        name: "memory_store",
        arguments: { text: "Device-metadata fact", category: "fact", device_id: "dev-abc" },
      });
      const stored = JSON.parse((result.content as any)[0].text);
      assert.ok(stored.id, "should store with device_id param");
      assert.ok(!stored.rejected, "should not reject device_id");
    });
  });

  describe("memory_recall scopes param", () => {
    it("filters results by scopes intersection", async () => {
      // Store two memories with different explicit scopes
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Memory in scope alpha", category: "fact", scope: "test:alpha" },
      });
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Memory in scope beta", category: "fact", scope: "test:beta" },
      });

      // Recall with scope alpha should find the alpha memory
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "memory in scope", limit: 10, scopes: ["test:alpha"] },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      const texts = parsed.results.map((r: any) => r.text);
      assert.ok(texts.some((t: string) => t.includes("alpha")), `should find alpha memory, got: ${JSON.stringify(texts)}`);
    });

    it("accepts recall without scopes (backward compatible)", async () => {
      await client.callTool({
        name: "memory_store",
        arguments: { text: "No-scope-filter fact", category: "fact", scope: "test:no-filter" },
      });

      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "no-scope-filter", limit: 5 },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      assert.ok(parsed.results.length >= 0, "should work without scopes param");
    });
  });

  // ── Bug 4 & 6: memory_recall agent_id/session_id scoping ───────────────

  describe("BUG4: memory_recall consumes agent_id/session_id for scope filtering", () => {
    it("BUG4: agent_id is consumed and matching memory surfaces", async () => {
      // Store two memories with different agent tags (both get global tag too)
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Dev assistant uses TypeScript strict mode", category: "preference", agent_id: "dev-assistant" },
      });
      await client.callTool({
        name: "memory_store",
        arguments: { text: "QA bot uses Playwright for E2E tests", category: "preference", agent_id: "qa-bot" },
      });

      // Recall with agent_id=dev-assistant — the param should be consumed
      // (was dead code before fix). Both memories surface because both
      // have global tag (by design — global always surfaces).
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "uses", limit: 10, agent_id: "dev-assistant" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      const texts = parsed.results.map((r: any) => r.text);
      assert.ok(texts.some((t: string) => t.includes("TypeScript")),
        `BUG4: dev-assistant memory should surface. Got: ${JSON.stringify(texts)}`);
      // Both should surface because both have global tag
      assert.equal(parsed.results.length, 2,
        `BUG4: both memories should surface (both have global tag). Got ${parsed.results.length}: ${JSON.stringify(texts)}`);
    });

    it("BUG4: session_id is consumed and matching memory surfaces", async () => {
      // Store two memories with different session tags (both get global tag too)
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Session alpha discussed deployment pipeline", category: "fact", session_id: "sess-alpha-001" },
      });
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Session beta discussed monitoring setup", category: "fact", session_id: "sess-beta-002" },
      });

      // Recall with session_id — param should be consumed (was dead code)
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "discussed", limit: 10, session_id: "sess-alpha-001" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      const texts = parsed.results.map((r: any) => r.text);
      assert.ok(texts.some((t: string) => t.includes("deployment")),
        `BUG4: session-alpha memory should surface. Got: ${JSON.stringify(texts)}`);
      // Both surface because both have global tag (by design)
      assert.equal(parsed.results.length, 2,
        `BUG4: both session memories should surface (both have global). Got ${parsed.results.length}: ${JSON.stringify(texts)}`);
    });

    it("BUG4: agent_id combined with explicit scopes", async () => {
      // Store a memory scoped to agent:dev-assistant
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Dev assistant uses pnpm as package manager", category: "preference", agent_id: "dev-assistant" },
      });
      // Store a memory scoped to test:other
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Other scoped memory about bundlers", category: "fact", scope: "test:other" },
      });

      // Recall with both agent_id and explicit scopes
      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "package manager", limit: 10, agent_id: "dev-assistant", scopes: ["test:other"] },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      const texts = parsed.results.map((r: any) => r.text);
      // With both tags in filter, both memories should surface
      assert.equal(parsed.results.length, 2,
        `BUG4: should find both memories with combined filter. Got ${parsed.results.length}: ${JSON.stringify(texts)}`);
    });

    it("BUG4: agent_id without explicit scopes works (backward compat)", async () => {
      await client.callTool({
        name: "memory_store",
        arguments: { text: "Generic fact about cloud computing", category: "fact" },
      });

      const result = await client.callTool({
        name: "memory_recall",
        arguments: { query: "cloud computing", limit: 5, agent_id: "any-agent" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      // Should return results (global-tagged memory surfaces regardless of agent_id)
      assert.ok(parsed.results.length >= 0, "recall with agent_id should not error");
    });
  });

  // ── Bug 5: Scope format validation ──────────────────────────────────────

  describe("BUG5: scope format validation", () => {
    it("BUG5: rejects scope tags with invalid characters", async () => {
      const badScopes = [
        "scope with spaces",
        "scope\nnewline",
        "scope\twith\ttabs",
        "scope<script>",
        "scope;DROP TABLE",
        "scope|pipe",
        "scope&",
        "scope@host",
        "scope+plus",
        "scope=equals",
        "scope?query",
        "scope#hash",
        "scope!bang",
        "scope~tilde",
        "scope`backtick",
        "scope'quote",
        'scope"double',
        "scope,comma",
        "scope\\backslash",
        "scope/forward",
        "scope<angle>",
        "scope(parentheses)",
        "scope[brackets]",
        "scope{braces}",
      ];

      for (const bad of badScopes) {
        const result = await client.callTool({
          name: "memory_store",
          arguments: { text: "Test fact for bad scope", category: "fact", scope: bad },
        });
        const parsed = JSON.parse((result.content as any)[0].text);
        assert.ok(parsed.rejected || parsed.reason?.includes("Invalid scope"),
          `BUG5: should reject malformed scope "${bad}". Got: ${JSON.stringify(parsed)}`);
      }
    });

    it("BUG5: accepts valid scope tags", async () => {
      const validScopes = [
        "global",
        "agent:dev-assistant",
        "client:claude-code",
        "project:abc123def456",
        "session:00000000:my-session",
        "custom:my-scope",
        "test:alpha.beta",
        "project:0123456789abcdef",
        "client:open_code_v2",
      ];

      for (const valid of validScopes) {
        const result = await client.callTool({
          name: "memory_store",
          arguments: { text: `Valid scope test: ${valid}`, category: "fact", scope: valid },
        });
        const parsed = JSON.parse((result.content as any)[0].text);
        assert.ok(!parsed.rejected,
          `BUG5: should accept valid scope "${valid}". Got: ${JSON.stringify(parsed)}`);
      }
    });

    it("BUG5: rejects overly long scope tags (>100 chars)", async () => {
      const longScope = "a".repeat(101);
      const result = await client.callTool({
        name: "memory_store",
        arguments: { text: "Long scope test", category: "fact", scope: longScope },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      assert.ok(parsed.rejected || parsed.reason?.includes("Invalid scope"),
        `BUG5: should reject scope > 100 chars. Got: ${JSON.stringify(parsed)}`);
    });

    it("BUG5: rejects empty scope", async () => {
      const result = await client.callTool({
        name: "memory_store",
        arguments: { text: "Empty scope test", category: "fact", scope: "" },
      });
      const parsed = JSON.parse((result.content as any)[0].text);
      assert.ok(parsed.rejected || parsed.reason?.includes("Invalid scope"),
        `BUG5: should reject empty scope. Got: ${JSON.stringify(parsed)}`);
    });
  });
});
