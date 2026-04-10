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
