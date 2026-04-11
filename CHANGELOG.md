# Changelog

Notable user-facing and infrastructure changes. Format based on [Keep a Changelog](https://keepachangelog.com/), though past releases were not tracked formally — this file starts with the 2026-04-10/11 autonomous-loop work.

## [Unreleased]

### Added

- **`tests/bakeoff/`** — reusable harness for evaluating a candidate reranker or embedder against the current stack. Two-stage gate (cheap domain-eval + fast-benchmark → expensive GPT-4o e2e only if stage 1 wasn't a hard fail). Unit-tested decision logic at `tests/bakeoff/criteria.ts` (16 tests) and stdout parsers at `tests/bakeoff/runner-parser.test.ts` (14 tests). CLI at `scripts/bakeoff` with structured `--help`, required-env fail-fast, and reranker + embedder modes.
- **`src/transient-retry.ts`** — shared helper that wraps upstream API calls in 4-attempt exponential backoff (1s/2s/4s) on 502/503/504/AbortError/TimeoutError. Wired into both the embedder client (`embedSingle`, `embedMany`) and the reranker call sites (`unified-retriever.ts`, `retriever.ts`), so transient inference-server crashes never propagate to memex callers as failed recalls. 12 unit tests.
- **`src/recall-cache.ts`** — `InTurnRecallCache` class for deduping `before_prompt_build` auto-recall within a single agent turn. Prevents N redundant retrieve() calls when the same user message triggers N prompt rebuilds (one per tool result). 11 unit tests including the multi-rebuild production scenario.
- **Domain eval** at `tests/domain-eval.ts` — 15 entity-rich queries against the live memex DB, used as the primary regression gate for day-to-day retrieval tuning. Env-var `RERANK=1` toggle for A/B comparisons.
- **`tests/latency-probe.ts`** — reusable latency A/B tool. Reads config from the live openclaw config file (not 1Password) and secrets from 1Password.
- **Chunked embedding in `tests/longmemeval-benchmark.ts`** — Phase 1 now splits each session into overlapping 2000-char chunks via `chunkDocument` and dedupes by sessionId at retrieval time, matching `fast-benchmark.ts` and production behavior. Previously truncated each session to 2000 chars, which was a ~34pp R@1 gap vs production. Extracted as `dedupeChunkResultsBySession` with 10 unit tests.
- **`RERANK=1` support in `tests/longmemeval-benchmark.ts`** — Phase 1 can now run with the reranker enabled (previously hardcoded `rerank: "none"` with a stale comment about bge hurting long sessions).

### Changed

- **Reranker: `bge-reranker-v2-m3-Q8_0` → `Qwen3-Reranker-0.6B-Q8_0`.** Verified on `fast-benchmark.ts` with fresh GPT-4o generation: R@1 78% → **82%**, E2E 90% → **94%** on LongMemEval_s N=50. Mechanistic reason: Qwen3-Reranker has 32K context vs bge's 8K-truncation on long chunked sessions. Domain eval drops 12/15 → 11/15 with Qwen3 (the reranker prefers semantically-prominent rule memories over specific incident memories on 1-2 queries) — net verdict is PASS per the bakeoff criteria because the +4pp LongMemEval win outweighs the −1 domain-eval regression. See `docs/research/embed-rerank-upgrade-brief.md` for the full research trail.
- **`shouldRerank` confidence gate fixed** — the gate compared weighted `pool[0].score` against `confidenceThreshold: 0.88`, but pool scores are multiplied by `conversationWeight: 0.55` or `documentWeight: 0.45` in `mergeAndCalibrate`, making the threshold check unreachable (max possible weighted score is 0.55). Fixed by comparing `pool[0].rawScore` (unweighted [0,1] sigmoid-fused source score). The gate now fires for high-confidence queries, dropping their cache-hit latency from ~1000ms → ~50ms. Regression test in `tests/unified-retriever.test.ts`.
- **`MemoryRetriever` rerank-failure fallback** — when rerank was configured but the API failed, the code previously fell through to a cosine-similarity re-rank pass that displaced hybrid-fusion winners. Now returns the pool unchanged on rerank failure (matching `UnifiedRetriever` behavior). The cosine pass still runs for the "no rerank configured" path. Regression test in `tests/retriever-rerank-fallback.test.ts`.
- **Auto-recall in-turn dedup** — `before_prompt_build` fires once per LLM prompt build, which happens on the initial build AND again after each tool result. Previously N tool calls meant N+1 redundant retrieve() calls for the same user message (observed: 10 rerank calls per agent turn in production). Now the hook caches the computed context by `(agentId, sessionKey, query)` for 60 seconds; cache hits return the prior result without re-running retrieval.
- **`runPipeline` in `tests/fast-benchmark.ts`** — TIER=pipeline now honors `RERANK=1`. Previously the rerank config was hardcoded to `"none"` so the env var was silently ignored (the bug was caught when TIER=pipeline + RERANK=1 produced identical numbers as TIER=pipeline + RERANK=0).
- **`session-indexer.ts` default reranker** — updated from `bge-reranker-v2-m3-Q8_0` to `Qwen3-Reranker-0.6B-Q8_0` to match production.
- **No hardcoded URL/key defaults in benchmark scripts.** `tests/beir-benchmark.ts`, `tests/benchmark.ts`, `tests/build-chunk-cache.ts`, `tests/build-research-cache.ts` previously had `|| "http://localhost:8090/v1"` fallbacks. All removed; scripts now fail fast with a clear error when `EMBED_BASE_URL`, `EMBED_MODEL`, or `EMBED_API_KEY` are missing. Legacy `LLAMA_SWAP_API_KEY` env var still works as a fallback.
- **Benchmark docs** — `docs/BENCHMARKS.md` and `docs/COMPARISON.md` updated with the Qwen3-Reranker numbers, small-sample caveat, and updated reproduction commands.

### Fixed

- **Inference-host embedding lane crash under load.** `Qwen3-Embedding-4B-Q8_0` lane was crashing reproducibly (~28% crash rate during heavy probes) due to upstream llama.cpp bugs ([#15849](https://github.com/ggml-org/llama.cpp/issues/15849), [#6722](https://github.com/ggml-org/llama.cpp/issues/6722), [#5655](https://github.com/ggml-org/llama.cpp/issues/5655)) when `--embeddings` is combined with `--parallel N>1`. Fixed at the infrastructure layer by dropping the lane to `--parallel 1` (homeinfra commit `4730f38`). A residual large-batch crash mode still exists but is now absorbed transparently by the transient-retry helper.

### Methodology

- **`docs/plans/01-methodology.md`** — added "Research Rigor: Diagnose Before Scoping" section. Before scoping any quality project, walk the proposed mechanism through each currently-failing case and classify the failure (recall / scoring / ingestion). If the mechanism can't fix any of the failures, don't start the project. Prepends a `Diagnose` step before `Design` in the milestone sequence.
- **LEARNINGS.md** — added retrospectives on the entity-arc null result, the shouldRerank dead-code bug, the per-rebuild hook firing pattern, the upstream-issue-search-first triage rule, and the reranker-model-matters-more-than-on/off insight.

### Infrastructure (not in this repo)

- **homeinfra `4730f38`** — `fix(<host>): drop embed lane to --parallel 1` — fixes the upstream llama.cpp crash class.
- **homeinfra `97cf32a`** — `feat(<host>): swap Qwen3-Reranker-0.6B for bge on llama-swap lane` — deploys the new reranker.
- **1Password `dev-claude` item** — field names renamed to purpose-specific (`MEMEX_LLAMA_SWAP_API_KEY`, `MEMEX_BENCHMARK_OPENAI_API_KEY`). Non-sensitive config (base URLs) removed from 1Password and moved to shell/config-file sourcing.

### Known limitations carried forward

- **Domain eval `gemma4-stability` + `mbp1-model` regressions under Qwen3-Reranker** are real (confirmed with the cosine-fallback bug fixed). The reranker prefers semantically-prominent rule memories over specific incident memories on abstract queries. Likely fixable with llama.cpp PR #20009 (instruction-aware rerank template, still unmerged).
- **Residual embed-lane crashes** under very-large-batch load still happen occasionally; absorbed by the transient-retry helper in callers, so no user-visible failures.
- **Full Phase 1 longmemeval rebuild** with chunked embedding takes ~2–6 hours of compute due to the crash/retry cycles. Left running disowned for multi-hour jobs.
