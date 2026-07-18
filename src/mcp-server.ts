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
import { resolveDebugDir, writeDebugRecall, buildPayloadFromMcpRecall } from "./debug-recall.js";
import { randomUUID } from "node:crypto";
import { createStore, searchFTS, searchVec } from "./search.js";
import { UnifiedRetriever } from "./unified-retriever.js";
import { upsertDocument, forgetDocument, indexAllPaths, embedDocuments } from "./doc-indexer.js";

/** memex version — keep in sync with package.json (consumed by /health + MCP handshake). */
const VERSION = "0.7.3";

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
  /** Document collections to index (configured-dir). Enables unified memory+doc retrieval. */
  documents?: { paths: Array<{ path: string; name: string }> };
}

export function createMemexMcpServer(options: McpServerOptions) {
  const { dbPath, vectorDim, embedder, reflectionLLM, dreamIntervalMs, noDream, documents } = options;

  const dim = vectorDim ?? embedder?.dimensions ?? 8;
  const docsConfigured = !!(documents?.paths?.length);

  // B5: dimension agreement (shared vectors_vec drop+rebuilds on mismatch).
  if (docsConfigured && embedder && embedder.dimensions !== dim) {
    throw new Error(`dimension mismatch: embedder ${embedder.dimensions} != vectorDim ${dim} (B5)`);
  }

  // B6: bootstrap — createStore (doc tables + shared vectors_vec) when docs configured.
  let docStore: ReturnType<typeof createStore> | undefined;
  let store: MemoryStore;
  if (docsConfigured) {
    docStore = createStore(dbPath);
    docStore.ensureVecTable(dim);
    store = new MemoryStore({ dbPath, vectorDim: dim, db: docStore.db });
    // document_collections table (visibility model)
    docStore.db.prepare(`CREATE TABLE IF NOT EXISTS document_collections (
      name TEXT PRIMARY KEY, visibility TEXT NOT NULL DEFAULT 'private',
      source TEXT NOT NULL, created_at TEXT NOT NULL)`).run();
  } else {
    store = new MemoryStore({ dbPath, vectorDim: dim });
  }

  // Reranker config (shared between both retriever paths).
  const rerankEndpoint = process.env.MEMEX_RERANK_ENDPOINT;
  const rerankApiKey = process.env.MEMEX_RERANK_API_KEY;
  const rerankModel = process.env.MEMEX_RERANK_MODEL;
  const enableRerank = !!(rerankEndpoint && rerankApiKey);
  const rerankLlmModel = process.env.MEMEX_RERANK_LLM_MODEL;
  const rerankLlmEndpoint = reflectionLLM?.endpoint;
  const rerankLlmApiKey = reflectionLLM?.apiKey ?? "";
  const enableLlmRerank = !!(rerankLlmEndpoint && rerankLlmModel);
  const captureTrace = !!resolveDebugDir();

  // B2: UnifiedRetriever when docs configured; MemoryRetriever otherwise.
  let retriever: any;
  let retrieverKind: "memory" | "unified" = "memory";
  if (docsConfigured && embedder) {
    const embeddingModel = process.env.MEMEX_EMBED_MODEL || "default";
    // B1: documentSearchFn — the collection gate.
    const documentSearchFn = async (query: string, queryVec: number[], limit: number, _coll?: string, collections?: string[]) => {
      const ss = docStore!;
      let effective = collections;
      if (!effective || effective.length === 0) {
        effective = (ss.db.prepare(`SELECT name FROM document_collections WHERE visibility = 'public'`).all() as { name: string }[]).map(r => r.name);
      }
      if (!effective || effective.length === 0) return []; // B1 gate
      const fts = searchFTS(ss.db, query, limit, undefined, effective);
      const vecRes = await searchVec(ss.db, query, embeddingModel, limit, undefined, undefined, queryVec, effective);
      const merged = new Map<string, any>();
      for (const r of fts) merged.set(r.filepath, r);
      for (const r of vecRes) { const ex = merged.get(r.filepath); if (!ex || (r as any).score > (ex as any).score) merged.set(r.filepath, r); }
      return Array.from(merged.values()).sort((a: any, b: any) => b.score - a.score).slice(0, limit)
        .map((r: any) => ({
          filepath: r.filepath, displayPath: r.display_path || r.filepath,
          title: r.title, body: r.body || "", bestChunk: r.body || "",
          bestChunkPos: 0, score: r.score, docid: r.hash || r.filepath, context: null,
        }));
    };
    retriever = new UnifiedRetriever(store, documentSearchFn, embedder, { captureTrace });
    retrieverKind = "unified";
  } else if (embedder) {
    retriever = createRetriever(store, embedder, {
      mode: "hybrid",
      rerank: enableLlmRerank ? "llm" : enableRerank ? "cross-encoder" : "none",
      ...(enableRerank ? { rerankEndpoint, rerankApiKey } : {}),
      ...(enableRerank && rerankModel ? { rerankModel } : {}),
      ...(enableLlmRerank ? { rerankLlmEndpoint, rerankLlmApiKey, rerankLlmModel } : {}),
      captureTrace,
    });
  } else {
    retriever = null;
  }

  const server = new McpServer(
    { name: "memex", version: VERSION },
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
      collections: z.array(z.string()).optional().describe(
        "Document collections to search (when docs are configured). Omit to search public collections only; name specific collections to include private ones."
      ),
      agent_id: z.string().optional()
        .describe("Agent identifier (optional, scopes recall to agent-specific memories)"),
      session_id: z.string().optional()
        .describe("Session identifier (optional, scopes recall to session-specific memories)"),
    },
  }, async (_params, _extra) => {
    const { query, limit = 5, scopes, collections, agent_id, session_id } = _params as {
      query: string; limit?: number; scopes?: string[]; collections?: string[];
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
      const debugId = randomUUID().slice(0, 8);
      // B3: call-shape branches on retriever kind (object for memory, positional for unified).
      let results: Array<{ id: string; text: string; score: number; source: string; category?: string; scope?: string; sources?: any; entry?: any }>;
      if (retrieverKind === "unified") {
        const ur = await retriever.retrieve(query, { limit, scopeFilter: effectiveScopes, collections, debugId });
        results = ur.map((r: any) => ({
          id: r.id, text: r.text, score: r.score,
          source: r.source === "conversation" ? "conversation" : "document",
          category: r.metadata?.category, scope: r.metadata?.scope,
        }));
      } else {
        const mr = await retriever.retrieve({ query, limit, scopes: effectiveScopes, debugId });
        results = mr.map((r: any) => ({
          id: r.entry.id, text: r.entry.text, score: r.score,
          source: r.sources?.reranked ? "reranked" : (r.sources?.vector && r.sources?.bm25) ? "both" : r.sources?.vector ? "vector" : "lexical",
          category: r.entry.category, scope: r.entry.scope, sources: r.sources, entry: r.entry,
        }));
      }
      // Record persistent recall signal (memories only — docs don't have recall_count).
      const recalledIds = results.filter(r => r.source !== "document").map(r => r.id);
      if (recalledIds.length > 0) {
        try { store.recordRecalls(recalledIds); } catch { /* best effort */ }
      }
      // Debug capture: write the per-stage trace keyed by debugId when enabled.
      const captured = captureTrace;
      if (captured) {
        writeDebugRecall(buildPayloadFromMcpRecall({
          debugId,
          agentId: "mcp",
          sessionId: session_id ?? null,
          query,
          trace: retriever.lastTrace ?? undefined,
          results: results.map(r => ({
            id: r.id, score: r.score,
            source: r.source as any, text: r.text, category: r.category, scope: r.scope,
          })),
        })).catch(() => { /* best effort — debug must never break recall */ });
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            debugId,
            captured,
            results: results.map(r => ({
              id: r.id,
              anchor: anchor(r.id),
              text: r.text,
              category: r.category,
              scope: r.scope,
              score: Math.round(r.score * 1000) / 1000,
              source: r.source,
            })),
            note: "Cite recalled memories by anchor (e.g. [mem:abc12345]) when relying on them. Pass the anchor (or any longer prefix) to memory_forget to delete a stale entry.",
          }),
        }],
      };
    }

    // BM25-only fallback when no embedder configured
    const debugId = randomUUID().slice(0, 8);
    const bm25Results = await store.bm25Search(query, limit, effectiveScopes);
    const recalledIds = bm25Results.map(r => r.entry.id);
    if (recalledIds.length > 0) {
      try { store.recordRecalls(recalledIds); } catch { /* best effort */ }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          debugId,
          captured: false,
          results: bm25Results.map(r => ({
            id: r.entry.id,
            anchor: anchor(r.entry.id),
            text: r.entry.text,
            category: r.entry.category,
            scope: r.entry.scope,
            score: Math.round(r.score * 1000) / 1000,
            source: "lexical",
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

    // Provenance breakdowns from metadata (scope-visibility #7): readable project
    // name + client identity, so stats answer "which projects / which clients".
    const metaRows = db.prepare(
      "SELECT metadata FROM memories WHERE metadata IS NOT NULL AND metadata != ''"
    ).all() as Array<{ metadata: string }>;
    const byProject: Record<string, number> = {};
    const byClient: Record<string, number> = {};
    for (const row of metaRows) {
      try {
        const m = JSON.parse(row.metadata) as { project_name?: string; client?: string };
        if (m.project_name) byProject[m.project_name] = (byProject[m.project_name] || 0) + 1;
        if (m.client) byClient[m.client] = (byClient[m.client] || 0) + 1;
      } catch { /* malformed metadata — skip */ }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          total,
          byCategory,
          byScope,
          byProject,
          byClient,
          neverRecalled,
          neverRecalledRatio: total > 0 ? Math.round((neverRecalled / total) * 100) / 100 : 0,
        }),
      }],
    };
  });

  // ── Document tools (only when docs configured) ─────────────────────────────
  if (docsConfigured && docStore) {
    const embeddingModel = process.env.MEMEX_EMBED_MODEL || "default";

    server.registerTool("document_upsert", {
      title: "Upsert Document",
      description: "Push a document into a collection. Idempotent by (collection, docId). Defaults to private visibility.",
      inputSchema: {
        collection: z.string().describe("Collection name (the document's namespace)"),
        docId: z.string().describe("Unique document id within the collection"),
        text: z.string().describe("Document text content"),
        title: z.string().optional().describe("Document title (defaults to docId)"),
        public: z.boolean().optional().describe("Mark collection as public (default-searched). Defaults to false (private)."),
      },
    }, async (_params) => {
      const { collection, docId, text, title, public: isPublic } = _params as any;
      await upsertDocument(docStore!.db, { collection, docId, text, title });
      // Embed the new/updated content
      await embedDocuments(docStore!.db, dim, embedder!);
      // Upsert collection metadata (visibility)
      docStore!.db.prepare(
        `INSERT INTO document_collections (name, visibility, source, created_at) VALUES (?,?,?,?)
         ON CONFLICT(name) DO UPDATE SET visibility = excluded.visibility`
      ).run(collection, isPublic ? "public" : "private", "push", new Date().toISOString());
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, collection, docId }) }] };
    });

    server.registerTool("document_forget", {
      title: "Forget Document",
      description: "Delete a document by (collection, docId).",
      inputSchema: {
        collection: z.string(),
        docId: z.string(),
      },
    }, async (_params) => {
      const { collection, docId } = _params as any;
      forgetDocument(docStore!.db, collection, docId);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, collection, docId }) }] };
    });

    server.registerTool("document_collections", {
      title: "List Document Collections",
      description: "List all document collections with visibility + document counts.",
      inputSchema: {},
    }, async () => {
      const rows = docStore!.db.prepare(
        `SELECT dc.name, dc.visibility, dc.source, COUNT(d.id) as docs
         FROM document_collections dc LEFT JOIN documents d ON d.collection = dc.name AND d.active = 1
         GROUP BY dc.name ORDER BY dc.name`
      ).all();
      return { content: [{ type: "text", text: JSON.stringify({ collections: rows }) }] };
    });

    // Configured-dir indexing (fire-and-forget on startup, interval for refresh)
    if (documents!.paths.length > 0) {
      const indexPaths = documents!.paths.map(p => ({ path: p.path, name: p.name, pattern: "**/*.md" }));
      const doIndex = async () => {
        try {
          await indexAllPaths(docStore!.db, indexPaths);
          await embedDocuments(docStore!.db, dim, embedder!);
          // Upsert collection metadata for ALL active collections (they're the shared corpus)
          const now = new Date().toISOString();
          const activeColls = docStore!.db.prepare(
            `SELECT DISTINCT collection FROM documents WHERE active = 1`
          ).all() as { collection: string }[];
          const stmt = docStore!.db.prepare(
            `INSERT INTO document_collections (name, visibility, source, created_at) VALUES (?,?,?,?)
             ON CONFLICT(name) DO NOTHING`
          );
          for (const { collection } of activeColls) {
            stmt.run(collection, "public", "configured", now);
          }
        } catch { /* best effort — indexing must not crash the daemon */ }
      };
      doIndex(); // fire-and-forget at startup
      const interval = setInterval(doIndex, 30 * 60 * 1000); // every 30 min
      interval.unref();
    }
  }

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

  // Documents: MEMEX_DOC_PATHS (comma-separated <abs-path>:<name>) → documents.paths
  const docPathsRaw = process.env.MEMEX_DOC_PATHS;
  const documents = docPathsRaw ? {
    paths: docPathsRaw.split(",").map((entry) => {
      const idx = entry.lastIndexOf(":");
      return idx > 0
        ? { path: entry.slice(0, idx), name: entry.slice(idx + 1) }
        : { path: entry, name: entry.split("/").pop() || entry };
    }),
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
    documents,
  };
  const { server, store } = createMemexMcpServer(sharedOptions);

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  // Signal handlers are installed BEFORE any timers / listeners / transports so
  // a SIGTERM/SIGINT arriving during the (sometimes slow) startup window —
  // systemd stop, Ctrl-C, or the shutdown regression test — is always caught
  // instead of hitting the default disposition (terminate). The dreaming timers
  // and httpServer are assigned further down and guarded here.
  let dreamStartupTimer: NodeJS.Timeout | undefined;
  let dreamTimer: NodeJS.Timeout | undefined;
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

  if (httpPort > 0) {
    // For HTTP, each session gets its own McpServer instance (stateful sessions).
    // The first one constructed above is used for the dreaming timer; HTTP creates fresh.
    const factory = () => createMemexMcpServer(sharedOptions).server;
    httpServer = await startHttpServer(factory, { port: httpPort, host: httpHost, authToken });
    console.error(`memex-mcp: ready (http ${httpHost}:${httpPort})`);
  } else {
    const transport = new StdioServerTransport();
    // stdio: the MCP client owns this process. When it goes away, stdin closes —
    // exit rather than orphaning. The HTTP daemon intentionally does NOT do this;
    // it is long-lived and managed by systemd.
    process.stdin.on("end", () => shutdown("client-disconnect"));
    process.stdin.on("close", () => shutdown("client-disconnect"));
    await server.connect(transport);
    // Readiness signal: emitted AFTER the transport is connected and all signal
    // handlers are armed. Tests key off this (not "dreaming scheduled", which
    // fires earlier) so they never signal a half-initialized server.
    console.error("memex-mcp: ready (stdio)");
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
    // Auth: bearer token via Authorization header. /health is exempt so Docker/k8s
    // liveness probes (which can't send a bearer) can check it.
    if (authToken && req.url !== "/health") {
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
      res.end(JSON.stringify({ ok: true, version: VERSION, sessions: sessions.size }));
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
