# Learnings — April 2026 Session

## Technical Learnings

### Entity boost doesn't work as a score multiplier
- **Expected:** Entity overlap as 3rd retrieval signal would close the 1.4% gap with Hindsight
- **Actual:** Weight sweep showed 0.0 (disabled) is best (80%). Any positive weight hurts (73-75%)
- **Why:** BM25 already captures keyword entity matching. Adding entity overlap double-counts the same signal. Hindsight's advantage is graph traversal (following relationships), not keyword counting
- **Lesson:** Don't implement what a paper describes — implement what makes their results different. Read the mechanism, not just the architecture diagram

### LongMemEval doesn't measure what matters for memex
- **Expected:** R@1/R@3 on LongMemEval would reflect production quality
- **Actual:** LongMemEval uses casual conversation ("I went shopping"). Memex's real data is technical ("Ryan deployed Gemma 4 on mbp-1")
- **Lesson:** Build a domain-specific eval early. We wasted time chasing LongMemEval metrics that don't predict real-world quality

### Entity metadata is still valuable even though the boost failed
- Stored entities enable: contradiction detection, agent provenance, future graph links
- The work wasn't wasted — it's infrastructure for the next feature

### `--embeddings --parallel N>1` is broken upstream (llama.cpp)

The Qwen3-Embedding-4B-Q8_0 lane on the inference host crashed reproducibly under memex's auto-recall workload. Symptom in `llama-swap.log`:

```
[WARN] <Qwen3-Embedding-4B-Q8_0> ExitError >> signal: abort trap, exit code: -1
```

Each crash forced a llama-swap automatic restart taking 5-15s, and the next embed call after restart paid that latency. ~28% crash rate during a 25-retrieve latency probe (7 crashes, 1 outright failure even after retries).

**Root cause is upstream, not in memex.** Three open llama.cpp issues all describe the same pattern: `--embeddings` combined with `--parallel N>1` triggers `GGML_ASSERT` failures (which call `abort()`, surfacing as SIGABRT / "abort trap" on macOS):

- llama.cpp #15849 — "Can't Parallel with --embedding"
- llama.cpp #6722 — "multiple simultaneous API calls on embeddings endpoint"
- llama.cpp #5655 — "Segmentation fault" with parallel embeddings

The current host build (`ecd99d6`, 2026-03-03) does not have a fix.

**Fix:** drop the embedding lane to `--parallel 1`. Sequential single-slot processing eliminates the crash. The throughput hit is negligible for memex (auto-recall makes 1-3 embed calls per agent turn, never burst-parallel). Verified: 7 crashes/probe → 0 crashes/probe; mean latency 2588ms → 1030ms; max latency 22421ms → 3834ms. Committed in homeinfra `4730f38`.

**Lesson:** when triaging "intermittent server crash" symptoms, check upstream issue trackers BEFORE deep-diving into reproduction. The crash signature ("abort trap" + `--embeddings` + `--parallel`) was a textbook match for #15849 / #6722 / #5655 — 5 minutes of search would have identified the cause without any reproduction work. I burned ~30 min trying to reproduce locally before searching. Add "search upstream issues" as the FIRST step of operational crash triage, not the last.

### shouldRerank confidence gate was dead code

The `UnifiedRetriever.shouldRerank` gate compared `pool[0].score` against a `confidenceThreshold` of 0.88. But pool scores are multiplied by `conversationWeight` (0.55) or `documentWeight` (0.45) in `mergeAndCalibrate`, so the maximum possible pool score is 0.55 — making the threshold unreachable.

**Symptom:** every retrieve() call paid the full ~1s rerank cost, even when the top candidate was already obviously the right answer. Caused ~1s of extra latency per call × however many retrieves per agent turn.

**Fix:** compare `pool[0].rawScore` (the unweighted [0,1] sigmoid-fused source score) instead of `score`. With the fix, the gate fires for high-confidence queries and skips rerank entirely. Measured effect in the latency probe: several queries dropped from ~1s minimum per iteration to ~50ms minimum (pure cache path, no rerank call).

**Lesson:** thresholds baked into config defaults should be validated against the actual value range they compare against. A threshold of 0.88 over a [0, 0.55] value space is a silent bug — no errors, no test failures, just "this skip optimization never fires and no one notices for months." Added a regression test that verifies the gate fires when rawScore exceeds a reachable threshold.

### Auto-recall fires once per prompt rebuild, not once per user turn

The `before_prompt_build` hook runs every time OpenClaw rebuilds the LLM prompt — that's the initial build AND every rebuild after a tool result comes back. If an agent uses N tool calls, auto-recall runs N+1 times for the same user message.

**Symptom:** a single `openclaw agent main` turn produced ~10 /v1/rerank calls on the inference host. With ~1s per rerank call, that's ~10s of rerank work per turn.

**Fix:** per-session in-turn cache keyed by (agentId, sessionKey). On cache hit, return the previously-computed recall context without re-running retrieve(). Invalidates automatically when recallQuery changes (new user message) or after 60s TTL. The cache is a plain Map with opportunistic GC when it grows beyond 32 entries.

**Lesson:** hook semantics matter. A hook called "before_prompt_build" sounds idempotent-per-user-message, but it's actually per-LLM-invocation. Anything expensive inside such a hook needs per-turn memoization. Flagged this in the memory auto-memory as "Hooks" — future sessions should treat hook multiplication as a default concern.

### Reranker model matters more than reranker-on/off

Measured in 2026-04-10 against memex production DB (2105 memories) and cached LongMemEval fixture (N=50):

| | Domain eval | LongMemEval R@1 | LongMemEval R@3 | LongMemEval E2E (GPT-4o) |
|---|---|---|---|---|
| **No rerank (baseline)** | 12/15 (80%) | 78% | 90% | 90% |
| **bge-reranker-v2-m3** | 12/15 (neutral swap) | 76% (−2pp) | 90% | ~90% |
| **Qwen3-Reranker-0.6B** | 11/15 (−1) | **82% (+4pp)** | 90% | **94% (+4pp)** |

- **bge was a loss in every dimension** on memex's workloads. The historical design finding from `011-reranker-modes-and-fallback.md` ("reranking long session texts did not help and could hurt E2E") was workload-correct but model-specific.
- **Qwen3-Reranker was a decisive win on LongMemEval** (+2 queries R@1, +2 queries E2E) and a small loss on domain eval (−1). The larger benchmark win (N=50 vs N=15) and clearer mechanism drove ship.
- **Mechanism:** Qwen3-Reranker has 32K context (vs bge's 8K) — bge was truncating memex's chunked conversation sessions before scoring them. Qwen3-Reranker also emits sigmoid-calibrated [0,1] scores instead of bge's unbounded logits, which makes memex's "rerank skip on high confidence" code path actually meaningful.
- **Lesson:** "Enable reranking" and "disable reranking" are not the real decision. The real decision is "which reranker." Don't extrapolate a finding across reranker families.
- **Process lesson:** The fix came from a separate Claude doing a full mechanistic research trail (`docs/research/embed-rerank-upgrade-brief.md` Conclusion section) — walking each rejected candidate through our actual failure modes, not just citing MTEB scores. This is the `Research Rigor: Diagnose Before Scoping` rule in action — and it worked this time.
- **Latency follow-up:** memex made **10 /v1/rerank calls** during a single `openclaw agent main` turn in live verification. That's suspicious — the batch API takes N documents per call, so it should be 1-ish per retrieval. Possibly per-source duplication or the agent making multiple tool calls. Flagged for next-session investigation.

### Entity graph also did nothing on domain eval
- **Expected:** Graph expansion would pull missing correct memories into the candidate set (fix recall), and the 0.7× discount would still let them win where appropriate
- **Actual:** 3,406 links created across 2,105 memories, domain eval stayed 12/15. Same 3 misses
- **Why (hypothesis, unverified):** Either the correct memories weren't reachable via graph from the top hits, or they were reachable but still ranked below a wrong winner. We don't know which, because we never diagnosed the misses before scoping the project
- **Lesson:** Same root cause as entity boost — research cited that "Hindsight does graph traversal," but no one traced the mechanism through our actual failing queries. User called it out: *"this is a sign of lacking research."* The SOTA citation was true; it just didn't apply to our failure modes
- **Process change:** Added a **Diagnose** step before **Design** in `01-methodology.md`. No quality project gets scoped until the current failures are classified (recall vs scoring vs ingestion)

### Dreaming works but the timer didn't
- The `/dream` command works perfectly via CLI
- The `setTimeout` timer in `register()` never fired because `service.start()` wasn't called by OpenClaw
- Moving the timer into the `_registered` guard block fixed it
- **Lesson:** Don't assume platform lifecycle callbacks fire. Verify with production logs, not just tests

### Session import is the main source of garbage
- 76% of memories were low-quality session imports at importance 0.3
- 7% were raw conversation fragments
- Intake guards (text hash dedup, fragment rejection) are the highest-ROI quality improvement
- **Lesson:** Prevention at intake > cleanup after the fact

### OpenClaw's plugin API has undocumented behavior
- `api.on()` is additive (no dedup) — hooks register 5x
- `registerService.start()` doesn't reliably fire
- Import interop (CJS/ESM) differs between standalone node and OpenClaw bundler
- **Lesson:** Always verify plugin behavior in production, not just in test mocks

## Dev Loop Learnings

### What worked well
1. **TDD with acceptance criteria** — writing ACs first forced clear thinking about what "done" means
2. **Worktrees for isolation** — parallel projects don't conflict
3. **Domain eval over benchmark** — 15 queries against real data gave faster, more actionable feedback than LongMemEval
4. **Monitor cron** — `monitor-report.log` caught issues without burning tokens
5. **Budget tracking** — `usage-poll.sh` prevented runaway spending
6. **Research loop** — 15 iterations of focused SOTA research before implementation prevented building the wrong thing (mostly)

### What didn't work well
1. **Research said entity boost would work, tuning said it didn't** — should have done a quick spike/experiment BEFORE the full TDD cycle. The research loop was too disconnected from validation
2. **Worktrees confused the user** — putting them in `../memex-entity-extraction` was unexpected. `.worktrees/` inside the project is better, but Zed's file tree still makes it awkward
3. **Benchmark fixtures were stale** — the pipeline benchmark used cached vectors without entities, making it impossible to measure entity impact. Should have checked the benchmark's data path before running it
4. **Too many plan files** — 5 plan files (00-04) is too many to track. Should be 2: PROGRESS.md (state) and one consolidated plan
5. **Timer debugging burned 30+ minutes** — multiple deploy-restart-wait cycles to find that `service.start()` wasn't called. Should have added logging first, not code changes
6. **Agent subagents didn't know about `secrets` script** — had to discover it manually. Should be documented in CLAUDE.md or memory

### Improvements to the dev loop

1. **Spike before TDD** — for new features backed by research claims, do a 30-minute spike to validate the hypothesis before writing full ACs. If the spike fails, pivot early
2. **Domain eval as primary metric** — build a domain eval at the START of a project, not after implementation. It's faster and more relevant than academic benchmarks
3. **Verify the benchmark path** — before running a benchmark, trace the data flow to confirm it exercises the new code
4. **Consolidate plan files** — PROGRESS.md + one design doc per project. No multi-file plan hierarchy
5. **Log first, code second** — when debugging production issues, add logging before making code changes. Most issues are visibility problems, not code problems
6. **Document infrastructure** — secrets script, monitor script, 1Password items, embedding server endpoints. Put in CLAUDE.md so every agent knows
