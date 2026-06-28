# Unified Memory System — Requirements

**Project:** `memex`
**Status:** Complete — 506+ tests passing, benchmarks stable, ready for deployment
**Updated:** 2026-03-15

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

- `src/store.ts` — SQLite storage (vector + BM25 + CRUD for conversation memories)
- `src/search.ts` — Document search functions (index, query, hybrid search)
- `src/llm.ts` — OpenAI-compat embedding + reranking + query expansion
- `src/retriever.ts` — 7-stage retrieval pipeline + rerank utils
- `src/unified-recall.ts` — Fan-out, normalize, merge, cross-rerank
- `src/doc-indexer.ts` — Document indexer (startup + periodic re-index)
- `src/embedder.ts` — Shared embedding client + LRU cache

---

## Embedding + Reranking

All embedding and reranking calls use an OpenAI-compatible HTTP client (`src/llm.ts`):
```typescript
const client = new OpenAI({ baseURL: config.embedding.baseURL, apiKey: config.embedding.apiKey });
const resp = await client.embeddings.create({ model: config.embedding.model, input: text });
```

Query expansion (HyDE) uses LLM generation via the chat endpoint:
- Configurable model (default deployment: Qwen3-0.6B-Instruct on local server)
- Use `/no_think` prefix or `enable_thinking: false` to disable reasoning overhead
- Fallback: cloud LLM API or disabled (raw query)

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
    "endpoint": "http://localhost:<port>/v1/rerank",
    "apiKey": "unused",
    "model": "bge-reranker-v2-m3-Q8_0",
    "provider": "jina"
  },
  "conversation": {
    "dbPath": "~/.openclaw/memory/memex.db",
    "autoCapture": true,
    "autoRecall": false
  },
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
- `Qwen3-Embedding-4B-Q8_0` — 2560d, local inference ← current default
- `Qwen3-Embedding-0.6B-Q8_0` — 1024d, local inference
- `gemini-embedding-001` — 3072d, Gemini API, ~250ms
- `stella_en_1.5B_v5` — 1536d, local, MTEB 71.19 (best under 2B)

### Known Reranker Models
- `bge-reranker-v2-m3-Q8_0` — local inference, ~61ms ← current
- `jina-reranker-v3` — API, BEIR 61.9
- `gte-reranker-modernbert-base` — local, 149M params, smallest

### Re-embedding on Model Switch
- CLI: `memex rebuild --all`
- Detect dimension mismatch on startup → warn + block until rebuild

---

## Local Inference

**Running:** <model-server> on <port>, managed by a service unit
- Qwen3-Embedding-4B-Q8_0 — embedding, 2560 dims (configurable)
- bge-reranker-v2-m3-Q8_0 (606MB) — reranking
- Qwen3-0.6B-Instruct-Q8_0 (767MB) — chat/query expansion

**Config:** `<config-path>`
- `groups.inference.swap: false` — keeps all 3 models loaded simultaneously
- `--batch-size 8192 --ubatch-size 8192` on embedding + reranker (avoids "too large to process")
- Dynamic ports via `${PORT}` macro (5800, 5801, 5802)
- All preloaded on startup

**~3.5GB VRAM** of 12.7GB, ~9GB headroom for TTS + future models
**Config repo:** `github.com/example/config` (private)

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `memex import` | Bulk-import past sessions as memories |
| `memex rebuild` | Re-embed and reindex all data (replaces re-embed/reindex; also cleans noise) |
| `memex wipe` | Purge all data from the database |

---

## Non-Goals

- MCP server / HTTP API
- Multi-machine sync
- PDF / non-markdown indexing
