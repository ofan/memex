/**
 * Plan Task 5: MCP document tools + unified recall integration.
 * Verifies: document_upsert → recall with collections → doc returned (B1 gate,
 * B2 memory-always, document_collections listing).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemexMcpServer } from "../src/mcp-server.js";

const embed = (t: string) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; const v = Array.from({ length: 16 }, (_, i) => Math.sin((h + i) * 0.1)); const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return v.map(x => x / (n || 1)); };
const embedder = { dimensions: 16, embedQuery: async (t: string) => embed(t), embedPassage: async (t: string) => embed(t), embed: async (t: string) => embed(t), embedBatch: async (ts: string[]) => ts.map(embed), embedBatchQuery: async (ts: string[]) => ts.map(embed), embedBatchPassage: async (ts: string[]) => ts.map(embed) } as any;

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "mcp-doc-"));
  const { server } = createMemexMcpServer({
    dbPath: join(dir, "m.sqlite"), vectorDim: 16, embedder, noDream: true,
    documents: { paths: [{ path: join(dir, "nodocs"), name: "unused" }] },
  });
  const client = new Client({ name: "t", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return { dir, client, close: async () => { await client.close(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

describe("MCP doc tools + unified recall", () => {
  it("upsert → recall with collections returns the doc; without collections returns none (B1)", async () => {
    const { client, close } = await setup();
    await client.callTool({ name: "document_upsert", arguments: { collection: "p", docId: "d1", text: "the deploy uses flux and kustomize", title: "D1" } });
    const withColl: any = await client.callTool({ name: "memory_recall", arguments: { query: "deploy flux", collections: ["p"], limit: 5 } });
    const withParsed = JSON.parse(withColl.content[0].text);
    assert.ok(withParsed.results.some((r: any) => r.source === "document"), "doc returned with collections named");
    const noColl: any = await client.callTool({ name: "memory_recall", arguments: { query: "deploy flux", limit: 5 } });
    const noParsed = JSON.parse(noColl.content[0].text);
    assert.equal(noParsed.results.filter((r: any) => r.source === "document").length, 0, "no docs without naming a private collection (B1)");
    await close();
  });
  it("B2: doc-pattern query still returns memories when docs configured but no doc match", async () => {
    const { client, close } = await setup();
    await client.callTool({ name: "memory_store", arguments: { text: "the readme documents the deploy step by step", category: "fact" } });
    const res: any = await client.callTool({ name: "memory_recall", arguments: { query: "what does the readme say about deploy", collections: ["nomatch"], limit: 5 } });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.results.some((r: any) => r.source !== "document"), "memory returned despite DOC_PATTERNS query (B2)");
    await close();
  });
  it("document_collections lists collections", async () => {
    const { client, close } = await setup();
    await client.callTool({ name: "document_upsert", arguments: { collection: "p", docId: "d1", text: "x", title: "D1" } });
    const res: any = await client.callTool({ name: "document_collections", arguments: {} });
    const parsed = JSON.parse(res.content[0].text);
    assert.ok(parsed.collections.some((c: any) => c.name === "p"), "collection p listed");
    await close();
  });
});
