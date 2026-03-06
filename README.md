# memory-unified

An [OpenClaw](https://github.com/nichochar/openclaw) memory plugin that unifies conversation memory and document search with shared embedding and reranker backends.

## What It Does

- **Conversation memory** — store, recall, forget, and update memories with a 7-stage hybrid retrieval pipeline (vector + BM25 + cross-encoder rerank + recency/importance scoring)
- **Document search** — index workspace markdown files with chunked embeddings and hybrid search
- **Unified recall** — one query fans out to both stores in parallel, normalizes scores, merges results with source attribution, and optionally cross-reranks

## Built On

This plugin forks and unifies two existing projects:

### [memory-lancedb-pro](https://github.com/win4r/memory-lancedb-pro) by win4r

LanceDB-based conversation memory plugin for OpenClaw. Provides the core memory pipeline: vector + BM25 hybrid search, cross-encoder reranking, multi-scope agent isolation, auto-capture, session memory, and a management CLI.

Most of `src/` is forked from this project. `tools.ts` and `index.ts` were extended to integrate unified recall and document search.

**License:** MIT

### [QMD](https://github.com/tobi/qmd) by Tobi Lutke

On-device hybrid search for markdown files with BM25, vector search, and LLM reranking. Provides the document indexing and search layer.

The `src/qmd/` directory contains a fork of QMD imported as a library. The only significant modification is `llm.ts`, which was rewritten to use OpenAI-compatible HTTP endpoints instead of `node-llama-cpp`.

**License:** MIT — Copyright (c) 2024-2026 Tobi Lutke

### New in this project

- **`src/unified-recall.ts`** — fan-out to both stores, score normalization, merge, optional cross-source reranking, early termination
- **`src/doc-indexer.ts`** — library wrapper around QMD store for background document indexing
- **`tests/`** — 145 tests across 10 test files + benchmark suite

## Setup

```bash
# Install dependencies
npm install

# Run tests
node --import jiti/register --test tests/*.test.ts

# Deploy
cp -r . ~/.openclaw/plugins/memory-unified/
# Update openclaw.json to load memory-unified, restart gateway
```

## License

MIT
