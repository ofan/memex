# MCP Server Design

**Date:** 2026-04-12 · **Updated:** 2026-07-11
**Project:** Project 2 from `docs/plans/02-projects.md`
**Goal:** Memex as a standalone, always-on memory server via MCP (stdio + HTTP transports)

---

## Architecture

```
┌─────────────────┐     stdio/HTTP  ┌──────────────────────┐
│  Claude Code    │ ◄─────────────► │  memex-mcp-server    │
│  Cursor / Zed   │    JSON-RPC     │                      │
│  Any MCP client │                 │  ┌────────────────┐  │
└─────────────────┘                 │  │ MemoryStore     │  │
                                    │  │ (shared SQLite) │  │
┌─────────────────┐                 │  └────────────────┘  │
│  OpenClaw       │ ◄── same DB ──► │                      │
│  (plugin path)  │                 │  ┌────────────────┐  │
└─────────────────┘                 │  │ Dream timer     │  │
                                    │  │ (setInterval)   │  │
                                    │  └────────────────┘  │
                                    └──────────────────────┘
```

**Key insight:** MCP server and OpenClaw plugin share the same SQLite file. SQLite supports concurrent readers + WAL mode for writer concurrency. No sync protocol needed.

## Entry point

`src/mcp-server.ts` — standalone Node.js process. Supports two transports:

### stdio mode (default)

```bash
# Run directly
npx tsx src/mcp-server.ts --db ~/.openclaw/memory/memex/memex.sqlite

# Or via package.json bin
memex-mcp --db ~/.openclaw/memory/memex/memex.sqlite
```

### HTTP daemon mode (deployed)

```bash
memex-mcp --http 7878 --http-host 0.0.0.0 --auth-token <token> \
  --db ~/.openclaw/memory/memex/memex.sqlite \
  --embed-endpoint http://<proxy-host>:<port>/v1/embeddings \
  --embed-api-key <key> --embed-model qwen3-embedding
```

The HTTP daemon runs as a long-lived process (managed by systemd). Each MCP client session gets its own `McpServer` instance with a dedicated `StreamableHTTPServerTransport`. Bearer token auth protects all non-/health endpoints.

## SDK

`@modelcontextprotocol/sdk` ^1.29.0 — now a **direct dependency** in `package.json` (was transitive via openclaw; broke on bump, fixed in PR #104).

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";  // or use SDK's zod-compat
```

## Tools

Five tools, mirroring the OpenClaw plugin tools but simplified (no scope manager, no unified retriever — just MemoryRetriever for now):

### memory_store
```
Input:  { text: string, category?: string, importance?: number }
Output: { id: string, text: string, category: string, importance: number }
```

### memory_recall
```
Input:  { query: string, limit?: number, scopes?: string[], agent_id?: string, session_id?: string }
Output: { results: [{ id, anchor, text, category, scope, score, source }] }
```
Supports hybrid retrieval (vector + BM25). The `source` field indicates provenance: "vector", "lexical", "both", or "reranked". Reranking is env-var gated (cross-encoder via MEMEX_RERANK_*, LLM reranker via MEMEX_RERANK_LLM_MODEL). Falls back to BM25-only when no embedder is configured.

### memory_forget
```
Input:  { id: string }
Output: { deleted: boolean }
```

### memory_dream
```
Input:  { phase?: "light" | "deep" | "all" }
Output: { light?: {...}, deep?: {...}, duration_ms: number }
```

### memory_stats
```
Input:  {}
Output: { total: number, byCategory: {...}, byImportance: {...}, neverRecalled: number }
```

## Shared DB strategy

- SQLite WAL mode (already enabled by MemoryStore)
- Both OpenClaw plugin and MCP server open the same file
- SQLite handles concurrent readers natively
- Writes are serialized by SQLite's WAL lock — safe for concurrent processes
- No custom locking needed

## Background dreaming

```typescript
// After MCP server connects, start dream timer
const DREAM_INTERVAL = config.dreamIntervalMs ?? 24 * 60 * 60 * 1000; // daily
setInterval(async () => {
  await runDreamCycle(store, { enabled: true, phases: { light: true, deep: true, reflection: false } });
}, DREAM_INTERVAL);
```

This works because the MCP server is a long-lived process (stdio keeps it alive as long as the client is connected).

## Embedding

The MCP server needs an embedder for `memory_recall` (vector search) and `memory_store` (embed new memories). The embedder uses an OpenAI-compatible API endpoint. Current production deployment uses qwen3-embedding (Qwen3-Embedding-4B) routed through a single llm-proxy.

Options:
1. **Require embedding endpoint** — `--embed-endpoint` and `--embed-api-key` CLI flags
2. **BM25-only fallback** — if no embedder configured, use FTS-only search (degraded but functional)

The daemon runs with option 1 in production. When `--embed-endpoint` is absent, the server prints a warning and falls back to BM25-only mode.

## CLI flags

```
--db <path>            SQLite database path (required, or MEMEX_DB_PATH)
--embed-endpoint <url>  Embedding API endpoint (required for vector search)
--embed-api-key <key>   Embedding API key
--embed-model <name>    Embedding model name
--embed-dim <int>       Embedding dimensions (optional, auto-detected)
--http <port>           Enable HTTP daemon mode (default: stdio)
--http-host <host>      HTTP bind host (default: 127.0.0.1)
--auth-token <token>    Bearer token for HTTP auth (MEMEX_AUTH_TOKEN)
--llm-endpoint <url>    LLM API endpoint for dreaming reflection
--llm-model <name>      LLM model name for dreaming reflection
--llm-api-key <key>     LLM API key (falls back to embed API key)
--llm-timeout <ms>      LLM request timeout in ms
--dream-interval <ms>   Dream cycle interval (default: 86400000 = 24h)
--no-dream              Disable background dreaming
```

Additional env vars (not CLI flags):
- `MEMEX_RERANK_ENDPOINT`, `MEMEX_RERANK_API_KEY`, `MEMEX_RERANK_MODEL` — cross-encoder reranker
- `MEMEX_RERANK_LLM_MODEL` — opt-in LLM reranker (requires MEMEX_LLM_ENDPOINT)
- `MEMEX_HARD_MIN_SCORE_OVERRIDE` — runtime override for the score floor
- `MEMEX_RELEVANCE_FIRST` — opt-in temporal signal caps
- `MEMEX_DEBUG_RECALL` — writes per-turn debug snapshots
- `MEMEX_CLIENT_NAME` — overrides auto-detected MCP client identity

## .mcp.json for Claude Code

### Local stdio mode:
```json
{
  "mcpServers": {
    "memex": {
      "command": "npx",
      "args": ["tsx", "/path/to/memex/src/mcp-server.ts",
               "--db", "~/.openclaw/memory/memex/memex.sqlite",
               "--embed-endpoint", "http://<proxy-host>:<port>/v1/embeddings",
               "--embed-api-key", "<key>"],
      "env": {
        "MEMEX_RERANK_ENDPOINT": "http://<proxy-host>:<port>/v1/rerank",
        "MEMEX_RERANK_API_KEY": "<key>",
        "MEMEX_RERANK_MODEL": "Qwen3-Reranker-0.6B"
      }
    }
  }
}
```

### Remote HTTP daemon mode (shared across devices):
```json
{
  "mcpServers": {
    "memex": {
      "type": "http",
      "url": "http://<memex-daemon-host>:<port>/mcp",
      "headers": {
        "Authorization": "Bearer ${MEMEX_AUTH_TOKEN}"
      }
    }
  }
}
```

Env vars for HTTP mode: `MEMEX_ENDPOINT` (base URL, e.g. `http://<host>:<port>/mcp`), `MEMEX_AUTH_TOKEN`.

## File structure

```
src/mcp-server.ts       — entry point, CLI parsing, server setup (stdio + HTTP)
src/retriever.ts         — MemoryRetriever (hybrid vector + BM25, reranker)
src/rerankers/           — llm-reranker.ts (LLM-based relevance judge)
src/transient-retry.ts   — retry helper (500/502/503/504 + timeouts)
src/embedder.ts          — OpenAI-compatible embedding client
src/memory.ts            — MemoryStore (SQLite + FTS5 + sqlite-vec)
src/dreaming.ts          — memory consolidation (light/deep/reflection)
tests/mcp-server.test.ts — unit tests (mock transport)
```

All memory logic reuses existing modules: `MemoryStore`, `createRetriever`, `Embedder`, `runDreamCycle`. No duplication.

## Testing strategy

Unit tests with a mock transport (in-memory, not stdio). Test each tool handler independently. Integration test: spawn server as child process, send JSON-RPC over stdin, verify stdout responses.
