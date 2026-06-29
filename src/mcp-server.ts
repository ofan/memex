/**
 * Memex MCP Server — standalone memory server over Model Context Protocol.
 *
 * Provides 5 tools (memory_store, memory_recall, memory_forget, memory_dream,
 * memory_stats) backed by the same SQLite database as the OpenClaw plugin.
 * Runs as a long-lived process with optional background dreaming.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { MemoryStore } from "./memory.js";
import { createRetriever } from "./retriever.js";
import { createEmbedder, type Embedder } from "./embedder.js";
import { isNoise } from "./noise-filter.js";
import { runDreamCycle, type ReflectionLLMConfig } from "./dreaming.js";
import { anchor, expandAnchor, AnchorAmbiguityError } from "./anchor.js";
import { detectCategory } from "../index.js";
import { deriveScopes } from "./scope-derive.js";

// ============================================================================
// Scope tag validation (Bug 5 fix)
// ============================================================================

/** Validate a scope tag against the format regex. */
function isValidScopeTag(tag: string): boolean {
  if (!tag || typeof tag !== "string" || tag.trim().length === 0) return false;
  const trimmed = tag.trim();
  if (trimmed.length > 100) return false;
  if (trimmed.startsWith("device:")) return false;
  return /^[a-zA-Z0-9._:-]+$/.test(trimmed);
}

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
    {
      capabilities: { tools: {} },
      instructions: [
        "You have access to a long-term memory system (memex).",
        "At the START of each conversation, call memory_recall with a query based on the user's first message to load relevant context.",
        "When you learn a new preference, fact, decision, or important insight, call memory_store to save it for future conversations.",
        "Do NOT store: ephemeral file paths, temporary debugging state, or information already in the current conversation context.",
        "DO store: user preferences, architectural decisions, project conventions, lessons learned, infrastructure details.",
        "Memory is shared across all your sessions — what you store now will be recalled in future conversations.",
      ].join(" "),
    },
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
      scope: z.string().optional()
        .describe("Scope tag for the memory (default: 'global')"),
      agent_id: z.string().optional()
        .describe("Agent identifier (optional, for agent-scoped memories)"),
      session_id: z.string().optional()
        .describe("Session identifier (optional, for session-scoped memories)"),
      device_id: z.string().optional()
        .describe("Device identifier (metadata-only, never a scope tag)"),
    },
  }, async (_params, _extra) => {
    const { text, category, importance = 0.7, scope = "global",
            agent_id, session_id, device_id } = _params as {
      text: string;
      category?: string;
      importance?: number;
      scope?: string;
      agent_id?: string;
      session_id?: string;
      device_id?: string;
    };

    if (isNoise(text)) {
      return { content: [{ type: "text", text: JSON.stringify({ rejected: true, reason: "noise" }) }] };
    }

    const resolvedCategory = category || detectCategory(text);
    const vector = embedder ? await embedder.embedPassage(text) : new Array(dim).fill(0);

    // Derive scope tags from server environment (server-authoritative derivation).
    // In stdio mode the server has access to client cwd/env.
    const effectiveSessionId = session_id || _extra.sessionId;
    const clientName = detectClientName((_extra as any)?._meta);

    const derivResult = deriveScopes({
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      clientName,
      sessionId: effectiveSessionId,
      explicit: {
        ...(agent_id ? { agent: agent_id } : {}),
        ...(device_id ? { device: device_id } : {}),
      },
    });

    // Validate client-supplied scope format (Bug 5 fix)
    // Only `device:` prefix was rejected before; now validate every tag.
    let validatedScope: string | null = null;
    if (scope !== undefined && scope !== null && scope !== "global") {
      const trimmed = String(scope).trim();
      if (!trimmed || !isValidScopeTag(trimmed)) {
        return { content: [{ type: "text", text: JSON.stringify({ rejected: true, reason: `Invalid scope format: "${scope}"` }) }] };
      }
      validatedScope = trimmed;
    }

    // Merge explicit scope param (if different from global) into derived tags
    let tags = derivResult.tags;
    if (validatedScope) {
      if (!tags.includes(validatedScope)) {
        tags = [...tags, validatedScope];
      }
    }

    let entry;
    try {
      entry = await store.store({
        text,
        vector,
        category: resolvedCategory as any,
        scope,
        importance,
        scopes: tags,
        metadata: JSON.stringify(derivResult.metadata),
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("device:")) {
        return { content: [{ type: "text", text: JSON.stringify({ rejected: true, reason: err.message }) }] };
      }
      throw err;
    }

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
          scopes: tags,
        }),
      }],
    };
  });

  /** Detect the MCP client name from environment or transport clues. */
  function detectClientName(meta?: Record<string, unknown>): string | undefined {
    // Prefer explicit env var
    if (process.env.MEMEX_CLIENT_NAME) return process.env.MEMEX_CLIENT_NAME;
    // Detect from well-known CLI tool env vars set by the MCP host process
    if (process.env.CLAUDE_PROJECT_DIR) return "claude-code";
    if (process.env.CODEX_HOME) return "codex";
    if (process.env.OPEN_CODE_LOGS_DIR) return "opencode";
    if (process.env.OPENCLAW_HOME) return "openclaw";
    // Detect from MCP client name in transport metadata
    if (meta?.clientName) return meta.clientName as string;
    return undefined;
  }

  // ── memory_recall ─────────────────────────────────────────────────────────
  server.registerTool("memory_recall", {
    title: "Recall Memories",
    description: "Search memories using hybrid retrieval (vector + keyword). Returns the most relevant matches.",
    inputSchema: {
      query: z.string().describe("Search query"),
      limit: z.number().min(1).max(20).optional().describe("Max results (default: 5)"),
      scopes: z.array(z.string()).optional().describe(
        "Explicit scope tags to filter by (replaces the default active-context set). A memory matches if it has ANY of these tags. Omit to recall all memories unfiltered."
      ),
      agent_id: z.string().optional()
        .describe("Agent identifier (optional, scopes recall to agent-specific memories)"),
      session_id: z.string().optional()
        .describe("Session identifier (optional, scopes recall to session-specific memories)"),
    },
  }, async (_params, _extra) => {
    const { query, limit = 5, scopes, agent_id, session_id } = _params as {
      query: string; limit?: number; scopes?: string[];
      agent_id?: string; session_id?: string;
    };

    // Build effective scope filter (Bug 4 & 6 fix: consume agent_id/session_id)
    let effectiveScopes = scopes ? [...scopes] : undefined;
    if (agent_id || session_id) {
      const derivResult = deriveScopes({
        cwd: process.cwd(),
        env: process.env as Record<string, string | undefined>,
        clientName: detectClientName((_extra as any)?._meta),
        sessionId: session_id,
        explicit: agent_id ? { agent: agent_id } : undefined,
      });
      if (effectiveScopes) {
        // Merge derived agent/session tags into explicit scopes
        if (agent_id) {
          const agentTag = `agent:${agent_id}`;
          if (!effectiveScopes.includes(agentTag)) effectiveScopes.push(agentTag);
        }
        if (session_id) {
          const sessionTag = derivResult.tags.find(t => t.startsWith("session:"));
          if (sessionTag && !effectiveScopes.includes(sessionTag)) effectiveScopes.push(sessionTag);
        }
      } else {
        // No explicit scopes — use full derivation
        effectiveScopes = derivResult.tags;
      }
    }

    if (retriever) {
      const results = await retriever.retrieve({ query, limit, scopes: effectiveScopes });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            results: results.map(r => ({
              id: r.entry.id,
              anchor: anchor(r.entry.id),
              text: r.entry.text,
              category: r.entry.category,
              scope: r.entry.scope,
              score: Math.round(r.score * 1000) / 1000,
            })),
            note: "Cite recalled memories by anchor (e.g. [mem:abc12345]) when relying on them. Pass the anchor (or any longer prefix) to memory_forget to delete a stale entry.",
          }),
        }],
      };
    }

    // BM25-only fallback when no embedder configured
    const bm25Results = await store.bm25Search(query, limit, effectiveScopes);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          results: bm25Results.map(r => ({
            id: r.entry.id,
            anchor: anchor(r.entry.id),
            text: r.entry.text,
            category: r.entry.category,
            scope: r.entry.scope,
            score: Math.round(r.score * 1000) / 1000,
          })),
          mode: "bm25-only",
          note: "Cite recalled memories by anchor (e.g. [mem:abc12345]) when relying on them. Pass the anchor (or any longer prefix) to memory_forget to delete a stale entry.",
        }),
      }],
    };
  });

  // ── memory_forget ─────────────────────────────────────────────────────────
  server.registerTool("memory_forget", {
    title: "Forget Memory",
    description: "Delete a memory. Accepts a full memory ID (UUID) or a citation anchor (8+ hex chars) from a [mem:...] reference.",
    inputSchema: {
      id: z.string().describe("Memory ID, citation anchor (8 hex chars), or longer prefix"),
    },
  }, async (_params) => {
    const { id } = _params as { id: string };

    // Resolve anchor prefixes (under 32 chars) to full ids by scanning all memories.
    let resolvedId = id;
    if (id.length < 32) {
      const allEntries = await store.list(undefined, undefined, 100000, 0);
      const allIds = allEntries.map(e => e.id);
      try {
        const expanded = expandAnchor(id, allIds);
        if (!expanded) {
          return {
            content: [{ type: "text", text: JSON.stringify({ deleted: false, error: "anchor_not_found", anchor: id }) }],
          };
        }
        resolvedId = expanded;
      } catch (err) {
        if (err instanceof AnchorAmbiguityError) {
          return {
            content: [{ type: "text", text: JSON.stringify({ deleted: false, error: "anchor_ambiguous", anchor: id, matches: err.matches }) }],
          };
        }
        throw err;
      }
    }

    const deleted = await store.delete(resolvedId);
    return { content: [{ type: "text", text: JSON.stringify({ deleted, id: resolvedId, anchor: anchor(resolvedId), via_anchor: resolvedId !== id }) }] };
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
      embedder,
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

    // Scope breakdown from memory_scopes (authoritative), not the legacy m.scope column.
    const scopeRows = db.prepare(
      "SELECT scope, COUNT(*) as cnt FROM memory_scopes GROUP BY scope ORDER BY cnt DESC"
    ).all() as Array<{ scope: string; cnt: number }>;
    const byScope: Record<string, number> = {};
    for (const row of scopeRows) byScope[row.scope] = row.cnt;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total,
          byCategory,
          byScope,
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
  const llmTimeout = parseInt(flagValue("--llm-timeout") || process.env.MEMEX_LLM_TIMEOUT || "0", 10) || undefined;
  const llmURL = llmBaseURL?.endsWith("/v1") ? llmBaseURL : llmBaseURL ? `${llmBaseURL}/v1` : undefined;
  const reflectionLLM = llmURL && llmModel ? {
    endpoint: `${llmURL}/chat/completions`,
    model: llmModel,
    apiKey: llmApiKey,
    ...(llmTimeout ? { timeout: llmTimeout } : {}),
  } : undefined;
  if (reflectionLLM) {
    console.error(`memex-mcp: reflection enabled (model: ${llmModel}${llmTimeout ? `, timeout: ${llmTimeout}ms` : ""})`);
  }

  // Factory creates a fresh McpServer per HTTP session. For stdio, used once.
  const sharedOptions = {
    dbPath,
    embedder,
    reflectionLLM,
    dreamIntervalMs: dreamInterval,
    noDream,
  };
  const { server, store } = createMemexMcpServer(sharedOptions);

  // Dreaming timer handles — captured so shutdown() can clear them. Without this
  // the repeating setInterval pins the Node event loop forever, orphaning this
  // process when its MCP client dies (keeps dreaming against the shared DB).
  let dreamStartupTimer: NodeJS.Timeout | undefined;
  let dreamTimer: NodeJS.Timeout | undefined;

  // Background dreaming — periodic schedule
  if (!noDream) {
    const dreamConfig = {
      enabled: true,
      phases: { light: true, deep: true, reflection: !!reflectionLLM },
      reflectionLLM,
      embedder,
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
    dreamStartupTimer = setTimeout(() => runDream("startup"), 5 * 60_000);
    dreamTimer = setInterval(() => runDream("scheduled"), dreamInterval);
    console.error(`memex-mcp: dreaming scheduled (first in 5m, then every ${Math.round(dreamInterval / 3600_000)}h)`);
  }

  // Choose transport: HTTP daemon mode (--http <port>) or stdio (default)
  const httpPort = parseInt(flagValue("--http") || process.env.MEMEX_HTTP_PORT || "0", 10);
  const httpHost = flagValue("--http-host") || process.env.MEMEX_HTTP_HOST || "127.0.0.1";
  const authToken = flagValue("--auth-token") || process.env.MEMEX_AUTH_TOKEN || "";

  // Graceful shutdown: clear dreaming timers, stop the HTTP listener, close the
  // DB, exit. SIGTERM/SIGINT are always handled (systemd stop/restart, Ctrl-C).
  // For stdio we ALSO exit on client disconnect (stdin EOF) — otherwise a dead
  // MCP client leaves this subprocess orphaned and dreaming against the shared DB.
  let httpServer: ReturnType<typeof createHttpServer> | undefined;
  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`memex-mcp: shutting down (${reason})`);
    if (dreamStartupTimer) clearTimeout(dreamStartupTimer);
    if (dreamTimer) clearInterval(dreamTimer);
    httpServer?.close();
    // Safety net: force exit if the DB close stalls (e.g. an in-flight transaction).
    setTimeout(() => process.exit(0), 2000).unref();
    store.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  if (httpPort > 0) {
    // For HTTP, each session gets its own McpServer instance (stateful sessions).
    // The first one constructed above is used for the dreaming timer; HTTP creates fresh.
    const factory = () => createMemexMcpServer(sharedOptions).server;
    httpServer = await startHttpServer(factory, { port: httpPort, host: httpHost, authToken });
  } else {
    const transport = new StdioServerTransport();
    // stdio: the MCP client owns this process. When it goes away, stdin closes —
    // exit rather than orphaning. The HTTP daemon intentionally does NOT do this;
    // it is long-lived and managed by systemd.
    process.stdin.on("end", () => shutdown("client-disconnect"));
    process.stdin.on("close", () => shutdown("client-disconnect"));
    await server.connect(transport);
  }
}

async function startHttpServer(
  serverFactory: () => McpServer,
  opts: { port: number; host: string; authToken: string },
): Promise<ReturnType<typeof createHttpServer>> {
  const { port, host, authToken } = opts;
  const { randomUUID } = await import("node:crypto");

  // Per-session transports. Each MCP client gets its own session and transport.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Auth: bearer token via Authorization header
    if (authToken) {
      const auth = req.headers["authorization"];
      const expected = `Bearer ${authToken}`;
      if (auth !== expected) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
    }

    // Health endpoint
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, version: "0.6.0", sessions: sessions.size }));
      return;
    }

    // MCP endpoint: /mcp
    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
      try {
        let parsedBody: unknown;
        if (req.method === "POST") {
          parsedBody = await readJsonBody(req);
        }

        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session — route to its transport
          transport = sessions.get(sessionId);
        } else if (!sessionId && isInitializeRequest(parsedBody)) {
          // New session — create transport + dedicated server instance
          const newId = randomUUID();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newId,
            enableJsonResponse: true,
            onsessioninitialized: (id: string) => { sessions.set(id, transport!); },
          });
          transport.onclose = () => {
            if (transport!.sessionId) sessions.delete(transport!.sessionId);
          };
          const sessionServer = serverFactory();
          await sessionServer.connect(transport);
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: provide Mcp-Session-Id, or initialize first" },
            id: null,
          }));
          return;
        }

        await transport!.handleRequest(req, res, parsedBody);
      } catch (err) {
        console.error("memex-mcp: HTTP request error:", err);
        if (!res.writableEnded) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : "internal error" }));
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  console.error(`memex-mcp: HTTP transport listening on http://${host}:${port}/mcp`);
  if (!authToken) {
    console.error(`memex-mcp: WARNING — no --auth-token set, daemon is open to anyone on ${host}`);
  }
  return httpServer;
}

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return typeof body === "object" && body !== null
    && (body as { method?: unknown }).method === "initialize";
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body.length > 0 ? JSON.parse(body) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Run if executed directly
const isDirectRun = process.argv[1]?.endsWith("mcp-server.ts") || process.argv[1]?.endsWith("mcp-server.js");
if (isDirectRun) {
  main().catch(err => {
    console.error("MCP server failed:", err);
    process.exit(1);
  });
}
