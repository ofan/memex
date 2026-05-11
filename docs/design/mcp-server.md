# MCP Server Design

**Date:** 2026-04-12
**Project:** Project 2 from `docs/plans/02-projects.md`
**Goal:** Memex as a standalone, always-on memory server via MCP (stdio transport)

---

## Architecture

```
┌─────────────────┐     stdio      ┌──────────────────────┐
│  Claude Code    │ ◄────────────► │  memex-mcp-server    │
│  Cursor / Zed   │    JSON-RPC    │                      │
│  Any MCP client │                │  ┌────────────────┐  │
└─────────────────┘                │  │ MemoryStore     │  │
                                   │  │ (shared SQLite) │  │
┌─────────────────┐                │  └────────────────┘  │
│  OpenClaw       │ ◄── same DB ──►│                      │
│  (plugin path)  │                │  ┌────────────────┐  │
└─────────────────┘                │  │ Dream timer     │  │
                                   │  │ (setInterval)   │  │
                                   │  └────────────────┘  │
                                   └──────────────────────┘
```

**Key insight:** MCP server and OpenClaw plugin share the same SQLite file. SQLite supports concurrent readers + WAL mode for writer concurrency. No sync protocol needed.

## Entry point

`src/mcp-server.ts` — standalone Node.js process.

```bash
# Run directly
npx tsx src/mcp-server.ts --db ~/.openclaw/memory/memex/memex.sqlite

# Or via package.json bin
memex-mcp --db ~/.openclaw/memory/memex/memex.sqlite
```

## SDK

`@modelcontextprotocol/sdk` v1.29.0 (already in node_modules via openclaw transitive dep).

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
Input:  { query: string, limit?: number }
Output: { results: [{ id, text, category, score }] }
```

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

The MCP server needs an embedder for `memory_recall` (vector search) and `memory_store` (embed new memories). Options:

1. **Require embedding endpoint** — `--embed-endpoint` and `--embed-api-key` CLI flags
2. **BM25-only fallback** — if no embedder configured, use FTS-only search (degraded but functional)

Start with option 1 (required). The user already has an embedding endpoint configured for OpenClaw.

## CLI flags

```
--db <path>           SQLite database path (required)
--embed-endpoint <url> Embedding API endpoint (required for vector search)
--embed-api-key <key>  Embedding API key
--embed-model <name>   Embedding model name
--dream-interval <ms>  Dream cycle interval (default: 86400000 = 24h)
--no-dream            Disable background dreaming
```

## .mcp.json for Claude Code

```json
{
  "mcpServers": {
    "memex": {
      "command": "npx",
      "args": ["tsx", "/path/to/memex/src/mcp-server.ts",
               "--db", "~/.openclaw/memory/memex/memex.sqlite",
               "--embed-endpoint", "http://<embed-host>:<port>/v1/embeddings",
               "--embed-api-key", "your-key"],
      "env": {}
    }
  }
}
```

## File structure

```
src/mcp-server.ts      — entry point, CLI parsing, server setup
tests/mcp-server.test.ts — unit tests (mock transport)
```

All memory logic reuses existing modules: `MemoryStore`, `createRetriever`, `Embedder`, `runDreamCycle`. No duplication.

## Testing strategy

Unit tests with a mock transport (in-memory, not stdio). Test each tool handler independently. Integration test: spawn server as child process, send JSON-RPC over stdin, verify stdout responses.
