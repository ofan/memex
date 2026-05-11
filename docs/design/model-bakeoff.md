# model-bakeoff — quick go/no-go for a candidate reranker or embedder

**Status:** Design draft. Built after the manual Qwen3-Reranker bakeoff on 2026-04-10 codified the workflow.

## Problem

Memex's retrieval quality depends on two model choices: the embedder and the reranker. When a new candidate model becomes available — a better Qwen release, a new BGE checkpoint, a community fine-tune — there's no fast way to answer the only question that matters:

> *Is this model worth switching to?*

Today the answer requires a manual cycle:

1. Edit `tests/domain-eval.ts` to wire the candidate
2. Run domain-eval baseline + candidate
3. Run `tests/fast-benchmark.ts` baseline + candidate at TIER=fast
4. Re-run with TIER=e2e (and pre-emptively delete the response cache to force fresh GPT-4o generation)
5. Restore the cache
6. Eyeball six numbers and decide

The manual workflow has three problems:

- **Slow** — about 30–60 minutes for a clean comparison
- **Error-prone** — forgot-to-delete-the-cache and forgot-to-restore-the-cache both happened during the bge → Qwen3-Reranker session and produced misleading numbers
- **Hard to delegate** — the "do you remember to also test long-context queries?" sequence is tribal knowledge

## Goal

A single command answers the worth-switching question in **under 5 minutes** for a reranker swap, with a clean go/no-go exit code and a delta table on stdout. The same harness handles embedder swaps too, but those are inherently slower because the test corpus has to be re-embedded.

## API

```sh
# Reranker swap (cached vectors stay valid):
bakeoff reranker <endpoint-url> <model-name> [--provider jina|voyage|siliconflow|pinecone]

# Embedder swap (rebuilds research cache, slower):
bakeoff embedder <endpoint-url> <model-name> <vector-dim>
```

Required env vars (no hardcoded defaults; missing → fail with a clear message):

| var | purpose |
|---|---|
| `MEMEX_DB` | path to the production memex sqlite (read-only) |
| `MEMEX_LLAMA_SWAP_API_KEY` | from 1Password — auth header for the embed/rerank endpoints |
| `MEMEX_BENCHMARK_OPENAI_API_KEY` | from 1Password — for GPT-4o e2e judging |
| `EMBED_MODEL` | the *current* embedding model (used as the reference in reranker swaps) |

The candidate's endpoint URL and model name are positional args, not env vars, because they're the thing that varies per candidate and should be visible in shell history.

## What it runs

Two stages, gated. The cheap stage runs first; if it fails decisively, the expensive stage is skipped.

### Stage 1 — fast benchmarks (target: < 60s wall clock, no LLM cost)

1. **Domain eval** (N=15 queries, live memex DB) — both with and without the candidate, retrieval-only, no LLM reader
2. **fast-benchmark TIER=fast** (N=50 LongMemEval cached fixture) — both with and without the candidate, in-process fusion math + optional rerank, no LLM cost

Output:
```
=== Stage 1 ===
              | baseline | candidate | Δ
domain-eval   |   12/15  |   14/15   | +2  ✓
LME R@1       |   78%    |   82%     | +4  ✓
LME R@3       |   90%    |   90%     |  0  ◯
```

**Decision after stage 1:**

- **Hard fail** (any metric drops by 2+ queries): exit non-zero, skip stage 2
- **Decisive win** (no metric regresses, at least one improves by 2+ queries): proceed to stage 2 to validate E2E
- **Marginal / mixed** (improves on one, regresses on one): proceed to stage 2 — E2E result will tie-break

### Stage 2 — e2e benchmark (target: < 4 min wall clock, ~$0.30 in OpenAI cost)

1. **fast-benchmark TIER=e2e** (N=50, GPT-4o reader, gpt-4o-mini judge) — both with and without the candidate, with **fresh response generation** (cache invalidated and restored, regardless of failure mode)

Output appended to the stage 1 table:
```
=== Stage 2 ===
LME E2E       |   90%    |   94%     | +4  ✓
              |          |           |
verdict: SHIP — domain stable, LME R@1 +4pp, E2E +4pp
exit code: 0
```

**Decision after stage 2:**

- **Pass** (E2E ≥ baseline AND no other metric regresses 2+ queries): exit 0 — ship it
- **Fail** (E2E regresses by 1+ queries OR other metric regresses 2+): exit 1 — hold

## Embedder swap is harder

The reranker swap is easy because cached vectors don't change — the candidate reranker just operates on the same retrieval pool. The embedder swap is harder because:

1. The research cache (`tests/fixtures/longmemeval-cache/research-cache-50.json`) holds pre-computed vectors from a *specific* embedder. Swapping the embedder means rebuilding that cache.
2. The chunk-scores cache (`chunk-scores-50.json`) holds the per-chunk vector scores — also embedder-specific.
3. Rebuilding both takes ~10 minutes per embedder against the `tests/build-research-cache.ts` script.

The embedder mode of `bakeoff` therefore:

1. Rebuilds the two caches with the candidate embedder (named with the candidate's hash to avoid clobbering the baseline cache)
2. Runs stages 1 and 2 with the candidate cache
3. Compares against the baseline cache results

Total runtime: ~15 minutes for stage 1 (includes cache rebuild) + ~4 minutes for stage 2 = **~20 minutes**.

## Decision criteria (configurable)

Hardcoded for v1, configurable later:

```typescript
const PASS_CRITERIA = {
  // No metric may drop by more than this many queries.
  maxRegressionQueries: 1,
  // To be a "decisive win" requiring no E2E confirmation,
  // a metric must improve by at least this many queries.
  decisiveWinQueries: 2,
  // E2E result trumps everything else when present.
  e2eRequired: true,
};
```

## Safe-by-default behaviors

- **Cache invalidation is paired** — every cache delete has a try/finally that restores the original. Cache restoration hash-checks against the backup so a corrupted run never leaves the fixture in a bad state.
- **No live config changes** — bakeoff never writes to `~/.openclaw/openclaw.json` or `~/<infra-repo>/...`. The candidate is tested via env vars only. Promotion to production is a separate, deliberate human action.
- **No infrastructure side effects** — bakeoff never restarts llama-swap, never reloads the openclaw gateway, never touches the inference host. It only makes HTTP calls to the candidate's endpoint.
- **Read-only DB access** — opens the live memex sqlite in readonly mode so a buggy run can't corrupt production memories.

## What lives where

| File | Role |
|---|---|
| `scripts/bakeoff` (entry point) | CLI shim that loads env, parses args, dispatches to the harness |
| `tests/bakeoff/runner.ts` | Stage 1 + stage 2 orchestration, decision logic, output formatting |
| `tests/bakeoff/cache-guard.ts` | Cache backup/restore with hash check |
| `tests/bakeoff/criteria.ts` | Pass/fail decision logic, easy to unit-test |
| `tests/bakeoff/criteria.test.ts` | Unit tests for the decision matrix |

## Out of scope for v1

- **Latency measurement** — bakeoff focuses on quality. The latency-probe at `tests/latency-probe.ts` already exists for that. Could be folded in as a stage 0 in v2.
- **Memory/disk footprint check** — important for embedder swaps (16GB box has limits) but easier to do manually before running bakeoff. Document in the runbook.
- **Multi-candidate sweep** — `bakeoff sweep <candidates.txt>` is a v2 feature. v1 does one candidate at a time.
- **Statistical significance** — N=50 + N=15 is small enough that single-query swings dominate. Don't over-engineer the decision math; the criteria above are intentionally conservative.

## When to build it

After this loop's commits land. The manual bakeoff codified today is the v1 spec — `bakeoff reranker` should produce the exact same comparison table I produced manually today, just in 5 minutes instead of 60.

## Connection to the methodology rule

This harness is the *operational* arm of the "Research Rigor: Diagnose Before Scoping" rule in `docs/plans/01-methodology.md`. The methodology says: walk the proposed mechanism through current failing cases before scoping a project. The harness makes that cheap enough to do every time, instead of just on the first candidate. **Cheap diagnosis enables more candidates → better odds of finding a real win.**
