# memex

Unified memory plugin for OpenClaw — conversation memory + document search in a single SQLite database. **488 tests, 19 files.**

## Architecture

```
memex (kind: "memory")
├── SQLite (FTS5 + sqlite-vec)
│   ├── memories table — recall, store, forget (3 tools)
│   ├── documents + content — markdown chunking, dual-granularity FTS
│   └── vectors_vec — shared vector store (memories + documents)
├── Unified Retriever — z-score fusion, max-sim chunked embedding, reranking
└── Embedding — OpenAI-compatible HTTP client, LRU cache
```

## Key Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin entry point, hooks, auto-recall |
| `src/memory.ts` | Memory CRUD, vectorSearch (max-sim), chunked embedding |
| `src/search.ts` | Document search (FTS5, sqlite-vec, chunking) |
| `src/unified-retriever.ts` | Single-pass retrieval pipeline |
| `src/tools.ts` | Agent tools (recall, store, forget) |
| `src/embedder.ts` | Embedding client + LRU cache |
| `src/noise-filter.ts` | Noise detection + filterAssistantText |
| `src/capture-windows.ts` | Sliding window builder |
| `src/memory-instructions.ts` | System prompt instruction |

## Docs

| Doc | Purpose |
|---|---|
| `docs/BENCHMARKS.md` | Current benchmark results |
| `docs/COMPARISON.md` | Cross-system comparison (LongMemEval) |
| `docs/RESILIENCY.md` | Embedding state machine, failure modes |
| `docs/flow.md` | Per-turn pipeline flow |
| `docs/research/` | Ranking math, SOTA survey, baselines |
| `docs/plans/` | Implementation plans (numbered, chronological) |

## Constraints

1. Plugin kind: `"kind": "memory"` in openclaw.plugin.json
2. Single SQLite database for both memories and documents
3. TypeScript, no build step (OpenClaw loads .ts directly via jiti)
4. All logging uses `console.warn` (stderr) — `console.log` corrupts the stdio protocol
5. Embedding model changes are detected and user is warned (see docs/RESILIENCY.md)
6. Lazy DB init — database opens on first use, not at plugin registration

## Conventions

- Plans location: `docs/plans/`
- Docs numbered sequentially (001, 002...), chronological order
- Test: `node --import jiti/register --test tests/*.test.ts`
- Deploy: `rm -rf ~/.openclaw/plugins/memex && cp -r . ~/.openclaw/plugins/memex && rm -rf ~/.openclaw/plugins/memex/.git ~/.openclaw/plugins/memex/.clone && openclaw gateway restart`
- No `console.log` — use `console.warn`
- Embedding server URL via env var `EMBED_BASE_URL`, never hardcoded
- Test data must be anonymous — no real IPs, usernames, or env-specific references

## Performance

| Operation | Latency |
|---|---|
| Unified retriever | ~150ms p50 |
| Embed (cached) | <0.03ms |
| Vector search (1.9K) | ~4ms |
| BM25 search | <0.3ms |
