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
