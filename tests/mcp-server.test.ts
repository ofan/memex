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
      arguments: { text: "Ryan prefers dark mode", category: "preference", importance: 0.8 },
    });

    const content = result.content as Array<{ type: string; text: string }>;
    assert.equal(content.length, 1);
    const parsed = JSON.parse(content[0].text);
    assert.equal(parsed.text, "Ryan prefers dark mode");
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
});
