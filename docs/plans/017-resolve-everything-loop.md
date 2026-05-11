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
- [ ] **30.1** Find call sites: `grep -rn "autoRecallAgents\|autoCaptureAgents" src/ index.ts tests/`. Map each to a kind (read / write / config-schema / docs).
- [ ] **30.2** Add `memoryAgents` config key + schema validation. Backward compat: if old keys present, merge them and log a one-line warning.
- [ ] **30.3** Update README + AGENTS.md / CLAUDE.md examples to recommend `memoryAgents`.
- [ ] **30.4** Tests: add a coverage test that the merged-config path matches old behavior. Existing tests must still pass.
- [ ] **30.5** Commit + push. Close issue #30 with PR-link comment (no PR — direct commit on memex-v0.7).

### RES.43 — PR #43: typescript 5.9 → 6.0
- [ ] **43.1** Try the bump locally: `npm install --save-dev typescript@6.0.3 && npm run build && npm test`.
- [ ] **43.2a** If build + tests pass clean: merge PR #43 (squash). Mark [x].
- [ ] **43.2b** If build fails with mechanical fixes (e.g. `as const` widening, `verbatimModuleSyntax`): apply the fixes, verify, then merge.
- [ ] **43.2c** If build fails with non-mechanical issues (large refactor needed): close PR #43 with explanatory comment; revert local change; mark [?].

### RES.23 — Issue #23: debug mode for injected recall
- [ ] **23.1** Identify the injection site: `before_prompt_build` hook in `index.ts` (where memories actually become context).
- [ ] **23.2** Add `MEMEX_DEBUG_RECALL` env flag (or `config.debugRecall: true`). When set: write the final injected payload to `/tmp/memex-debug-recall-<timestamp>.json` (or configurable path).
- [ ] **23.3** Payload shape: `{ turn: { agentId, sessionId, ts }, query, recalledItems: [...], injectedSlice: [...], cuts: [reason per dropped item] }`.
- [ ] **23.4** Add a test that verifies the payload structure when the flag is on (no behavior change when off).
- [ ] **23.5** Document in README under "Debugging" section.
- [ ] **23.6** Commit + push. Close issue #23 with implementation-link comment.

### RES.19 — Issue #19: production benchmark (scope only, not implement)
- [~] **19.1** Write a scoped design note at `docs/design/production-benchmark.md`:
  - Why BEIR (mixed corpus, comparable across systems)
  - Which BEIR datasets fit memex's mixed-source path (probably SciFact + NFCorpus + small subset; full BEIR = too long)
  - How to wire it through `UnifiedRetriever` (mock-doc-corpus or real-doc-corpus path?)
  - Expected runtime + cost
  - Concrete next-steps as a checklist
- [ ] **19.2** Commit the design note. Add issue comment: "scoped — see `docs/design/production-benchmark.md`. Implementation deferred to dedicated session." Mark issue with a `scoped` label if labels exist; otherwise leave open.
- [?] **19.3** Mark loop item `[?]` — actual implementation needs dedicated session, not a loop iteration.

### RES.27 — Issue #27: memory browser UI (scope only, not implement)
- [~] **27.1** Write a scoped design note at `docs/design/memory-browser.md`:
  - HTML playground vs CLI TUI vs both — recommend one
  - Endpoint surface needed (e.g. `/__memex/browser` served by gateway or daemon)
  - Auth model (bearer token? localhost-only?)
  - Search UX (text query / category filter / date range / scope drilldown)
  - Concrete next-steps checklist
- [ ] **27.2** Commit design note. Add issue comment with link. Mark `[?]` for implementation.
- [?] **27.3** Mark loop item `[?]` — feature work, not loop work.

### RES.21 — Issue #21: out-of-scope, mark
- [?] **21.1** Add issue comment: "tracked separately — these are local OpenClaw infrastructure items, not memex code regressions. Memex-side: nothing to do. Out of scope for the resolve-everything loop." Mark `[?]` here.

### RES.42 — PR #42: better-sqlite3 12.x (held)
- [?] **42.1** Already has a rationale comment from M4.2. Leave open as tracker. Mark `[?]` with link to existing comment.

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
