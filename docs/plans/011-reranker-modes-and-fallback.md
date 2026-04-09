# Reranker Modes and Graceful Fallback

**Date:** 2026-03-30  
**Status:** Draft

## Goal

Make reranking an explicit, reliable, and well-documented mode across memex runtime behavior, benchmarks, and docs.

Specifically:
- preserve the existing `reranker.enabled: false` off switch
- ensure reranker endpoint failures degrade cleanly to no-rerank behavior
- avoid noisy repeated rerank errors on every query
- make benchmarks distinguish between `hybrid` with and without reranking
- update docs so LongMemEval, BEIR, and runtime behavior tell the same story

## Context

memex currently uses reranking in multiple places, but with different assumptions:

1. **LongMemEval memory benchmark**
   - reranker intentionally disabled
   - reason: reranking long conversation sessions hurt E2E quality
   - evidence:
     - `docs/research/005-longmemeval-baseline.md`
     - `tests/longmemeval-benchmark.ts`

2. **Document search (`src/search.ts`)**
   - reranking is part of the intended hybrid document pipeline
   - documents are reranked by best chunk, not full body
   - this is a better fit for cross-encoder reranking than long-session memory retrieval

3. **Unified retrieval / recall**
   - design intent is optional or gated reranking
   - tests already cover:
     - `reranker: null`
     - rerank skip on high confidence
     - graceful rerank failure fallback
   - evidence:
     - `tests/unified-retriever.test.ts`
     - `tests/unified-retriever-benchmark.test.ts`

At the config layer, memex already exposes:
- `reranker.enabled`
- `reranker.endpoint`
- `reranker.apiKey`
- `reranker.model`
- `reranker.provider`

via `openclaw.plugin.json` and `index.ts`.

## Problem

The current behavior is functionally survivable but operationally messy:

1. **No-rerank is supported but underexplained**
   - users can disable reranking today
   - docs do not clearly explain when that is recommended

2. **Rerank endpoint failures are too noisy**
   - retrieval still falls back, but logs can emit repeated rerank failures
   - this makes a degraded-but-working system look more broken than it is

3. **Benchmark modes are underspecified**
   - LongMemEval already runs no-rerank
   - the new BEIR runner currently has `fts` and `hybrid`, but `hybrid` can silently degrade to no-rerank if the endpoint is missing or broken
   - this makes results harder to interpret

4. **Docs mix policy and mechanism**
   - “reranker optional” is true
   - “reranker recommended” is only true for some workloads
   - those distinctions need to be explicit

## Decisions

### 1. Keep explicit reranker disable as the primary off switch

`reranker.enabled: false` remains the canonical way to disable reranking.

This should apply consistently to:
- runtime recall
- document search
- benchmark modes that are meant to reflect runtime

This is the clean user-facing answer for:
- single-model deployment
- lower-cost setups
- memory-centric workloads where reranking is not proven helpful

### 2. Treat rerank endpoint failure as degraded mode, not retrieval failure

If reranking fails because of:
- network error
- timeout
- 4xx/5xx endpoint response
- malformed rerank response

memex should:
- continue retrieval without reranking
- preserve candidate order from the first-stage retrieval
- record that reranking was unavailable
- log a concise warning

memex should **not**:
- fail the whole retrieval
- mark memory/doc retrieval unavailable solely because reranking failed

### 3. Add rerank failure suppression / cooldown

To avoid per-query error spam, runtime should temporarily suppress repeated rerank attempts after a failure.

Recommended behavior:
- first rerank failure logs a warning and opens a cooldown window
- during cooldown, reranking is skipped immediately
- after cooldown expires, memex may try reranking again

Recommended defaults:
- cooldown: 5 minutes
- state kept in memory only
- no persistence across restart

This is effectively a small circuit breaker for reranking.

### 4. Make benchmark modes explicit

Benchmarks should stop collapsing “hybrid” and “hybrid-but-rerank-failed” into the same label.

Required benchmark modes:
- `fts`
- `hybrid_no_rerank`
- `hybrid_rerank`

Interpretation:
- `fts`: document lexical baseline
- `hybrid_no_rerank`: embedding + BM25 fusion only
- `hybrid_rerank`: full intended document pipeline

If the benchmark is invoked in `hybrid_rerank` mode and reranking is unavailable, it should fail clearly rather than silently downgrading the label.

### 5. Keep LongMemEval no-rerank by default

The existing LongMemEval default remains correct until new evidence proves otherwise.

Reason:
- it evaluates conversational memory retrieval
- prior runs showed reranking long session texts did not help and could hurt E2E

If reranking is reintroduced there later, it should be as an explicit comparison mode, not as the new default.

## Runtime Design

### Configuration semantics

#### Runtime

If `reranker.enabled` is:
- `false` → never attempt reranking
- `true` with valid endpoint/model → rerank when pipeline chooses to
- `true` but endpoint failing → degrade to no-rerank under cooldown

#### Health

Health output should distinguish:
- `reranker_configured`
- `reranker_available`
- `reranker_cooldown_active`

Severity guidance:
- `warn` if reranker is configured but unavailable
- `ok` if reranker is disabled intentionally
- `ok` if retrieval still works without rerank

Reranker failure alone should not make overall retrieval `fail`.

### Failure handling

Proposed internal state:

```ts
type RerankAvailabilityState = {
  unavailableUntil: number;
  lastError?: string;
  lastFailureAt?: string;
};
```

Behavior:
- before rerank call: check cooldown
- if cooldown active: skip rerank immediately
- on failure: set `unavailableUntil = now + cooldownMs`
- on success: clear cooldown state

### Logging

Log once per cooldown window:

```text
memex: reranker unavailable, falling back to no-rerank for 5m: <reason>
```

Avoid:
- per-document rerank warnings
- per-query stack traces in the common degraded path

Detailed stack traces can still be preserved for debug/test contexts if needed.

## Benchmark Design

### BEIR

`tests/beir-benchmark.ts` should support:
- `BEIR_MODE=fts`
- `BEIR_MODE=hybrid_no_rerank`
- `BEIR_MODE=hybrid_rerank`
- optional `BEIR_MODE=both` only if it expands into explicit labeled subruns

Rules:
- `hybrid_no_rerank` must initialize embeddings only
- `hybrid_rerank` must require both embeddings and reranker
- if reranker endpoint returns 404/401/timeout in `hybrid_rerank`, fail fast with a clear message

### LongMemEval

Leave current default:
- no reranker

Optional future enhancement:
- `RERANK=1` comparison mode

But that is out of scope for this change.

## Documentation Changes

### README

Clarify:
- reranking is optional
- memex can run in single-model mode
- reranking is mainly a precision layer for harder or document-heavy queries

### `docs/BENCHMARKS.md`

Clarify:
- LongMemEval results are no-rerank memory results unless otherwise stated
- BEIR should report rerank mode explicitly
- headline document numbers must specify whether reranking is enabled

### `docs/COMPARISON.md`

Clarify:
- if memex document benchmark numbers include reranking, say so
- if they do not, say “hybrid without rerank”

### Config docs / schema descriptions

Update wording around `reranker`:
- recommended when optimizing document precision or top-1 quality
- not required for baseline memex operation
- safe to disable for simpler local deployments

## Implementation Plan

1. **Runtime fallback**
   - add rerank cooldown state
   - centralize rerank-unavailable handling
   - suppress repeated noisy errors

2. **Health reporting**
   - expose reranker configured/available/cooldown state in `memex.health`

3. **Benchmark modes**
   - rename current BEIR `hybrid` behavior into explicit rerank/no-rerank modes
   - require real rerank availability for `hybrid_rerank`

4. **Docs**
   - update README, benchmark docs, and config descriptions

5. **Verification**
   - reranker disabled: retrieval still works
   - reranker endpoint 404: retrieval falls back cleanly, no spam
   - cooldown expires: rerank is retried
   - BEIR mode labels match actual runtime behavior

## Acceptance Criteria

- `reranker.enabled: false` cleanly disables reranking across runtime and benchmark paths
- rerank endpoint failures do not fail retrieval
- rerank endpoint failures do not spam logs on every query
- health reports degraded reranker state as `warn`, not `fail`
- BEIR benchmark labels distinguish rerank vs no-rerank
- docs explicitly explain when reranking is useful and when it is optional
