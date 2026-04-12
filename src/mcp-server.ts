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
import { runDreamCycle } from "./dreaming.js";
import { detectCategory } from "../index.js";

// ============================================================================
// Server Factory
// ============================================================================

export interface McpServerOptions {
  dbPath: string;
  vectorDim?: number;
  embedder: Embedder;
  dreamIntervalMs?: number;
  noDream?: boolean;
}

export function createMemexMcpServer(options: McpServerOptions) {
  const { dbPath, vectorDim, embedder, dreamIntervalMs, noDream } = options;

  const store = new MemoryStore({ dbPath, vectorDim: vectorDim ?? embedder.dimensions });
  const retriever = createRetriever(store, embedder, {
    mode: "hybrid",
    rerank: "none",
  });

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
    const vector = await embedder.embedDocument(text);
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
    description: "Run memory consolidation (dedup, noise removal, re-scoring). Use 'light', 'deep', or 'all'.",
    inputSchema: {
      phase: z.enum(["light", "deep", "all"]).optional().describe("Which phase to run (default: all)"),
    },
  }, async (_params) => {
    const { phase = "all" } = _params as { phase?: string };

    const result = await runDreamCycle(store, {
      enabled: true,
      phases: {
        light: phase === "all" || phase === "light",
        deep: phase === "all" || phase === "deep",
        reflection: false,
      },
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          light: result.light,
          deep: result.deep,
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

  const dbPath = flagValue("--db");
  if (!dbPath) {
    console.error("Usage: memex-mcp --db <path> --embed-endpoint <url> [--embed-api-key <key>] [--embed-model <name>] [--no-dream] [--dream-interval <ms>]");
    process.exit(1);
  }

  const embedEndpoint = flagValue("--embed-endpoint");
  if (!embedEndpoint) {
    console.error("Error: --embed-endpoint is required for vector search");
    process.exit(1);
  }

  const embedApiKey = flagValue("--embed-api-key") || "";
  const embedModel = flagValue("--embed-model") || "default";
  const noDream = args.includes("--no-dream");
  const dreamInterval = parseInt(flagValue("--dream-interval") || "86400000", 10);

  const embedder = createEmbedder(embedEndpoint, embedApiKey, embedModel);
  const { server, store } = createMemexMcpServer({
    dbPath,
    embedder,
    dreamIntervalMs: dreamInterval,
    noDream,
  });

  // Background dreaming
  if (!noDream) {
    setInterval(async () => {
      try {
        await runDreamCycle(store, {
          enabled: true,
          phases: { light: true, deep: true, reflection: false },
        });
      } catch { /* dream cycle failure is non-fatal */ }
    }, dreamInterval);
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
