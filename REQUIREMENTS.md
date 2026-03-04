# Unified Memory System — Requirements

**Project:** `memory-unified`
**Status:** Requirements Gathering
**Date:** 2026-03-02

---

## Goal

A single OpenClaw memory plugin that combines:
1. **Conversation memory** (what LanceDB Pro does today) — store/recall/forget/update memories from agent conversations
2. **Document memory** (what QMD does today) — index and search workspace markdown files

Both share the same embedding and reranking backends, configurable as local (self-hosted on Mac Mini) or remote (cloud APIs).

---

## Architecture

```
memory-unified (OpenClaw plugin, kind: "memory")
│
├── Conversation Store (LanceDB table: "memories")
│   ├── store / recall / forget / update tools
│   ├── auto-capture (on conversation end)
│   ├── auto-recall (on session start, optional)
│   ├── scopes (per-agent isolation)
│   └── noise filter, adaptive retrieval
│
├── Document Store (LanceDB table: "documents")
│   ├── file watcher / indexer (markdown files from configured paths)
│   ├── chunking (split large docs into embeddable segments)
│   ├── incremental sync (only re-embed changed files)
│   └── per-agent path scoping
│
├── Unified Recall
│   ├── fan-out query to both stores
│   ├── merge results
│   ├── shared reranking pass
│   └── return combined ranked results
│
├── Embedding Layer (shared)
│   ├── OpenAI-compatible API client
│   ├── config: { baseURL, apiKey, model, dimensions }
│   ├── mode "local": points to Mac Mini service (e.g. nomic-embed-text via llama.cpp)
│   ├── mode "api": points to Gemini, OpenAI, Jina, etc.
│   ├── LRU cache (256 entries, 30min TTL)
│   └── auto-chunking for long documents
│
└── Reranker Layer (shared)
    ├── config: { endpoint, apiKey, model, provider }
    ├── mode "local": points to Mac Mini service (e.g. bge-reranker-v2-m3)
    ├── mode "api": points to Jina, Voyage, Pinecone, SiliconFlow
    ├── fallback: cosine similarity rerank if API unavailable
    └── provider adapters (jina, siliconflow, voyage, pinecone format)
```

---

## What We're Forking / Reusing

### From LanceDB Pro (v1.0.22, ~5150 LOC)
Keep almost everything as-is:
- `store.ts` — LanceDB storage layer with multi-scope support
- `retriever.ts` — 7-stage scoring pipeline (hybrid search, rerank, recency, importance, length norm, time decay, MMR diversity)
- `embedder.ts` — OpenAI-compatible embedding client with caching + chunking
- `scopes.ts` — multi-scope access control
- `tools.ts` — memory_recall, memory_store, memory_forget, memory_update tools
- `noise-filter.ts` — noise detection
- `adaptive-retrieval.ts` — skip retrieval for greetings/commands
- `chunker.ts` — smart document chunking
- `migrate.ts` — migration utilities
- `cli.ts` — CLI for stats, search, store, import/export
- `index.ts` — plugin entry point, hooks (agent_start, agent_end, etc.)

### From QMD (OpenClaw builtin)
Replace with new implementation inside the plugin:
- **File discovery** — glob patterns over configured workspace paths
- **Incremental indexing** — hash-based change detection, only re-embed modified files
- **Chunking** — split markdown files into embeddable segments (reuse existing `chunker.ts`)
- **Periodic sync** — configurable interval (default: 5m for file check, 1h for re-embed)

---

## Current QMD Config (to replicate)

```json
{
  "searchMode": "query",
  "includeDefaultMemory": false,
  "paths": [
    { "path": "/home/ubuntu/openclaw-workspace/cabbie", "name": "cabbie", "pattern": "**/*.md" },
    { "path": "/home/ubuntu/openclaw-workspace/coder", "name": "coder", "pattern": "**/*.md" },
    { "path": "/home/ubuntu/openclaw-workspace/infra", "name": "infra", "pattern": "**/*.md" },
    { "path": "/home/ubuntu/openclaw-workspace/product", "name": "product", "pattern": "**/*.md" },
    { "path": "/home/ubuntu/openclaw-workspace/projects", "name": "projects", "pattern": "**/*.md" },
    { "path": "/home/ubuntu/openclaw-workspace/research", "name": "research", "pattern": "**/*.md" },
    { "path": "/home/ubuntu/openclaw-workspace/shared", "name": "shared", "pattern": "**/*.md" }
  ],
  "update": {
    "interval": "5m",
    "embedInterval": "1h"
  },
  "limits": {
    "maxResults": 8,
    "timeoutMs": 30000
  }
}
```

---

## Plugin Config Schema

```json
{
  "embedding": {
    "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai",
    "apiKey": "${GEMINI_API_KEY}",
    "model": "gemini-embedding-001",
    "dimensions": 3072
  },
  "reranker": {
    "enabled": true,
    "endpoint": "https://api.jina.ai/v1/rerank",
    "apiKey": "${JINA_API_KEY}",
    "model": "jina-reranker-v3",
    "provider": "jina"
  },
  "conversation": {
    "dbPath": "/home/ubuntu/.openclaw/memory/lancedb-pro",
    "autoCapture": true,
    "autoRecall": false,
    "retrieval": { ... }
  },
  "documents": {
    "enabled": true,
    "dbPath": "/home/ubuntu/.openclaw/memory/lancedb-docs",
    "paths": [
      { "path": "...", "name": "cabbie", "pattern": "**/*.md" }
    ],
    "syncInterval": "5m",
    "embedInterval": "1h",
    "maxResults": 8
  },
  "scopes": { ... }
}
```

---

## Key Design Decisions

### 1. Separate LanceDB tables, shared DB directory
- `memories` table for conversations (existing)
- `documents` table for indexed files (new)
- Both in the same LanceDB database directory
- Same embedding model → same vector dimensions → could even be one table with a `type` column, but separate tables is cleaner for management

### 2. Document indexing is internal, not MCP
- No MCP server, no HTTP API for document search
- File watching and indexing happens inside the plugin process
- Results are merged into the recall pipeline directly

### 3. Embedding/reranker config is top-level, shared
- One `embedding` config block, used by both conversation and document stores
- One `reranker` config block, used by the unified recall pipeline
- Switching local↔API is just a `baseURL` change

### 4. Recall merging strategy
- Query both stores in parallel
- Normalize scores (conversation and document scores may have different distributions)
- Merge into single candidate list
- Apply shared reranking pass
- Apply existing 7-stage scoring pipeline
- Return top-k with source attribution (`source: "conversation" | "document"`)

### 5. Document chunks get metadata
- `source_file`: original file path
- `source_name`: workspace name (e.g. "cabbie", "infra")
- `chunk_index`: position within document
- `file_hash`: for incremental sync
- `last_indexed`: timestamp

---

## Existing LanceDB Pro Features to Preserve

All of these must work identically after the fork:

- [x] memory_recall tool (hybrid vector + BM25 search)
- [x] memory_store tool (with noise filter + duplicate detection)
- [x] memory_forget tool (search-based + ID-based deletion)
- [x] memory_update tool (in-place update preserving timestamp)
- [x] memory_stats tool (optional management tool)
- [x] memory_list tool (optional management tool)
- [x] Auto-capture on agent_end hook
- [x] Auto-recall on agent_start hook (optional)
- [x] Session memory on /new command
- [x] 7-stage retrieval pipeline (hybrid, rerank, recency, importance, length norm, time decay, MMR)
- [x] Multi-scope isolation (per-agent access control)
- [x] Embedding cache (LRU, 256 entries, 30min TTL)
- [x] Auto-chunking for long documents
- [x] Noise filter (denials, meta-questions, boilerplate)
- [x] Adaptive retrieval (skip greetings/commands)
- [x] CLI (stats, search, store, import/export)
- [x] Backup system (daily .jsonl export)
- [x] Migration from builtin memory
- [x] 4 reranker provider adapters (jina, siliconflow, voyage, pinecone)
- [x] Cross-encoder rerank with cosine fallback

---

## New Features (Document Store)

- [ ] File discovery via glob patterns
- [ ] Markdown file parsing and chunking
- [ ] Incremental indexing (hash-based change detection)
- [ ] Periodic sync (configurable interval)
- [ ] Document search (vector + BM25 over chunks)
- [ ] Unified recall (merge conversation + document results)
- [ ] Source attribution in results (`conversation` vs `document`)
- [ ] Per-agent document path scoping (agent X sees workspace X docs)
- [ ] CLI commands for document index management (reindex, stats, clear)

---

## Model Swappability

Embedding and reranker models must be hot-swappable via config. Switching is a `baseURL` + `model` change.

### Known Embedding Models (auto-detect dimensions)
- `gemini-embedding-001` — 3072d, API, MTEB 68.3
- `Qwen3-Embedding-0.6B` — 1024d, local, near-SOTA quality, ~1.2GB VRAM
- `stella_en_1.5B_v5` — 1536d, local, English-focused, ~3GB VRAM
- `EmbeddingGemma-300M` — local, Google on-device, ~600MB VRAM
- `nomic-embed-text-v1.5` — 768d, local, lightweight
- `text-embedding-3-small` — 1536d, OpenAI API

### Known Reranker Models
- `jina-reranker-v3` — API (Jina), BEIR 61.9, best quality
- `jina-reranker-v2-base-multilingual` — local (278M params), open-source, fast
- `gte-reranker-modernbert-base` — local (149M params), near-API quality
- `bge-reranker-v2-m3` — local (568M params), multilingual

### Re-embedding on Model Switch
When embedding model changes, all stored vectors become incompatible. Required:
- CLI: `memory-unified reindex --all` (re-embed all memories + documents)
- Detect dimension mismatch on startup → warn + block until reindex
- Keep old vectors as backup until reindex completes

## Non-Goals (for now)

- MCP server / HTTP API
- Qdrant or other vector DB backends
- Multi-machine document sync
- PDF / non-markdown indexing
- Real-time file watching (inotify) — periodic poll is fine

---

## Dependencies

- `@lancedb/lancedb` ^0.26.2 (existing)
- `openai` ^6.21.0 (existing, for embedding client)
- `@sinclair/typebox` (existing, for tool schemas)
- `openclaw/plugin-sdk` (existing)
- Node.js glob / fs (for file discovery)

---

## Migration Path

1. Fork LanceDB Pro → `~/projects/memory-unified/`
2. Add document store layer
3. Add unified recall
4. Test locally
5. Deploy to `~/.openclaw/plugins/memory-unified/`
6. Update openclaw.json: swap `memory-lancedb-pro` → `memory-unified`
7. Existing conversation memories preserved (same LanceDB table)
8. Document index builds fresh on first run
9. Remove QMD config from `memory.qmd` (or leave as fallback)

---

## Open Questions

1. **One table or two?** — Leaning toward separate `memories` and `documents` tables for cleaner management, but one table with a `type` field is simpler for unified search.
2. **Score normalization** — Document chunks and conversation memories may score differently. Need a calibration strategy for merged results.
3. **Document scope mapping** — Should workspace paths map directly to agent scopes? e.g. `cabbie` workspace → `agent:main` scope? Or separate `doc:cabbie` scopes?
4. **Chunk overlap** — How much overlap between document chunks for context continuity?
5. **Local inference service** — Separate task/project for standing up the Mac Mini embedding + reranker service. What framework? (llama.cpp server, vLLM, TEI, or simple FastAPI wrapper?)
