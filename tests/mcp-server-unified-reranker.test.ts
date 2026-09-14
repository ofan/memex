/**
 * Production regression guard for the document-aware MCP recall path.
 *
 * The UnifiedRetriever implementation has long supported reranking, but the
 * MCP factory previously omitted that configuration whenever documents were
 * enabled. This test locks the factory wiring and the post-rerank floor.
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

function deterministicVector(text: string) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h * 31) + text.charCodeAt(i)) | 0;
  const raw = Array.from({ length: VECTOR_DIM }, (_, i) => Math.sin((h + i) * 0.1));
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  return raw.map(value => value / (norm || 1));
}

const embedder = {
  dimensions: VECTOR_DIM,
  embedQuery: async (text: string) => deterministicVector(text),
  embedPassage: async (text: string) => deterministicVector(text),
  embed: async (text: string) => deterministicVector(text),
  embedBatch: async (texts: string[]) => texts.map(deterministicVector),
  embedBatchQuery: async (texts: string[]) => texts.map(deterministicVector),
  embedBatchPassage: async (texts: string[]) => texts.map(deterministicVector),
} as any;

const RERANK_ENV = [
  "MEMEX_RERANK_ENDPOINT",
  "MEMEX_RERANK_API_KEY",
  "MEMEX_RERANK_MODEL",
  "MEMEX_RERANK_PROVIDER",
  "MEMEX_RERANK_SCORE_MODE",
  "MEMEX_RERANK_BLEND_WEIGHT",
  "MEMEX_RERANK_CONFIDENCE_THRESHOLD",
  "MEMEX_RERANK_CONFIDENCE_GAP",
] as const;

describe("MCP unified reranker wiring", () => {
  let tmpDir: string;
  let previousEnv: Record<string, string | undefined>;
  let previousFetch: typeof globalThis.fetch;
  let close: (() => Promise<void>) | undefined;
  let fetchCalls: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "memex-mcp-unified-rerank-"));
    previousEnv = {};
    for (const key of RERANK_ENV) {
      previousEnv[key] = process.env[key];
    }
    process.env.MEMEX_RERANK_ENDPOINT = "http://rerank.invalid.test/v1/rerank";
    process.env.MEMEX_RERANK_API_KEY = "test-key";
    process.env.MEMEX_RERANK_MODEL = "test-reranker";
    process.env.MEMEX_RERANK_PROVIDER = "jina";
    process.env.MEMEX_RERANK_CONFIDENCE_THRESHOLD = "2";
    process.env.MEMEX_RERANK_CONFIDENCE_GAP = "1";
    fetchCalls = [];
    previousFetch = globalThis.fetch;
    globalThis.fetch = async (input: any) => {
      const url = String(typeof input === "string" ? input : input?.url ?? input);
      fetchCalls.push(url);
      return new Response(JSON.stringify({
        results: [
          { index: 0, relevance_score: 0 },
          { index: 1, relevance_score: 0 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
  });

  afterEach(async () => {
    await close?.();
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes MEMEX_RERANK_* into UnifiedRetriever and reranks before the final cutoff", async () => {
    const created = createMemexMcpServer({
      dbPath: join(tmpDir, "memex.sqlite"),
      vectorDim: VECTOR_DIM,
      embedder,
      noDream: true,
      documents: { paths: [{ path: tmpDir, name: "test-docs" }] },
    });
    const { server, retriever } = created;
    close = async () => { await server.close(); };

    // This is the exact assertion that would have failed before the wiring fix.
    const config = (retriever as any).config;
    assert.equal(typeof config.limit, "number", "retriever exposes unified config");
    assert.ok(config.reranker, "unified production path must receive a reranker when MEMEX_RERANK_* is set");
    assert.equal(config.reranker.endpoint, "http://rerank.invalid.test/v1/rerank");
    assert.equal(config.reranker.model, "test-reranker");
    assert.equal(config.reranker.provider, "jina");
    assert.equal(config.confidenceThreshold, 2);
    assert.equal(config.confidenceGap, 1);

    const client = new Client({ name: "test-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const previousClose = close;
    close = async () => { await client.close(); await previousClose(); };

    await client.callTool({
      name: "memory_store",
      arguments: { text: "alpha memory candidate", category: "fact" },
    });
    await client.callTool({
      name: "memory_store",
      arguments: { text: "beta memory candidate", category: "fact" },
    });

    const response: any = await client.callTool({
      name: "memory_recall",
      arguments: { query: "alpha beta memory", limit: 5 },
    });
    const parsed = JSON.parse(response.content[0].text);

    assert.ok(fetchCalls.some(url => url.includes("rerank.invalid.test")),
      "reranker must actually be invoked from the MCP recall path");
    assert.equal(parsed.results.length, 0,
      "post-rerank cutoff must reject candidates whose reranked relevance is zero");
  });
});
