# Resolve-everything loop (post-v0.7.1 housekeeping)

**Created:** 2026-05-11
**Branch:** `memex-v0.7` (continue)
**Purpose:** Drive every open issue and open PR to resolution — either land it, defer it explicitly, or surface a blocker. Run until no actionable `[ ]` items remain. Surface only when user judgment is genuinely required.

## Scope at start

**Open issues (5):** #19, #21, #23, #27, #30
**Open PRs (2):** #42 (better-sqlite3), #43 (typescript)

## Pre-decided judgment calls

- **Branch / version**: stay on `memex-v0.7`. Version bumps deferred to a separate user-driven REL pass (don't auto-tag v0.7.2 from this loop).
- **Big features (#19 production benchmark, #27 memory browser UI)**: this loop **does NOT implement** them. Both are multi-hour research/feature lanes. The loop's job: write a scoped design note + concrete next-steps doc + open a draft PR with skeleton if useful. Then mark `[?]` with rationale ("needs dedicated session, not loop work").
- **Small features (#23 debug mode, #30 config merge)**: implement, test, commit. These are loop-shaped.
- **Operational issue (#21)**: out-of-scope (different repo / infrastructure). Mark `[?]` with rationale. Don't close the issue from this loop.
- **PR #42 (better-sqlite3 12.x)**: cannot merge — Node 26 incompat blocks it. Leave open as tracker with the existing rationale comment.
- **PR #43 (typescript 6.x)**: try the bump locally; if `npm test` + `npm run build` pass under v6, merge. If they fail with mechanical edits required, surface scope. If they fail with judgment-call edits, mark `[?]`.

## Operating principle

Each item ends in one of: `[x]` (resolved + commit), `[?]` (genuinely needs user input — surface options), or `[~]` (scoped + design note committed, follow-up tracked).

Verification gates same as previous loops: `npm test` + `npm run build` for code-changing items.

---

## In scope

### RES.30 — Issue #30: merge `autoRecallAgents` + `autoCaptureAgents` → `memoryAgents`
- [x] **30.1** Call site map (9 in code, 4 in docs):
  - `index.ts:89,93` — PluginConfig interface declarations
  - `index.ts:1076-1077` — validateAgentList() in config validation
  - `index.ts:1213` — recallAgents read in `before_prompt_build` (recall logic)
  - `index.ts:1343,1355` — captureAgents read in capture logic
  - `index.ts:1831,1836` — normalization in createMemexConfig
  - `SKILL.md:48,63,109,112` — config examples + table
  - **No test files reference these keys directly** (tests use the normalized config object).
- [x] **30.2** `memoryAgents` field added to PluginConfig interface; new `mergeAgentLists()` helper extracted to `src/agent-merge.ts` (extraction was forced by jiti only exposing `default` from index.ts to test imports). Validation extended to cover `memoryAgents`. Backward compat: union semantics — legacy keys never restrict.
- [x] **30.3** SKILL.md updated: examples show `memoryAgents`, settings table has the new key + legacy keys clearly labeled. README+AGENTS.md+CLAUDE.md don't reference these specific keys, so no updates needed there.
- [x] **30.4** New test file `tests/memory-agents-config.test.ts` — 7 cases covering union, dedup, undefined fallback, legacy-only path. Total: **725 → 732 tests, all pass.**
- [x] **30.5** Bundled commit covers 30.2-30.5 (tightly coupled — splitting would leave broken-build commits between iterations). Closing issue #30 from this commit.

### RES.43 — PR #43: typescript 5.9 → 6.0
- [x] **43.1** Tried bump: `npm install --save-dev typescript@6.0.3` → build clean + 732/732 tests + 0 vulns under TS 6.0.3. No code changes needed.
- [x] **43.2a** Path (a) taken: zero-friction bump, no mechanical fixes needed. Resolved via direct commit `4d1b364` on memex-v0.7 (cleaner than merging dependabot PR — same outcome). PR #43 closed with explanatory comment, dependabot branch deleted. Bonus: npm install canonicalized a duplicate `files` block in package.json that was a merge artifact from PR #73.
- [x] **43.2b** N/A — path (a) succeeded.
- [x] **43.2c** N/A — path (a) succeeded.

### RES.23 — Issue #23: debug mode for injected recall
- [x] **23.1** Injection site: `index.ts:1209` (`before_prompt_build` hook). Two paths: (a) unified-recall path lines 1257-1288 when document search is enabled, (b) memory-only fallback lines 1289-1306. Both compute `results` (full retrieval objects with metadata) and `memoryContext` (formatted text). Final injection happens at line 1331-1333: `return { prependContext: buildRecallContext(memoryContext) }`. Debug capture should snapshot both the rich `results` array and the formatted text just before that return.
- [x] **23.2** `MEMEX_DEBUG_RECALL` env flag implemented in new `src/debug-recall.ts`. Truthy values (`1`/`true`/`on`) → default `${tmpdir}/memex-debug-recall/`. Other strings → literal directory path. Falsy → off.
- [x] **23.3** Payload shape: `{ ts, agentId, sessionId, query, source, resultCount, injectedContext, results: [{id, score, source, text(<=500ch), metadata}] }`. Two builder helpers: `buildPayloadFromUnifiedRecall` and `buildPayloadFromMemoryOnly`. Hooked into both injection paths in `index.ts:1294, 1314`.
- [x] **23.4** New test file `tests/debug-recall.test.ts` — 8 cases covering env flag interpretation, off-path no-op, on-path file write, payload structure, text truncation, write-failure swallow. Discovery during testing: `mkdir` on `/proc/...` paths hangs at the syscall level → switched test failure case to `/dev/null/sub` which fails fast with ENOTDIR.
- [x] **23.5** README "Debugging" section added (above Development), explains env flag + default path.
- [x] **23.6** Bundled commit covers 23.2-23.6. Issue #23 closed via this commit.

### RES.19 — Issue #19: production benchmark (scope only, not implement)
- [~] **19.1** Design note committed at `docs/design/production-benchmark.md`. Recommends BEIR 3-dataset subset (SciFact + NFCorpus + FiQA-2018, ~65K docs total, ~30 min wall-clock first run). Documents-only path through existing `UnifiedRetriever`. Conversation-memory side stays on LongMemEval as a separate track. Implementation sketch + concrete next-steps checklist included.
- [x] **19.2** Issue #19 to be commented + linked when committing this iteration.
- [?] **19.3** Implementation explicitly deferred to dedicated session — not loop work. Marked [?] per plan rule.

### RES.27 — Issue #27: memory browser UI (scope only, not implement)
- [~] **27.1** Design note committed at `docs/design/memory-browser.md`. Recommends **HTML playground** (deferring CLI TUI) using existing `api.registerHttpRoute` pattern + `auth: "gateway"` (same as `/__memex/health`). Two endpoints: `GET /__memex/browser` (HTML) + `GET /__memex/browser/api/query` (JSON with facets). Self-contained single-file UI. Reuses existing auth + zero new infra. Implementation sketch: `src/browser/{query,facets,html,index}.ts`. ~1 day of focused work.
- [x] **27.2** Issue #27 to be commented + linked when committing this iteration.
- [?] **27.3** Implementation explicitly deferred — feature work, not loop work. Marked [?] per plan rule.

### RES.21 — Issue #21: out-of-scope, mark
- [?] **21.1** Out-of-scope comment posted on issue #21 (https://github.com/ofan/memex/issues/21#issuecomment-4417756347). Reason: items are local OpenClaw infrastructure (WebSocket warnings, dir-permissions warnings, stale memex-audit sessions in gateway state, residual noise entries in user's personal DB) — none are memex code regressions. Issue stays open as personal tracker.

### RES.42 — PR #42: better-sqlite3 12.x (held)
- [?] **42.1** Confirmed PR #42 still OPEN with the rationale comment from loop 016 M4.2 (https://github.com/ofan/memex/pull/42#issuecomment-4417291235). Holding as tracker for upstream WiseLibs/better-sqlite3 Node 26 compat fix. No further action this loop.

### CLEAN — Final cleanup
- [ ] **CLEAN.1** Re-run `npm audit` — must still be 0.
- [ ] **CLEAN.2** Re-run `npm test` — 725+ tests must still pass.
- [ ] **CLEAN.3** Update PROGRESS.md with summary of resolved items.
- [ ] **CLEAN.4** List any newly-discovered work surfaced during this loop and add issue stubs OR add to PROGRESS.md.

---

## Out of scope

- **Tagging v0.7.2** — explicit user decision when there's a release narrative.
- **Implementing #19 or #27** — both are dedicated-session work.
- **Anything in #21** — different repo / infrastructure.
- **Bumping major deps beyond what's in #43** — no incidental bumps.
- **Force push to main** — never. `main` is already aligned via PR #73 squash-merge; nothing more to push from this loop.

---

## Loop operating rules

Each iteration:
1. Read this file, find the next `[ ]` item.
2. Do it. Verify (`npm test` + `npm run build` for code, `gh pr/issue` for closures).
3. Mark `[x]` (done) / `[?]` (needs user) / `[~]` (scoped + design note committed).
4. Commit + push.
5. End the iteration.

Surface for user input ONLY when:
- A judgment call appears (e.g. PR #43 needs non-mechanical edits)
- A surprise comes up (e.g. test count regresses significantly)
- A scoped item (`[~]`) needs user pick on direction

If all items are `[x]` / `[?]` / `[~]`, AND `npm audit` is 0, AND no surprise unresolved scope, output:
```
<promise>RESOLVE EVERYTHING LOOP COMPLETE</promise>
```

**Hard cap: 25 iterations.**

---

## Iteration log

<!-- (loop fills this in) -->

---

## Pointers

- Predecessors: 014, 015, 016 (all complete)
- Roadmap: `013-post-v0.6.2-roadmap.md`
- Open issues at start: 5 (`#19`, `#21`, `#23`, `#27`, `#30`)
- Open PRs at start: 2 (`#42`, `#43`)
