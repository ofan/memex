/**
 * Memex MCP Server — standalone memory server over Model Context Protocol.
 *
 * Provides 5 tools (memory_store, memory_recall, memory_forget, memory_dream,
 * memory_stats) backed by the same SQLite database as the OpenClaw plugin.
 * Runs as a long-lived process with optional background dreaming.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MemoryStore } from "./memory.js";
import { createRetriever } from "./retriever.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { isNoise } from "./noise-filter.js";
import { runDreamCycle, type ReflectionLLMConfig } from "./dreaming.js";
import { detectCategory } from "../index.js";

// ============================================================================
// Server Factory
// ============================================================================

export interface McpServerOptions {
  dbPath: string;
  vectorDim?: number;
  /** Embedder for vector search. If omitted, recall uses BM25-only and store skips vectors. */
  embedder?: Embedder;
  /** LLM config for dreaming reflection. If omitted, reflection phase is skipped. */
  reflectionLLM?: ReflectionLLMConfig;
  dreamIntervalMs?: number;
  noDream?: boolean;
}

export function createMemexMcpServer(options: McpServerOptions) {
  const { dbPath, vectorDim, embedder, reflectionLLM, dreamIntervalMs, noDream } = options;

  const dim = vectorDim ?? embedder?.dimensions ?? 8;
  const store = new MemoryStore({ dbPath, vectorDim: dim });
  const retriever = embedder
    ? createRetriever(store, embedder, { mode: "hybrid", rerank: "none" })
    : null;

  const server = new McpServer(
    { name: "memex", version: "0.6.0" },
    { capabilities: { tools: {} } },
  );

  // ── memory_store ──────────────────────────────────────────────────────────
  server.registerTool("memory_store", {
    title: "Store Memory",
    description: "Store a new memory (fact, preference, decision, or entity).",
    inputSchema: {
      text: z.string().describe("The memory text to store"),
      category: z.enum(["preference", "fact", "decision", "entity", "other"]).optional()
        .describe("Memory category (auto-detected if omitted)"),
      importance: z.number().min(0).max(1).optional()
        .describe("Importance score 0-1 (default: 0.7)"),
    },
  }, async (_params, _extra) => {
    const { text, category, importance = 0.7 } = _params as {
      text: string;
      category?: string;
      importance?: number;
    };

    if (isNoise(text)) {
      return { content: [{ type: "text", text: JSON.stringify({ rejected: true, reason: "noise" }) }] };
    }

    const resolvedCategory = category || detectCategory(text);
    const vector = embedder ? await embedder.embedDocument(text) : new Array(dim).fill(0);
    const entry = await store.store({
      text,
      vector,
      category: resolvedCategory as any,
      scope: "global",
      importance,
    });

    if (!entry) {
      return { content: [{ type: "text", text: JSON.stringify({ rejected: true, reason: "duplicate" }) }] };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          id: entry.id,
          text: entry.text,
          category: resolvedCategory,
          importance,
        }),
      }],
    };
  });

  // ── memory_recall ─────────────────────────────────────────────────────────
  server.registerTool("memory_recall", {
    title: "Recall Memories",
    description: "Search memories using hybrid retrieval (vector + keyword). Returns the most relevant matches.",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(20).optional().describe("Max results (default: 5)"),
    },
  }, async (_params) => {
    const { query, limit = 5 } = _params as { query: string; limit?: number };

    if (retriever) {
      const results = await retriever.retrieve({ query, limit });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results: results.map(r => ({
              id: r.entry.id,
              text: r.entry.text,
              category: r.entry.category,
              score: Math.round(r.score * 1000) / 1000,
            })),
          }),
        }],
      };
    }

    // BM25-only fallback when no embedder configured
    const bm25Results = await store.bm25Search(query, limit);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          results: bm25Results.map(r => ({
            id: r.entry.id,
            text: r.entry.text,
            category: r.entry.category,
            score: Math.round(r.score * 1000) / 1000,
          })),
          mode: "bm25-only",
        }),
      }],
    };
  });

  // ── memory_forget ─────────────────────────────────────────────────────────
  server.registerTool("memory_forget", {
    title: "Forget Memory",
    description: "Delete a memory by ID.",
    inputSchema: {
      id: z.string().describe("Memory ID to delete"),
    },
  }, async (_params) => {
    const { id } = _params as { id: string };
    const deleted = await store.delete(id);
    return { content: [{ type: "text", text: JSON.stringify({ deleted }) }] };
  });

  // ── memory_dream ──────────────────────────────────────────────────────────
  server.registerTool("memory_dream", {
    title: "Dream",
    description: "Run memory consolidation (dedup, noise removal, re-scoring, reflection). Use 'light', 'deep', 'reflect', or 'all'.",
    inputSchema: {
      phase: z.enum(["light", "deep", "reflect", "all"]).optional().describe("Which phase to run (default: all)"),
    },
  }, async (_params) => {
    const { phase = "all" } = _params as { phase?: string };

    const result = await runDreamCycle(store, {
      enabled: true,
      phases: {
        light: phase === "all" || phase === "light",
        deep: phase === "all" || phase === "deep",
        reflection: (phase === "all" || phase === "reflect") && !!reflectionLLM,
      },
      reflectionLLM,
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          light: result.light,
          deep: result.deep,
          reflection: result.reflection,
          errors: result.errors,
          duration_ms: result.duration_ms,
        }),
      }],
    };
  });

  // ── memory_stats ──────────────────────────────────────────────────────────
  server.registerTool("memory_stats", {
    title: "Memory Stats",
    description: "Get memory pool statistics.",
    inputSchema: {},
  }, async () => {
    const db = store.db;
    const total = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as any).c;
    const cats = db.prepare(
      "SELECT category, COUNT(*) as c FROM memories GROUP BY category"
    ).all() as Array<{ category: string; c: number }>;
    const byCategory: Record<string, number> = {};
    for (const row of cats) byCategory[row.category] = row.c;

    const neverRecalled = (db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE recall_count IS NULL OR recall_count = 0"
    ).get() as any).c;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total,
          byCategory,
          neverRecalled,
          neverRecalledRatio: total > 0 ? Math.round((neverRecalled / total) * 100) / 100 : 0,
        }),
      }],
    };
  });

  return { server, store, retriever };
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const flagIndex = (flag: string) => args.indexOf(flag);
  const flagValue = (flag: string) => {
    const i = flagIndex(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const defaultDbPath = homeDir ? `${homeDir}/.openclaw/memory/memex/memex.sqlite` : "";
  const dbPath = flagValue("--db") || process.env.MEMEX_DB_PATH || defaultDbPath;
  if (!dbPath) {
    console.error("Usage: memex-mcp [--db <path>]");
    console.error("  Defaults to ~/.openclaw/memory/memex/memex.sqlite");
    console.error("  Env vars: MEMEX_DB_PATH, MEMEX_EMBED_ENDPOINT, MEMEX_EMBED_API_KEY, MEMEX_EMBED_MODEL");
    process.exit(1);
  }

  const embedBaseURL = flagValue("--embed-endpoint") || process.env.MEMEX_EMBED_ENDPOINT || undefined;
  const embedApiKey = flagValue("--embed-api-key") || process.env.MEMEX_EMBED_API_KEY || "";
  const embedModel = flagValue("--embed-model") || process.env.MEMEX_EMBED_MODEL || "default";
  const embedDim = parseInt(flagValue("--embed-dim") || process.env.MEMEX_EMBED_DIM || "0", 10) || undefined;
  const noDream = args.includes("--no-dream") || process.env.MEMEX_NO_DREAM === "1";
  const dreamInterval = parseInt(
    flagValue("--dream-interval") || process.env.MEMEX_DREAM_INTERVAL || "86400000", 10
  );

  // baseURL should be the OpenAI-compatible base (e.g. http://host:8090/v1)
  // The SDK appends /embeddings automatically
  const baseURL = embedBaseURL?.endsWith("/v1") ? embedBaseURL : embedBaseURL ? `${embedBaseURL}/v1` : undefined;
  const embedder = baseURL ? createEmbedder({
    provider: "openai-compatible",
    baseURL,
    apiKey: embedApiKey,
    model: embedModel,
    ...(embedDim ? { dimensions: embedDim } : {}),
  }) : undefined;
  if (!embedBaseURL) {
    console.error("memex-mcp: no --embed-endpoint, running in BM25-only mode (no vector search)");
  }

  // LLM config for dreaming reflection
  const llmBaseURL = flagValue("--llm-endpoint") || process.env.MEMEX_LLM_ENDPOINT || undefined;
  const llmModel = flagValue("--llm-model") || process.env.MEMEX_LLM_MODEL || "";
  const llmApiKey = flagValue("--llm-api-key") || process.env.MEMEX_LLM_API_KEY || embedApiKey;
  const llmURL = llmBaseURL?.endsWith("/v1") ? llmBaseURL : llmBaseURL ? `${llmBaseURL}/v1` : undefined;
  const reflectionLLM = llmURL && llmModel ? {
    endpoint: `${llmURL}/chat/completions`,
    model: llmModel,
    apiKey: llmApiKey,
  } : undefined;
  if (reflectionLLM) {
    console.error(`memex-mcp: reflection enabled (model: ${llmModel})`);
  }

  const { server, store } = createMemexMcpServer({
    dbPath,
    embedder,
    reflectionLLM,
    dreamIntervalMs: dreamInterval,
    noDream,
  });

  // Background dreaming — periodic schedule
  if (!noDream) {
    const dreamConfig = {
      enabled: true,
      phases: { light: true, deep: true, reflection: !!reflectionLLM },
      reflectionLLM,
    };

    const runDream = async (reason: string) => {
      try {
        const result = await runDreamCycle(store, dreamConfig);
        const parts = [
          result.light ? `light(deduped=${result.light.deduped},noise=${result.light.noiseRemoved})` : null,
          result.deep ? `deep(rescored=${result.deep.rescored},decayed=${result.deep.decayed})` : null,
          result.reflection ? `reflect(learnings=${result.reflection.learnings},contradictions=${result.reflection.contradictions})` : null,
        ].filter(Boolean).join(" ");
        console.error(`memex-mcp: dream [${reason}] (${result.duration_ms}ms) ${parts}`);
      } catch (err) {
        console.error("memex-mcp: dream failed:", err instanceof Error ? err.message : err);
      }
    };

    // Initial run shortly after startup, then on interval
    setTimeout(() => runDream("startup"), 5 * 60_000);
    setInterval(() => runDream("scheduled"), dreamInterval);
    console.error(`memex-mcp: dreaming scheduled (first in 5m, then every ${Math.round(dreamInterval / 3600_000)}h)`);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run if executed directly
const isDirectRun = process.argv[1]?.endsWith("mcp-server.ts") || process.argv[1]?.endsWith("mcp-server.js");
if (isDirectRun) {
  main().catch(err => {
    console.error("MCP server failed:", err);
    process.exit(1);
  });
}
