# Progress

## Last Updated: 2026-04-12

## Current State

**Retrieval quality:** 94% E2E (LongMemEval, GPT-4o), 82% R@1, 90% R@3. Domain eval 12/15.
**Test suite:** 690 tests, all passing.
**Architecture:** Single SQLite DB (no LanceDB). Dual retriever: MemoryRetriever (tools) + UnifiedRetriever (auto-recall).

## Plan Status

| Plan | Title | Status | Notes |
|---|---|---|---|
| 001 | Benchmarks design | **Superseded** | Bakeoff harness (`tests/bakeoff/`) covers the critical path. Full BEIR suite is academic overhead. |
| 002 | Benchmarks impl | **Superseded** | Same as 001. Domain eval + fast-benchmark + bakeoff is sufficient. |
| 003 | Session import v2 | **Open** | Not started. Highest-ROI quality project — 76% of memories are low-quality session imports. |
| 004 | Retrieval quality fixes | **Done** | BM25 OR matching live (`search.ts:2442`). Adaptive fusion gate live (`search.ts:3355`). |
| 005 | Chunk-level FTS | **Open** | Not started. Lower priority — depends on whether doc search quality is a bottleneck. |
| 006 | SQLite consolidation | **Done** | LanceDB dropped. Single SQLite DB. `loadLanceDB()` remains in memory.ts for migration only. |
| 007 | Rename cleanup | **Done** | `src/qmd/` flattened into `src/`. |
| 008 | Lazy DB init | **Open** | Not started. Fixes CLI hanging (issue #8). Small scope. |
| 009 | Unified retriever | **Done** | `src/unified-retriever.ts` implemented. 10-stage pipeline. Used by auto-recall. |
| 010 | Chunked embed + sliding capture | **Partially done** | Chunked embedding + `filterAssistantText` + `capture-windows.ts` exist. Sliding window auto-capture not wired into production hook. |
| 011 | Reranker modes + fallback | **Mostly done** | Qwen3-Reranker deployed. Fallback returns pool unchanged. Transient retry. Health checks. Remaining: rerank-failure cooldown to avoid per-query log spam. |
| 012 | Dreaming | **Mostly done** | Light sweep ✅, deep sweep ✅, orchestrator ✅, CLI `/dream` ✅, intake guards ✅, recall tracking ✅, backfill ✅. Remaining: reflection phase (LLM-driven, large effort), telemetry events. |

## Recently Completed (April 2026 session)

- **Entity boost + entity graph gated off** — disabled by default via `entityBoost` / `entityGraph` config flags
- **Rank-mode rerank scoring** — `rerankScoreMode: "rank"` transforms saturated reranker output into ordinal signal
- **shouldRerank gate fix** — was dead code (compared weighted score max 0.55 vs threshold 0.88)
- **In-turn recall cache** — `before_prompt_build` fires N+1 times per turn; cache dedupes
- **Reranker upgrade** — bge → Qwen3-Reranker-0.6B-Q8_0 (+4pp E2E)
- **Embed lane crash fix** — `--parallel 1` for embedding lane (upstream llama.cpp bug)
- **Transient retry** — shared `withTransientRetry` for embed + rerank calls
- **Rerank-failure fallback** — returns hybrid-fusion pool unchanged (was cosine re-rank)
- **Model bakeoff harness** — two-stage gate for rapid model evaluation
- **Dreaming v1** — light + deep sweep + CLI command
- **Registration idempotency** — `_registered` guard, verified by test

## Decisions

- 2026-04-12: Entity boost + entity graph gated behind disabled-by-default config flags
- 2026-04-10: Enable Qwen3-Reranker-0.6B-Q8_0 in runtime
- 2026-04-10: Research rigor rule: diagnose failures before scoping quality projects
- 2026-04-09: Domain eval is primary quality metric (not LongMemEval)
- 2026-04-09: Entity boost weight=0 (disabled). BM25 sufficient for keyword entities
- 2026-04-09: GPT-4o default for E2E benchmark

## Next Session Should

1. **Project 2 (MCP Server):** Test Claude Code integration — add `.mcp.json` to project, verify tools work end-to-end with a real embedding endpoint
2. **Project 3 (Dreaming Reflection):** Start diagnosis — cluster sample memories, test Stanford question synthesis manually
3. Reference `02-projects.md` for full ACs and milestone structure
