# CLAUDE.md — memory-unified

## What This Is

An OpenClaw memory plugin that unifies conversation memory (LanceDB Pro) and document search (QMD) with shared embedding/reranker backends. **Status: Complete — 145 tests passing, benchmarks stable.**

## Architecture

```
memory-unified plugin (kind: "memory")
├── Conversation Memory (LanceDB Pro — forked)
│   ├── All existing tools: recall, store, forget, update
│   ├── 7-stage scoring pipeline (hybrid, rerank, recency, importance, time decay, length norm, MMR)
│   ├── Auto-capture, auto-recall, session memory
│   └── Multi-scope agent isolation
│
├── Document Search (QMD — forked, imported as library)
│   ├── Smart markdown chunking (scored break points, code fence detection)
│   ├── Chunk-level reranking via FTS5 + sqlite-vec hybrid search
│   └── Content-addressable dedup
│
├── Unified Recall
│   ├── Fan-out to both stores in parallel
│   ├── Normalize scores (different distributions)
│   ├── Merge with source attribution
│   ├── Optional cross-source reranking
│   └── Early termination when conversation results are strong
│
└── Shared Embedding + Reranker
    ├── OpenAI-compatible HTTP client (works with llama.cpp, Gemini, Jina, etc.)
    ├── LRU cache (256 entries, 30min TTL, >97% hit rate)
    └── Auto-chunking for long documents
```

## Project Structure

```
memory-unified/
├── CLAUDE.md              ← you are here
├── index.ts               ← plugin entry point (register, hooks, identity)
├── openclaw.plugin.json   ← plugin manifest + full config schema
├── package.json
├── tsconfig.json
├── docs/
│   ├── REQUIREMENTS.md    ← full requirements and architecture spec
│   ├── RESEARCH.md        ← model comparisons, serving options, decisions
│   └── BENCHMARKS.md      ← latency, memory, and CPU profiling data
├── src/
│   ├── cli.ts             ← CLI interface
│   ├── store.ts           ← LanceDB storage (vector + BM25 + CRUD)
│   ├── retriever.ts       ← 7-stage retrieval pipeline + rerank utils
│   ├── unified-recall.ts  ← fan-out, normalize, merge, cross-rerank
│   ├── embedder.ts        ← shared OpenAI-compat embedding client + LRU cache
│   ├── doc-indexer.ts     ← QMD document indexer (startup + periodic re-index)
│   ├── chunker.ts         ← smart document chunking
│   ├── scopes.ts          ← multi-scope access control
│   ├── tools.ts           ← agent tools (recall, store, forget, update, doc_search)
│   ├── noise-filter.ts    ← noise detection for auto-capture filtering
│   ├── adaptive-retrieval.ts ← skip retrieval for greetings/commands
│   ├── migrate.ts         ← migration utilities from legacy formats
│   └── qmd/               ← forked QMD source (imported as library)
│       ├── qmd.ts         ← main exports (search, index functions)
│       ├── store.ts       ← SQLite + sqlite-vec storage
│       ├── llm.ts         ← MODIFIED: OpenAI-compat embedding + reranker (was node-llama-cpp)
│       ├── collections.ts ← workspace path management
│       ├── db.ts          ← SQLite setup
│       └── formatter.ts   ← result formatting
└── tests/
    ├── adaptive-retrieval.test.ts
    ├── chunker.test.ts
    ├── doc-indexer.test.ts
    ├── embedder.test.ts
    ├── noise-filter.test.ts
    ├── rerank-utils.test.ts
    ├── retriever.test.ts
    ├── scopes.test.ts
    ├── store.test.ts
    ├── unified-recall.test.ts
    └── benchmark.ts       ← latency + memory + CPU benchmark suite
```

## Forked Code

This plugin is built from two forked codebases with a new unified recall layer on top.

### LanceDB Pro (conversation memory)

Forked from `~/.openclaw/plugins/memory-lancedb-pro/`. Most `src/` files are verbatim or near-verbatim copies:

| File | Status | Changes |
|------|--------|---------|
| `adaptive-retrieval.ts` | Identical | — |
| `noise-filter.ts` | Identical | — |
| `scopes.ts` | Identical | — |
| `store.ts` | Identical | — |
| `cli.ts` | Identical | — |
| `chunker.ts` | ~Identical | Removed dead helper function |
| `embedder.ts` | ~Identical | `console.log` → `console.warn` |
| `migrate.ts` | ~Identical | `console.log` → `console.warn` |
| `retriever.ts` | ~Identical | Exported `buildRerankRequest`/`parseRerankResponse` for unified recall |
| `tools.ts` | ~8% changed | Added unified recall integration, `doc_search` tool |
| `index.ts` | ~30% new | Added QMD wiring, doc indexer lifecycle, unified recall setup |

### QMD (document search)

Forked from `@GH@tobi-qmd`. Lives in `src/qmd/`. Imported as a library (no MCP server, no separate process):

| File | Status | Changes |
|------|--------|---------|
| `store.ts` | Identical | — |
| `qmd.ts` | Identical | — |
| `collections.ts` | Identical | — |
| `db.ts` | Identical | — |
| `formatter.ts` | Identical | — |
| `llm.ts` | **Fully rewritten** | Replaced `node-llama-cpp` with OpenAI-compatible HTTP client |

### New code (this project)

| File | LOC | Purpose |
|------|-----|---------|
| `src/unified-recall.ts` | 423 | Fan-out, normalize, merge, cross-rerank, early termination |
| `src/doc-indexer.ts` | 255 | Library wrapper around QMD store for document indexing |
| `tests/*.test.ts` (10 files) | ~2400 | Full test suite |
| `tests/benchmark.ts` | 400 | Latency + memory + CPU benchmark suite |

## Key Constraints

1. All existing memory tools work identically (backward compat with LanceDB Pro)
2. Plugin kind: `"kind": "memory"` in openclaw.plugin.json
3. QMD imported as library — no MCP, no HTTP server, no separate process
4. One embedding config shared by both LanceDB Pro and QMD
5. TypeScript, no build step (OpenClaw loads .ts directly via jiti)
6. All logging uses `console.warn` (stderr) — `console.log` corrupts the stdio protocol

## Development

### Run tests (145 tests, 10 test files)

```bash
node --import jiti/register --test tests/*.test.ts
```

### Run benchmarks (requires Mac Mini llama.cpp at 100.122.104.26:8090)

```bash
node --import jiti/register tests/benchmark.ts
```

### Deploy

```bash
# Copy to plugin directory
cp -r . ~/.openclaw/plugins/memory-unified/

# Update openclaw.json to load memory-unified instead of memory-lancedb-pro
# Restart gateway
```

## Current Deployment

- **VM:** Ubuntu, Node 25.6.1, OpenClaw gateway
- **Mac Mini:** llama-swap v197 on port 8090 (3 models via Tailscale, `groups.inference.swap: false`)
- **Embedding:** Qwen3-Embedding-0.6B-Q8_0 (1024d, ~83ms uncached, <0.03ms cached)
- **Reranker:** bge-reranker-v2-m3-Q8_0 (~53ms for 5 docs)
- **Chat/Query Expansion:** Qwen3-0.6B-Instruct-Q8_0 (767MB, ~9.5ms/token)
- **Config repo:** `github.com/ofan/maclaw` (private)
- **Full hybrid+rerank pipeline:** ~250ms
- **Unified recall:** ~300-400ms
- **Memory footprint:** ~230MB RSS (LanceDB Arrow buffers dominate)

## Performance Profile

| Operation | Latency | CPU Profile |
|---|---|---|
| Embed (cached) | <0.03ms | Negligible |
| Embed (uncached, batch 5) | ~83ms | I/O bound (network) |
| Vector search | ~33ms | CPU bound (Arrow/SIMD) |
| BM25 search | ~14ms | CPU bound (FTS index) |
| Rerank (5 docs) | ~53ms | I/O bound (network) |
| Full hybrid+rerank | ~250ms | Mixed |
| Unified recall | ~300-400ms | Mixed |
| Adaptive skip check | ~0.001ms | Negligible |
