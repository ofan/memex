# Autonomous Loop Report — 2026-04-10

Single canonical record for the long autonomous loop on 2026-04-10. Updated continuously as work proceeds.

## Goal

Continue from "what's next, is crash fixed" — work through the remaining items in PROGRESS.md and ship them. Run autonomously, write findings to this doc instead of inline messages.

## Status: in progress

## Items

### ✅ 1. Embed lane crash fix — DONE earlier this session

`Qwen3-Embedding-4B-Q8_0` was crashing reproducibly (~28% rate) under memex's auto-recall workload. Root cause: upstream llama.cpp bugs (#15849, #6722, #5655) — `--embeddings --parallel N>1` triggers `GGML_ASSERT` failures (`abort()` → SIGABRT → "abort trap" on macOS). Current host build (`ecd99d6`, 2026-03-03) doesn't have a fix.

**Fix:** drop the embed lane to `--parallel 1`. Sequential single-slot processing eliminates the crash. Throughput hit is negligible for memex's actual workload (~1-3 embed calls per agent turn).

**Verified on host (latency probe, same workload):**

| metric | before `--parallel 1` | after |
|---|---|---|
| crashes added by probe | 7 | **0** |
| failures | 1 | **0** |
| max latency (ms) | 22421 | **3834** |
| mean latency (ms) | 2588 | **1030** |
| p90 (ms) | 5602 | **2896** |

Reranker lane unchanged (different code path, no reported crashes there).

**Commits:**
- homeinfra `4730f38` — `fix(<host>): drop embedding lane to --parallel 1`
- memex `aee0922` — `docs: record embed lane crash root cause + fix`

**Process lesson** (in `LEARNINGS.md`): I burned ~30 min trying to reproduce locally with isolated curl tests before searching the upstream issue tracker. The crash signature was a textbook match — 5 min of search would have identified it without any reproduction work. New rule: **upstream issue search is step 1 of operational crash triage, not the last resort.**

### 2. Fix `runPipeline` rerank gap in `fast-benchmark.ts`

Status: TODO

**The bug:** `tests/fast-benchmark.ts` has three tiers — `fast`, `pipeline`, `e2e`. The `runFast` code path implements rerank correctly. But `runPipeline` (which exercises the actual `UnifiedRetriever` class with sqlite-vec + FTS5, not the cached fusion math) **silently ignores `RERANK=1`** — it instantiates the retriever without any rerank config. Earlier this session I tried `TIER=pipeline RERANK=1` and got identical numbers as `TIER=pipeline RERANK=0`, which is how I noticed the gap.

**Fix:** wire rerank into `runPipeline` so the env var actually does what the help text says it does. Match the same pattern as `domain-eval.ts` — read `RERANK_*` env vars and pass through to `createRetriever` config.

### 3. Verify in-turn recall cache via direct test

Status: TODO

**The problem:** Earlier in the session I added a per-session in-turn cache to `index.ts` to dedupe `before_prompt_build` calls within an agent turn. The unit test for the new code is the `shouldRerank` regression test, but the recall *cache* itself doesn't have direct test coverage. Live verification via the openclaw CLI was inconclusive (the CLI path didn't trigger auto-recall in my test, possibly because of how `--channel qa-channel --agent main` routes the prompt build).

**Fix:** add a focused unit test that calls memex's auto-recall hook handler directly with the same query twice in a row and asserts only one `retrieve()` happens.

### 4. Phase 1 longmemeval rebuild with Qwen3-Reranker

Status: TODO

The cached `tests/fixtures/longmemeval-cache/retrieval-50.json` is from 2026-03-18 and predates all the reranker work. Phase 2 of `longmemeval-benchmark.ts` reads from this cache, so any read-phase comparison reflects the Mar-18 retriever, not the current one.

With the embed lane crash fixed (item 1), Phase 1 should actually finish without 502 storms now. ~50 min compute, mostly idle. Run in background while doing item 5.

### 5. Draft `docs/design/model-bakeoff.md`

Status: TODO

Reusable harness for "is candidate model X worth switching to?" — one-command go/no-go for any reranker or embedder. The manual bakeoff today is the reference implementation; codify it now while the workflow is fresh in memory.

### 6. Final summary + report

Status: TODO

Update this doc with the final numbers, commit everything in one logical commit at the end.

---

## Updates as work progresses

### Item 2 — `runPipeline` rerank gap — DONE

`tests/fast-benchmark.ts runPipeline` no longer silently ignores `RERANK=1`. Wired the same env-var pattern as `domain-eval.ts` (RERANK toggle + RERANK_ENDPOINT/MODEL/API_KEY/PROVIDER) into the `createRetriever` config inside `runPipeline`. TIER=pipeline now actually tests the reranker.

### Item 3 — In-turn recall cache verification — DONE

The hook code in `index.ts` was hard to test in isolation (registered inline inside `register()`, depends on store/embedder/scopeManager/etc). Refactored to extract the cache logic into a small helper class `InTurnRecallCache` at `src/recall-cache.ts` — same behavior, easy to unit-test in isolation. The hook delegates to it.

Added `tests/recall-cache.test.ts` with 10 cases covering:

- Miss returns null
- Hit returns matching entry
- New query in same session → miss (correct invalidation)
- Different sessionKey → separate buckets
- Different agentId → separate buckets
- Undefined sessionKey → shared "default" bucket
- TTL expiry (with mock clock)
- Expired entry deletion shrinks size
- Opportunistic GC when map > maxSize
- **Multi-rebuild agent turn simulation: 5 hook fires for the same query → exactly 1 retrieve call** (the production scenario the cache exists to fix)
- Cache invalidates when user sends a new message

All 10 pass. The crucial one is the multi-rebuild simulation — that's the literal production scenario the fix is for, now with permanent test coverage.

### Item 5 — model-bakeoff design doc — DONE

Wrote `docs/design/model-bakeoff.md`. Covers:

- Two-stage gate (cheap stage 1: domain + fast tier; expensive stage 2: e2e with GPT-4o, only run if stage 1 wasn't a hard fail)
- Decision criteria (max regression queries, decisive win threshold, e2e tie-break)
- API: `bakeoff reranker <url> <model>` and `bakeoff embedder <url> <model> <dim>`
- Why embedder swaps are inherently slower (cache rebuild required)
- Safe-by-default behaviors (paired cache invalidation, no live config writes, no infra side effects, read-only DB)
- File layout for the v1 implementation
- Out-of-scope items for v2 (latency probe folding, multi-candidate sweep)
- Connection to the Research Rigor methodology rule: cheap diagnosis enables more candidates → better odds of finding a real win

### Item 4 — Phase 1 longmemeval rebuild — IN PROGRESS

The `--parallel 1` fix on the embedding lane eliminated *concurrency-induced* crashes (verified with the latency probe earlier — 7 crashes → 0). But running Phase 1 surfaced a *second* crash mode: even with `--parallel 1`, the lane crashes after a sequence of large-batch embed requests (hundreds of KB / multi-MB JSON responses). Memex's production workload doesn't trip this — auto-recall makes 1-3 small embed calls per turn — but Phase 1's full-corpus indexing (53 sessions per example × 50 examples) does.

**Mitigations applied so far:**

1. **Chunking the longmemeval batch embed calls into mini-batches of 8 texts** (`tests/longmemeval-benchmark.ts`). Reduced individual response sizes from ~2-3MB to ~440KB. Helps but doesn't fully eliminate crashes — the crash still occurs after ~10 batches succeed, suggesting an accumulating state issue (memory leak, fragmentation, or similar) inside `llama-server` rather than a per-batch input bug.

2. **Transient retry in the embedder client** (`src/embedder.ts` `withTransientRetry`). Wraps `embedSingle` and `embedMany` in a 4-attempt exponential-backoff retry on 502/503/504 status codes. The crash itself is fast — llama-swap restarts the lane in 2-5s — so a simple retry transparently recovers. Crucially, this also helps **production memex auto-recall**: any transient 502 from the embed server now retries automatically instead of failing the recall.

These two together should let Phase 1 complete. Restarted Phase 1 at 21:59. ETA ~50 min.

### Open follow-up: residual embed crash root cause

Even with `--parallel 1`, large-batch embedding still crashes the lane after ~10 successful batches. Hypotheses:

1. **Memory leak in llama-server's batch path** — accumulated state across batches eventually corrupts something
2. **Metal buffer fragmentation** — repeated large allocations on Apple Silicon GPU memory
3. **Tokenizer / cache state corruption** — something in the cache layer (`--cache-type-k q8_0 --cache-type-v q8_0`) misbehaves on long-running sessions

Workarounds in place make this non-blocking, but it's worth filing upstream when there's time. The retry logic ensures memex doesn't hit it in production (1-3 calls/turn never exhaust the limit).

## Running log

- **2026-04-10 21:35** — created this report doc, started Phase 1 (first attempt, default batching → died on example 2 with abort trap)
- **2026-04-10 21:53** — added 8-text chunking to Phase 1, restarted (still died on example 2, accumulated state crash)
- **2026-04-10 21:59** — added `withTransientRetry` to embedder, restarted Phase 1 with retry-on-502 protection
