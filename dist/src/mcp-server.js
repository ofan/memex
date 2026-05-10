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
import { createServer as createHttpServer } from "node:http";
import { z } from "zod";
import { MemoryStore } from "./memory.js";
import { createRetriever } from "./retriever.js";
import { createEmbedder } from "./embedder.js";
import { isNoise } from "./noise-filter.js";
import { runDreamCycle } from "./dreaming.js";
import { detectCategory } from "../index.js";
export function createMemexMcpServer(options) {
    const { dbPath, vectorDim, embedder, reflectionLLM, dreamIntervalMs, noDream } = options;
    const dim = vectorDim ?? embedder?.dimensions ?? 8;
    const store = new MemoryStore({ dbPath, vectorDim: dim });
    const retriever = embedder
        ? createRetriever(store, embedder, { mode: "hybrid", rerank: "none" })
        : null;
    const server = new McpServer({ name: "memex", version: "0.6.0" }, {
        capabilities: { tools: {} },
        instructions: [
            "You have access to a long-term memory system (memex).",
            "At the START of each conversation, call memory_recall with a query based on the user's first message to load relevant context.",
            "When you learn a new preference, fact, decision, or important insight, call memory_store to save it for future conversations.",
            "Do NOT store: ephemeral file paths, temporary debugging state, or information already in the current conversation context.",
            "DO store: user preferences, architectural decisions, project conventions, lessons learned, infrastructure details.",
            "Memory is shared across all your sessions — what you store now will be recalled in future conversations.",
        ].join(" "),
    });
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
        const { text, category, importance = 0.7 } = _params;
        if (isNoise(text)) {
            return { content: [{ type: "text", text: JSON.stringify({ rejected: true, reason: "noise" }) }] };
        }
        const resolvedCategory = category || detectCategory(text);
        const vector = embedder ? await embedder.embedPassage(text) : new Array(dim).fill(0);
        const entry = await store.store({
            text,
            vector,
            category: resolvedCategory,
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
        const { query, limit = 5 } = _params;
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
        const { id } = _params;
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
        const { phase = "all" } = _params;
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
        const total = db.prepare("SELECT COUNT(*) as c FROM memories").get().c;
        const cats = db.prepare("SELECT category, COUNT(*) as c FROM memories GROUP BY category").all();
        const byCategory = {};
        for (const row of cats)
            byCategory[row.category] = row.c;
        const neverRecalled = db.prepare("SELECT COUNT(*) as c FROM memories WHERE recall_count IS NULL OR recall_count = 0").get().c;
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
    const flagIndex = (flag) => args.indexOf(flag);
    const flagValue = (flag) => {
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
    const dreamInterval = parseInt(flagValue("--dream-interval") || process.env.MEMEX_DREAM_INTERVAL || "86400000", 10);
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
    // Background dreaming — periodic schedule
    if (!noDream) {
        const dreamConfig = {
            enabled: true,
            phases: { light: true, deep: true, reflection: !!reflectionLLM },
            reflectionLLM,
        };
        const runDream = async (reason) => {
            try {
                const result = await runDreamCycle(store, dreamConfig);
                const parts = [
                    result.light ? `light(deduped=${result.light.deduped},noise=${result.light.noiseRemoved})` : null,
                    result.deep ? `deep(rescored=${result.deep.rescored},decayed=${result.deep.decayed})` : null,
                    result.reflection ? `reflect(learnings=${result.reflection.learnings},contradictions=${result.reflection.contradictions})` : null,
                ].filter(Boolean).join(" ");
                console.error(`memex-mcp: dream [${reason}] (${result.duration_ms}ms) ${parts}`);
            }
            catch (err) {
                console.error("memex-mcp: dream failed:", err instanceof Error ? err.message : err);
            }
        };
        // Initial run shortly after startup, then on interval
        setTimeout(() => runDream("startup"), 5 * 60_000);
        setInterval(() => runDream("scheduled"), dreamInterval);
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
        await startHttpServer(factory, { port: httpPort, host: httpHost, authToken });
    }
    else {
        const transport = new StdioServerTransport();
        await server.connect(transport);
    }
}
async function startHttpServer(serverFactory, opts) {
    const { port, host, authToken } = opts;
    const { randomUUID } = await import("node:crypto");
    // Per-session transports. Each MCP client gets its own session and transport.
    const sessions = new Map();
    const httpServer = createHttpServer(async (req, res) => {
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
                let parsedBody;
                if (req.method === "POST") {
                    parsedBody = await readJsonBody(req);
                }
                const sessionId = req.headers["mcp-session-id"];
                let transport;
                if (sessionId && sessions.has(sessionId)) {
                    // Existing session — route to its transport
                    transport = sessions.get(sessionId);
                }
                else if (!sessionId && isInitializeRequest(parsedBody)) {
                    // New session — create transport + dedicated server instance
                    const newId = randomUUID();
                    transport = new StreamableHTTPServerTransport({
                        sessionIdGenerator: () => newId,
                        enableJsonResponse: true,
                        onsessioninitialized: (id) => sessions.set(id, transport),
                    });
                    transport.onclose = () => {
                        if (transport.sessionId)
                            sessions.delete(transport.sessionId);
                    };
                    const sessionServer = serverFactory();
                    await sessionServer.connect(transport);
                }
                else {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        jsonrpc: "2.0",
                        error: { code: -32000, message: "Bad Request: provide Mcp-Session-Id, or initialize first" },
                        id: null,
                    }));
                    return;
                }
                await transport.handleRequest(req, res, parsedBody);
            }
            catch (err) {
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
    await new Promise((resolve) => {
        httpServer.listen(port, host, () => resolve());
    });
    console.error(`memex-mcp: HTTP transport listening on http://${host}:${port}/mcp`);
    if (!authToken) {
        console.error(`memex-mcp: WARNING — no --auth-token set, daemon is open to anyone on ${host}`);
    }
}
function isInitializeRequest(body) {
    if (Array.isArray(body))
        return body.some(isInitializeRequest);
    return typeof body === "object" && body !== null
        && body.method === "initialize";
}
async function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
            try {
                const body = Buffer.concat(chunks).toString("utf-8");
                resolve(body.length > 0 ? JSON.parse(body) : undefined);
            }
            catch (err) {
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
//# sourceMappingURL=mcp-server.js.map