# CLAUDE.md — memory-unified

## What This Is

An OpenClaw memory plugin that unifies conversation memory (LanceDB Pro) and document search (QMD) with shared embedding/reranker backends.

## Architecture

```
memory-unified plugin
├── LanceDB Pro (forked) → conversation memory
├── QMD (forked, imported as library) → document search
├── Unified recall → fan-out both, merge, rerank
└── Shared embedding + reranker config → llama.cpp on Mac Mini or cloud API
```

## Key Modification: QMD Embedding Layer

QMD currently uses `node-llama-cpp` for local embedding. We need to replace that with an OpenAI-compatible HTTP client so it can use the shared endpoint (llama.cpp on Mac Mini at `http://100.122.104.26:8090/v1`).

**Target file:** QMD's `llm.ts` (or equivalent embedding module)
**Change:** Replace `node-llama-cpp` model.embed() calls with OpenAI SDK embeddings.create() calls
**Same change for reranker calls**

LLM query expansion (HyDE) in QMD uses generation — configure to use chat endpoint or disable.

## Project Structure

```
memory-unified/
├── CLAUDE.md              ← you are here
├── REQUIREMENTS.md        ← full requirements
├── RESEARCH.md            ← model comparisons, benchmarks, decisions
├── BENCHMARKS.md          ← latency data
├── index.ts               ← plugin entry point
├── cli.ts                 ← CLI interface
├── openclaw.plugin.json   ← plugin manifest
├── package.json
├── tsconfig.json
├── src/
│   ├── store.ts           ← LanceDB storage (from LanceDB Pro)
│   ├── retriever.ts       ← 7-stage retrieval pipeline (from LanceDB Pro)
│   ├── unified-recall.ts  ← fan-out to both stores, merge, rerank [NEW]
│   ├── embedder.ts        ← shared OpenAI-compat embedding client
│   ├── chunker.ts         ← smart document chunking (from LanceDB Pro)
│   ├── scopes.ts          ← multi-scope access control
│   ├── tools.ts           ← agent tools (recall, store, forget, update)
│   ├── noise-filter.ts    ← noise detection
│   ├── adaptive-retrieval.ts ← skip retrieval for greetings
│   └── migrate.ts         ← migration utilities
└── qmd/                   ← forked QMD source
    ├── qmd.ts             ← main exports (search, index functions)
    ├── store.ts           ← SQLite + sqlite-vec storage
    ├── llm.ts             ← MODIFIED: OpenAI-compat embedding + reranker
    ├── collections.ts     ← workspace path management
    ├── db.ts              ← SQLite setup
    └── formatter.ts       ← result formatting
```

## Starting Points

- LanceDB Pro source: `/home/ubuntu/.openclaw/plugins/memory-lancedb-pro/`
- QMD source: `/home/ubuntu/.bun/install/cache/@GH@tobi-qmd-1a67e1a@@@1/src/`

## Key Constraints

1. All existing memory tools must work identically (backward compat)
2. Same plugin kind: `"kind": "memory"` in openclaw.plugin.json
3. QMD imported as library — no MCP, no HTTP server, no separate process
4. One embedding config shared by both LanceDB Pro and QMD
5. TypeScript, no build step (OpenClaw loads .ts directly)

## Testing

1. Deploy to `~/.openclaw/plugins/memory-unified/`
2. Update openclaw.json to load it instead of memory-lancedb-pro
3. Restart gateway, verify plugin loads
4. Test conversation memory tools (should be identical)
5. Test document search (QMD indexes workspace, search returns docs)
6. Test unified recall (one query returns both memories + docs)

## Current Deployment

- **VM:** Ubuntu, Node 25.6.1, OpenClaw gateway
- **Mac Mini:** llama.cpp router on port 8090 (embedding + reranker)
- **Embedding:** Qwen3-Embedding-0.6B-Q8_0 (1024 dims, ~45ms)
- **Reranker:** bge-reranker-v2-m3-Q8_0 (~61ms)
- **LanceDB data:** `~/.openclaw/memory/lancedb-pro/`
