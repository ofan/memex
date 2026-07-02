# Progress

## Last Updated: 2026-07-02

## Session 2026-07-02 — recall-quality design consolidation

Merged the three recall-quality design docs into one canonical spec: **`docs/design/recall-quality-design.md`** (supersedes `retrieval-redesign.md`, `recall-validation-analysis-revised.md`, `feedback-loop.md`, now under `docs/design/archive/`). Produced via merge → 2 adversarial self-review rounds. All 7 spec-review criticals (C1–C7) fixed + verified against code; the validation plan (10 criteria, 17 gaps, 18 fixes F1–F18), TDD tests per change, and 5-wave + 5-gate sequencing are all in the one doc. Notable round-2 catch: enabling the reranker on the MCP path is a no-op without wiring `MEMEX_RERANK_*` env vars into `createMemexMcpServer` (the same class of bug as the original "MCP disables reranker"). Visualization: `recall-quality-loop.html`. Next: Wave 0 (measurement — production-config benchmarks, live-sampling, CIs, hardMinScore test audit) + F5 (`recordRecalls` — urgent data-corruption fix).

## Session 2026-06-29 — v0.7 delivery push

Drove the four roadmap priorities on `memex-v0.7`:

- **Quick wins ✅**
  - **Flaky `mcp-server-shutdown` SIGTERM test stabilized.** Root cause: signal handlers were registered late in `main()` (after the readiness log), and `spawnServer` leaked its child on rejection (cleanup lived in a `try` after the `await`). Fix (`src/mcp-server.ts`): register SIGTERM/SIGINT as the *first* thing in `main()`; emit `memex-mcp: ready (stdio|http)` *after* transport connect as the canonical readiness signal. Fix (`tests/mcp-server-shutdown.test.ts`): key readiness on `ready`, kill the child on rejection, bump `STARTUP_TIMEOUT` to 15s. Verified: 24/24 under the parallel load that previously failed 8/8 + leaked 8 servers; full suite 900/900.
  - **Noise purge.** Purged **13** entries of leaked LLM-internal meta-commentary (`[Final Check]`, `Self-Correction during generation`, etc.) captured as "learnings" — more than the estimated 6. `learning` category 25 → 12. Root cause: the dreaming reflection phase stores the reflection LLM's formatting self-talk without filtering — follow-up to add a CoT/meta-commentary noise rule.
- **Containerize daemon (019) ✅** — `Dockerfile` (multi-stage, `node:25-slim`, pre-built `dist/`, native-binding rebuild safety net, non-root, `/health` HEALTHCHECK), `.dockerignore`, `docker-compose.yml` (host networking for Tailscale), `memex.env.example`, `docs/deploy/container.md`. Build-verified: image builds, daemon starts (`ready (http …)`), `/health` returns 200, runs as `uid=999(memex)`. Node pinned to 25 (Node 26 breaks better-sqlite3). Also rebuilt stale `dist/` (caught up `dreaming.ts` semantic-dedup from `6134cb2`).
- **Feedback loop ✅ (design-only)** — `docs/design/feedback-loop.md`. Investigation finding: a bounded recall-frequency boost **already exists** (`retriever.ts:807`, +10% cap) but is *ephemeral* (in-memory map, resets on restart) and the **MCP `memory_recall` tool never bumps `recall_count`**, so the pool is 99.26% zero and the boost is a near-no-op today. Design recommends promoting the existing boost to the persistent column + fixing MCP capture (highest leverage), with a provably-bounded log-additive formula and a 7-test TDD plan. Implementation (TDD) deferred.
- **Ship `memex-v0.7` → `main`** — squash PR (this session).

Minor follow-ups surfaced (non-blocking): `/health` reports a stale `version:"0.6.0"` vs package `0.7.2`; `npm ci` flags 13 transitive vulns in prod deps (pre-existing, orthogonal to this work).

## Roadmap — next priorities

1. ~~**Containerize memex daemon** (`019`)~~ ✅ done 2026-06-29.
2. ~~**Feedback loop** — design~~ ✅ done; **TDD implementation next** (see `docs/design/recall-quality-design.md` — start with the MCP `recall_count` capture fix / F5, the highest-leverage prerequisite).
3. **Ship `memex-v0.7` → `main`** — in progress (squash PR).
4. ~~**Quick wins** — shutdown test; noise purge~~ ✅ done.

Deferred: T4.2 MemoryAgentBench (benchmark), scope promotion UX, sensitive/private memories, T5 features (FadeMem, RL, multimodal), **reflection CoT/meta-commentary noise filter** (data-quality), **scope-visibility: readable project name + client dimension** (user feedback 2026-06-29), feedback-loop TDD implementation, `/health` version string, prod-deps audit pass.

## Memory Scoping — Implementation (018)

Implemented multi-valued scope tags on `feat/memory-scoping` (off `memex-v0.7`). See `docs/design/memory-scoping.md` (design) and `docs/plans/018-memory-scoping-impl.md` (plan).

### Phases completed

- **P1-P3 (foundation)**: `memory_scopes(memory_id, scope)` table + migration, `src/scope-derive.ts` with `deriveScopes()` (server-authoritative: auto-tags global + project:<git_remote-hash>; opt-in client/agent/session; device metadata-only), store writes multi-valued tags.
- **P4 (recall)**: Tag-intersection filter on `memory_scopes` in `vectorSearch`, `bm25Search`, `list`, `stats`, `bulkDelete`, `update`, `delete`. `retriever.retrieve()` accepts `scopes` override.
- **P5 (dreaming)**: Scope-aware dedup (GROUP BY text, scope-set). Reflection learnings inherit tags (single-context => those tags; mixed => global).
- **P6 (MCP tool surface)**: `memory_store` and `memory_recall` accept `agent_id`, `session_id`, `scopes` params. `memory_store` calls `deriveScopes()` for server-authoritative derivation.
- **P7 (E2E integration)**: Store under multiple contexts (projects A/B, clients, sessions, agents), recall from each, assert no cross-project leak, global surfaces, sparse behavior, dreaming respects scope. 21 new E2E tests.
- **P8 (sync)**: Design doc unchanged (implementation matches spec).

### Interface drift reconciled

- `mcp-server.ts`: `memory_store` now calls `deriveScopes()` with process cwd/env, client name detection, and explicit `agent_id`/`session_id` params. Passes derived multi-valued `scopes` to `store.store()`. `memory_recall` accepts `agent_id`/`session_id` params.
- `tools.ts`: Plugin-side `memory_store` and `memory_recall` updated with same `deriveScopes()` integration and `agent_id`/`session_id` params.
- Store and dreaming needed no changes — their interfaces were already correct.

### Test counts

- **Before**: 830 tests (foundation baseline)
- **After**: 851 tests (830 + 21 E2E)
- All green, no regressions.
- Domain eval: cannot run (no embedding endpoint configured in this environment). Retrieval path unchanged for empty scopeFilter — `addScopeFilter` returns early.

### Deviations from design

- The plugin-side auto-recall hook (`index.ts`) still uses the legacy `scopeManager.getAccessibleScopes(agentId)` for the active-context scope set. It does not yet derive `project:` tags for the auto-recall filter. This is a known gap: the design calls for server-authoritative derivation in the recall path, but the plugin hook runs inside the OpenClaw gateway process where `process.cwd()` is the gateway's directory, not the agent's project directory. See design: stdio has access to client cwd; HTTP needs client-supplied tags. The standalone MCP server (stdio) correctly derives project tags. The plugin (effectively HTTP backend) needs the OpenClaw client to supply project context — deferred to T2.1/T2.2.

### No blockers

## Resolve-everything loop (017) — same-day post-housekeeping

Drove all 5 open issues + 2 open PRs to resolution after the 016 housekeeping loop. Outcome:

- **3 issues closed**: #30 (memoryAgents config — code shipped); #23 (debug-recall env flag — code shipped); #43 (typescript 6.x bump — closed via direct commit, dependabot branch deleted)
- **2 issues scoped** (`[~]` design notes only — implementation deferred to dedicated sessions): #19 (production benchmark → `docs/design/production-benchmark.md`, BEIR 3-subset recommended); #27 (memory browser → `docs/design/memory-browser.md`, HTML playground recommended)
- **1 issue marked out-of-scope** (`[?]`): #21 (local OpenClaw infrastructure items, not memex code)
- **1 PR kept open** as Node-26 tracker (`[?]`): #42 (better-sqlite3 12.x — waiting on upstream WiseLibs fix)

Test count progression across the loop: 725 → 740 (gained 7 from RES.30 + 8 from RES.23). `npm audit` stayed at 0. Build clean. No version bump (intentional — v0.7.2 tag is a separate user-driven decision).

## Branch cleanup (post-v0.7.1, housekeeping loop 016)

Reduced active remote branches from 27 → 5 in the `016-housekeeping-loop.md` pass:

- **22 dependabot branches resolved**: 18 already deleted on remote (cleared via `git remote prune origin`); 4 superseded PRs closed with explanatory comment + branches deleted (#36, #38, #39, #40 — all addressed by v0.7.1 audit fix or M3's GitHub-Actions bump).
- **10 legacy `feat/*` and `fix/release-*` branches** also cleared by the prune (they were stale local refs only — already deleted on remote during the v0.6.x ship phase).
- **2 dependabot branches kept open with rationale**: #42 `better-sqlite3-12.9.0` (Node 26 compat tracker), #43 `typescript-6.0.3` (devDep major bump for user judgment).
- **1 branch surfaced to user**: `rename-to-memclaw` has 24 unique unreachable commits (early benchmark experiments, LanceDB Pro results, llama.cpp router decisions). Loop refused to delete autonomously — see plan M4.1 [?] for the four options (keep / archive-tag / cherry-pick + delete / delete outright).

Final remote branch state: `main`, `memex-v0.7`, `rename-to-memclaw`, `dependabot/npm_and_yarn/better-sqlite3-12.9.0`, `dependabot/npm_and_yarn/typescript-6.0.3`.

**Update 2026-05-11:** `rename-to-memclaw` deleted (option c, plan M4.1 [x]). `dependabot/npm_and_yarn/typescript-6.0.3` deleted (PR #43 closed via direct commit in loop 017). Final remote branch state: `main`, `memex-v0.7`, `dependabot/npm_and_yarn/better-sqlite3-12.9.0`. Three branches.

## Surfaced this session (loop 017) — needs ticketing or follow-up

- **Dual-typebox dependency situation resolved** in M2 (loop 016) → moved memex from `@sinclair/typebox` to unscoped `typebox` to align with openclaw's choice. Dropped 4 type-bridge casts.
- **jiti only exposes `default` exports from index.ts** to test imports — discovered while writing 30.4 tests for `mergeAgentLists`. Workaround: extracted helper to `src/agent-merge.ts` (own module). Worth knowing for future test additions; consider a small note in CLAUDE.md or AGENTS.md.
- **`mkdir` on `/proc/...` paths hangs at the Node syscall level** — discovered while writing 23.4 tests for `writeDebugRecall`. Use `/dev/null/sub` (fast ENOTDIR) for any future "unwritable path" test fixtures.
- **`package.json` had a duplicate `files` block** (merge artifact from PR #73) — auto-canonicalized by `npm install` during RES.43. No follow-up needed; just noting for the merge-artifact archaeology.
- **Two design notes pending implementation**: `docs/design/production-benchmark.md` (BEIR 3-subset, ~1 day) and `docs/design/memory-browser.md` (HTML playground, ~1 day). Both have concrete next-step checklists.

## Active Architectural Tracking

**Two open architectural problems** are being formalized — see `docs/plans/two-problems-architecture.md`:

1. **MCP Process Architecture** — single daemon vs subprocess-per-platform; user wants cross-device pool (Pattern B, single daemon on the inference host via Tailscale)
2. **Memory Scoping** — provenance metadata (device × project × agent), classification on store, recall policy, judgment layer

Both problems are in **understanding phase**. Do not collapse into a single plan. Reasonable order: Problem 2 first (data model), Problem 1 second (deployment).

