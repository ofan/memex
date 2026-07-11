# Unified Memory System — Requirements

**Project:** `memex`
**Status:** Active — 905+ tests passing, benchmarks stable, MCP server deployed
**Updated:** 2026-07-11

---

## Goal

A single OpenClaw memory plugin that:
1. Uses a **SQLite memory store** for conversation memory (store/recall/forget/update)
2. Provides **document search** for workspace documents
3. Shares one **embedding + reranker endpoint** (llama.cpp or compatible server or cloud API)
4. Merges results from both in a unified recall pipeline

---

## Architecture

```
memex (OpenClaw plugin, kind: "memory")
│
├── Single SQLite Database
│   ├── Conversation memory tables (memories, FTS5 index, embeddings via sqlite-vec)
│   ├── Document search tables (documents, sections, FTS5 indexes, embeddings via sqlite-vec)
│   └── Unified retriever pipeline across both
│
├── Conversation Memory
│   ├── All existing tools: recall, store, forget, update
│   ├── 7-stage scoring pipeline (hybrid, rerank, recency, importance, time decay, length norm, MMR)
│   ├── Auto-capture, auto-recall, session memory
│   ├── Multi-scope agent isolation
│   └── Embedding via shared OpenAI-compat endpoint
│
├── Document Search
│   ├── Smart markdown chunking (scored break points, code fence detection)
│   ├── LLM query expansion (lex/vec/HyDE)
│   ├── Chunk-level reranking
│   ├── Dual-granularity FTS5 + sqlite-vec hybrid search
│   ├── Content-addressable dedup
│   └── Embedding via shared OpenAI-compat endpoint
│
├── Unified Recall
│   ├── Fan out to both stores in parallel
│   ├── Normalize scores (different distributions)
│   ├── Merge results with source attribution
│   ├── Shared reranking pass
│   └── Return top-k
│
└── Shared Embedding/Reranker Config
    ├── One config block for embedding: { baseURL, apiKey, model }
    ├── One config block for reranker: { endpoint, apiKey, model, provider }
    ├── Works with: llama.cpp or compatible server, Gemini API, Jina API, or any OpenAI-compat endpoint
    └── Model swappable via config (re-embed on model change)
```

---

## Key Source Files

- `src/memory.ts` — SQLite storage (vector + BM25 + CRUD for conversation memories)
- `src/search.ts` — Document search functions (index, query, hybrid search)
- `src/llm.ts` — OpenAI-compat embedding + reranking + query expansion
- `src/retriever.ts` — Retrieval pipeline + rerank utils (cross-encoder + LLM)
- `src/unified-retriever.ts` — Fan-out, normalize, merge, cross-rerank
- `src/doc-indexer.ts` — Document indexer (startup + periodic re-index)
- `src/embedder.ts` — Shared embedding client + LRU cache

---

## Embedding + Reranking

All embedding and reranking calls use an OpenAI-compatible HTTP client (`src/llm.ts`):
```typescript
const client = new OpenAI({ baseURL: config.embedding.baseURL, apiKey: config.embedding.apiKey });
const resp = await client.embeddings.create({ model: config.embedding.model, input: text });
```

Query expansion (HyDE) uses LLM generation via the chat endpoint through the configurable `generation` block. Uses the same OpenAI-compatible proxy as embedding and reranking.

Reranking supports two backends: cross-encoder (Qwen3-Reranker-0.6B, default) and LLM-based ordering reranker (opt-in via `MEMEX_RERANK_LLM_MODEL` env var).

---

## Plugin Config Schema

```json
{
  "embedding": {
    "baseURL": "http://localhost:<port>/v1",
    "apiKey": "unused",
    "model": "Qwen3-Embedding-4B-Q8_0",
    "dimensions": 2560
  },
  "reranker": {
    "enabled": true,
    "endpoint": "https://<proxy-host>/v1/rerank",
    "apiKey": "<api-key>",
    "model": "Qwen3-Reranker-0.6B-Q8_0",
    "provider": "jina"
  },
  "dbPath": "~/.openclaw/memory/memex/memex.sqlite",
  "autoCapture": true,
  "autoRecall": true,
  "documents": {
    "enabled": true,
    "paths": [
      { "path": "/path/to/workspace/agent-name", "name": "agent-name", "pattern": "**/*.md" },
      { "path": "/path/to/workspace/projects", "name": "projects", "pattern": "**/*.md" }
    ],
    "syncInterval": "5m",
    "embedInterval": "1h",
    "queryExpansion": true
  },
  "scopes": {
    "default": "global",
    "agentAccess": {
      "main": ["global", "agent:main"],
      "infra": ["global", "agent:infra"]
    }
  }
}
```

---

## Model Swappability

Embedding and reranker models are hot-swappable via config. Switching is a `baseURL` + `model` change.

### Known Embedding Models
- `Qwen3-Embedding-4B-Q8_0` — 2560d, local inference ← production default
- `Qwen3-Embedding-0.6B-Q8_0` — 1024d, local inference ← code default
- `gemini-embedding-001` — 3072d, Gemini API, ~250ms
- `stella_en_1.5B_v5` — 1536d, local, MTEB 71.19 (best under 2B)

### Known Reranker Models
- `Qwen3-Reranker-0.6B-Q8_0` — local cross-encoder, 32K context ← current default
- `jina-reranker-v3` — API, BEIR 61.9
- `gte-reranker-modernbert-base` — local, 149M params, smallest
- LLM reranker (ordering-based, e.g. deepseek-v4-flash) — opt-in via `MEMEX_RERANK_LLM_MODEL`

### Re-embedding on Model Switch
- CLI: `memex rebuild --all`
- Detect dimension mismatch on startup → warn + block until rebuild

---

## Local Inference

**Running:** llama.cpp server via systemd, managed by `<model-server>` on Tailscale.
- Qwen3-Embedding-4B-Q8_0 — embedding, 2560 dims (configurable)
- Qwen3-Reranker-0.6B-Q8_0 — cross-encoder reranking
- Configurable LLM for query expansion and generation

**Config:** private config repo
- `groups.inference.swap: false` — keeps all models loaded simultaneously
- `--batch-size 8192 --ubatch-size 8192` to avoid "too large to process" errors
- All models preloaded on startup

---

## CLI Commands

CLI commands run through the OpenClaw plugin system (`openclaw memex <command>`) or via the `memex-mcp` binary for the MCP server.

| Command | Description |
|---------|-------------|
| `memex import` | Bulk-import past sessions as memories |
| `memex rebuild` | Re-embed and reindex all data (also cleans noise) |
| `memex wipe` | Purge all data from the database |
| `memex stats` | Show memory pool statistics |
| `memex dream` | Run memory consolidation (dedup, noise removal, reflection) |
| `memex search [query]` | Search memories and documents |
| `memex-mcp` | Start standalone MCP server (HTTP or stdio transport) |

---

## Non-Goals

- Multi-machine sync
- PDF / non-markdown indexing

Note: An MCP server with HTTP transport now exists (`src/mcp-server.ts`, `memex-mcp` bin) — this was promoted from non-goal to shipped feature in v0.7.0.
