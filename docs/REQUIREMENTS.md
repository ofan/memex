# Unified Memory System — Requirements

**Project:** `memory-unified`
**Status:** Complete — 145 tests passing, benchmarks stable, ready for deployment
**Updated:** 2026-03-05

---

## Goal

A single OpenClaw memory plugin that:
1. Uses **LanceDB Pro** for conversation memory (store/recall/forget/update)
2. Uses **QMD** (imported as library) for workspace document search
3. Shares one **embedding + reranker endpoint** (llama.cpp on Mac Mini or cloud API)
4. Merges results from both in a unified recall pipeline

---

## Architecture

```
memory-unified (OpenClaw plugin, kind: "memory")
│
├── Conversation Memory (LanceDB Pro — forked)
│   ├── All existing tools: recall, store, forget, update
│   ├── 7-stage scoring pipeline (hybrid, rerank, recency, importance, time decay, length norm, MMR)
│   ├── Auto-capture, auto-recall, session memory
│   ├── Multi-scope agent isolation
│   └── Embedding via shared OpenAI-compat endpoint
│
├── Document Search (QMD — imported as library, forked)
│   ├── Smart markdown chunking (scored break points, code fence detection)
│   ├── LLM query expansion (lex/vec/HyDE)
│   ├── Chunk-level reranking
│   ├── FTS5 + sqlite-vec hybrid search
│   ├── Content-addressable dedup
│   └── Embedding via shared OpenAI-compat endpoint (MODIFIED: replace node-llama-cpp)
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
    ├── Works with: llama.cpp on Mac Mini, Gemini API, Jina API, or any OpenAI-compat endpoint
    └── Model swappable via config (re-embed on model change)
```

---

## What We're Forking

### LanceDB Pro (v1.0.22, ~5150 LOC)
Keep everything. Modify:
- Embedding config to use shared endpoint config
- Recall path to also query QMD and merge results

### QMD (~9000 LOC)
Import as library (not MCP, not HTTP). Modify:
- **Replace `node-llama-cpp` embedding calls** with OpenAI-compat HTTP client (same as LanceDB Pro's embedder)
- Embedding config accepts `{ baseURL, apiKey, model }` instead of local model path
- Reranker config accepts shared endpoint

Key QMD files:
- `qmd.ts` — exports all search/index functions directly
- `store.ts` — SQLite + sqlite-vec storage layer
- `llm.ts` — embedding + reranking + query expansion (MAIN MODIFICATION TARGET)
- `collections.ts` — workspace path management
- `db.ts` — SQLite database setup
- `formatter.ts` — result formatting

---

## QMD Embedding Modification

**Current (node-llama-cpp):**
```typescript
// llm.ts — loads GGUF model directly
const model = await loadModel(modelPath);
const embedding = await model.embed(text);
```

**Target (OpenAI-compat HTTP):**
```typescript
// llm.ts — calls shared endpoint
const client = new OpenAI({ baseURL: config.embedding.baseURL, apiKey: config.embedding.apiKey });
const resp = await client.embeddings.create({ model: config.embedding.model, input: text });
```

Same change for reranker calls. The query expansion (HyDE) uses LLM generation via the chat endpoint:
- **Qwen3-0.6B-Instruct** on Mac Mini (:8090, model `Qwen3-0.6B-Instruct`)
- Use `/no_think` prefix or `enable_thinking: false` to disable reasoning overhead
- Fallback: cloud LLM API or disabled (raw query)

---

## Plugin Config Schema

```json
{
  "embedding": {
    "baseURL": "http://100.122.104.26:8090/v1",
    "apiKey": "unused",
    "model": "Qwen3-Embedding-0.6B-Q8_0",
    "dimensions": 1024
  },
  "reranker": {
    "enabled": true,
    "endpoint": "http://100.122.104.26:8090/v1/rerank",
    "apiKey": "unused",
    "model": "bge-reranker-v2-m3-Q8_0",
    "provider": "jina"
  },
  "conversation": {
    "dbPath": "~/.openclaw/memory/lancedb-pro",
    "autoCapture": true,
    "autoRecall": false
  },
  "documents": {
    "enabled": true,
    "dbPath": "~/.openclaw/memory/qmd",
    "paths": [
      { "path": "/home/ubuntu/openclaw-workspace/cabbie", "name": "cabbie", "pattern": "**/*.md" },
      { "path": "/home/ubuntu/openclaw-workspace/projects", "name": "projects", "pattern": "**/*.md" }
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
- `Qwen3-Embedding-0.6B-Q8_0` — 1024d, local on Mac Mini, ~45ms ← current
- `gemini-embedding-001` — 3072d, Gemini API, ~250ms
- `stella_en_1.5B_v5` — 1536d, local, MTEB 71.19 (best under 2B)

### Known Reranker Models
- `bge-reranker-v2-m3-Q8_0` — local on Mac Mini, ~61ms ← current
- `jina-reranker-v3` — API, BEIR 61.9
- `gte-reranker-modernbert-base` — local, 149M params, smallest

### Re-embedding on Model Switch
- CLI: `memory-unified reindex --all`
- Detect dimension mismatch on startup → warn + block until reindex

---

## Local Inference (Mac Mini M4)

**Running:** llama-swap v197 on port 8090, launchd `com.openclaw.llama-swap`
- Qwen3-Embedding-0.6B-Q8_0 (610MB) — embedding, 1024 dims
- bge-reranker-v2-m3-Q8_0 (606MB) — reranking
- Qwen3-0.6B-Instruct-Q8_0 (767MB) — chat/query expansion

**Config:** `~/etc/llama-swap.yaml`
- `groups.inference.swap: false` — keeps all 3 models loaded simultaneously
- `--batch-size 8192 --ubatch-size 8192` on embedding + reranker (avoids "too large to process")
- Dynamic ports via `${PORT}` macro (5800, 5801, 5802)
- All preloaded on startup

**~3.5GB VRAM** of 12.7GB, ~9GB headroom for TTS + future models
**Config repo:** `github.com/ofan/maclaw` (private)

---

## Implementation Steps

1. Fork LanceDB Pro → `~/projects/memory-unified/`
2. Fork QMD → `~/projects/memory-unified/qmd/` (or as dependency)
3. Modify QMD `llm.ts`: replace node-llama-cpp with OpenAI-compat HTTP client
4. Add shared embedding/reranker config to plugin
5. Wire QMD's search functions into the recall path
6. Add unified recall: fan-out, score normalization, merge, shared rerank
7. Add source attribution to results (`source: "conversation" | "document"`)
8. Test conversation memory (backward compat)
9. Test document search (index workspace, search)
10. Test unified recall (both sources)
11. Deploy, swap in config

---

## Non-Goals

- Replacing LanceDB with SQLite for conversation memory (decided: keep LanceDB)
- Replacing QMD's SQLite with LanceDB for documents (decided: keep SQLite)
- MCP server / HTTP API
- Multi-machine sync
- PDF / non-markdown indexing
