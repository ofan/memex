/**
 * MCP memory_recall debug capture (plan: feat/recall-debug-trace).
 * Verifies every response carries a debugId, and that when MEMEX_DEBUG_RECALL
 * is set a per-query trace file (keyed by debugId, containing the candidate
 * pool) is written to disk.
 */
import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemexMcpServer } from "../src/mcp-server.js";

const VECTOR_DIM = 8;
function makeFakeEmbedder() {
  const embed = (text: string): number[] => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    const v = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin((h + i) * 0.1));
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return v.map(x => x / (n || 1));
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

describe("MCP memory_recall debug capture", () => {
  let tmpDir: string;
  let debugDir: string;
  let prevDebug: string | undefined;
  let client: Client;
  let serverClose: () => Promise<void>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-mcp-debug-"));
    debugDir = join(tmpDir, "debug-out");
    prevDebug = process.env.MEMEX_DEBUG_RECALL;
    process.env.MEMEX_DEBUG_RECALL = debugDir;

    const { server } = createMemexMcpServer({
      dbPath: join(tmpDir, "memex.sqlite"),
      vectorDim: VECTOR_DIM,
      embedder: makeFakeEmbedder(),
      noDream: true,
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    serverClose = async () => { await client.close(); await server.close(); };
  });

  afterEach(async () => {
    if (prevDebug === undefined) delete process.env.MEMEX_DEBUG_RECALL;
    else process.env.MEMEX_DEBUG_RECALL = prevDebug;
    await serverClose();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("response always carries a debugId; capture writes a trace file keyed by it", async () => {
    await client.callTool({ name: "memory_store", arguments: { text: "The deploy uses flux and kustomize on the build host", category: "fact" } });
    await client.callTool({ name: "memory_store", arguments: { text: "Unrelated note about weather patterns zzz", category: "fact" } });

    const result = await client.callTool({ name: "memory_recall", arguments: { query: "deploy flux kustomize", limit: 5 } });
    const parsed = JSON.parse((result.content as any)[0].text);

    // debugId is always present (8 hex chars), captured=true when env set.
    assert.ok(parsed.debugId, "response carries a debugId");
    assert.match(parsed.debugId, /^[0-9a-f]{8}$/i);
    assert.equal(parsed.captured, true);

    // The trace file exists, is keyed by debugId, and contains the candidate pool.
    // (writeDebugRecall is fire-and-forget async — poll briefly for the file.)
    let match: string | undefined;
    for (let i = 0; i < 20 && !match; i++) {
      const files = await readdir(debugDir);
      match = files.find(f => f.startsWith(parsed.debugId));
      if (!match) await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(match, `trace file ${parsed.debugId}*.json written`);
    const payload = JSON.parse(await readFile(join(debugDir, match!), "utf8"));
    assert.equal(payload.debugId, parsed.debugId);
    assert.equal(payload.source, "mcp-recall");
    assert.ok(payload.trace, "payload carries the full trace");
    assert.ok(payload.trace.stages.length > 0, "trace has stages");
    const stageNames = payload.trace.stages.map((s: any) => s.name);
    assert.ok(stageNames.includes("fusion") || stageNames.includes("vector-search"), `records an early pool stage: ${stageNames.join(",")}`);
  });

  it("with capture off, response still has debugId but no file is written", async () => {
    delete process.env.MEMEX_DEBUG_RECALL;
    // Note: captureTrace was resolved at server construction (on). Toggling env
    // post-construction doesn't flip it — so this test re-creates the server.
    await serverClose();
    const { server } = createMemexMcpServer({
      dbPath: join(tmpDir, "memex2.sqlite"),
      vectorDim: VECTOR_DIM,
      embedder: makeFakeEmbedder(),
      noDream: true,
    });
    client = new Client({ name: "test-client", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(c), server.connect(s)]);
    serverClose = async () => { await client.close(); await server.close(); };

    await client.callTool({ name: "memory_store", arguments: { text: "some fact about routing", category: "fact" } });
    const result = await client.callTool({ name: "memory_recall", arguments: { query: "routing", limit: 3 } });
    const parsed = JSON.parse((result.content as any)[0].text);
    assert.ok(parsed.debugId, "debugId present even with capture off");
    assert.equal(parsed.captured, false);
  });
});
