# Progress

## Last Updated: 2026-06-28

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

1. **MCP Process Architecture** — single daemon vs subprocess-per-platform; user wants cross-device pool (Pattern B, single daemon on Host B via Tailscale)
2. **Memory Scoping** — provenance metadata (device × project × agent), classification on store, recall policy, judgment layer

Both problems are in **understanding phase**. Do not collapse into a single plan. Reasonable order: Problem 2 first (data model), Problem 1 second (deployment).

## Last Updated: 2026-04-13

## Current State

**Retrieval quality:** 94% E2E (LongMemEval, GPT-4o), 82% R@1, 90% R@3. Domain eval 12/15.
**Test suite:** 710 tests, all passing.
**Architecture:** Single SQLite DB. Dual retriever: MemoryRetriever (tools) + UnifiedRetriever (auto-recall). MCP server for cross-platform access. Background dreaming with LLM reflection.

## Roadmap Status

| # | Project | Status |
|---|---|---|
| 1 | Pool Cleanup | **Done** — session import decay, entity gating, 1,652 entries at 0.1 pending eviction |
| 2 | MCP Server | **Done** — 5 tools, stdio, env config, op injection, BM25 fallback, background dreaming, server instructions. 11 tests. Live in Claude Code. |
| 3 | Dreaming Reflection | **Done** — Stanford question synthesis, contradiction detection, LLM wiring, E2E verified (3 learnings, 2 contradictions from production). 27 dreaming tests. |
| ~~4~~ | ~~Session Import v2~~ | **Killed** — real-time capture via `memory_store` replaces batch import |
| 4 | Model Bakeoff | Queued — EmbeddingGemma-300M, Contextual AI Reranker v2 |
| 5 | Memory Hierarchy | Future |
| **NEW** | Claude Code Integration | **Research needed** — design doc at `docs/design/claude-code-integration.md` |

## Commits This Session (2026-04-12 to 2026-04-13)

| Commit | What |
|---|---|
| `aa37247` | Pool cleanup: session import decay + entity feature gating |
| `56b52f2` | MCP server: 5 tools, stdio, background dreaming |
| `f384b01` | Dreaming reflection: LLM synthesis + contradiction detection |
| `165aabb` | MCP: shared DB, BM25-only mode |
| `7bebad9` | Gitignore .mcp.json, env var for API key |
| `cc58895` | .mcp.json: jiti loader, absolute paths |
| `9315017` | MCP: full env-driven config, op for API key |
| `01201ed` | Remove hardcoded op call from server |
| `eacef48` | Kill session import v2, dreaming is core feature |
| `85c212a` | Wire LLM config into MCP server for reflection |
| `a65e0b0` | Fix: reflection handles reasoning models, max_tokens 8192 |
| `e064b65` | Configurable background dreaming schedule |
| `4720c17` | Dreaming dry-run script + docs visualization |
| `0543cfe` | Progress update |
| `84decae` | MCP server instructions — auto-recall and auto-store |

## Key Decisions

- 2026-04-13: MCP server instructions inject auto-recall/auto-store prompting via protocol (more reliable than CLAUDE.md)
- 2026-04-13: Session import v2 killed — real-time capture replaces batch import
- 2026-04-13: Dreaming is the core feature — the memory lifecycle
- 2026-04-13: Claude Code integration needs product design research (use cases, DB strategy, embedding strategy)
- 2026-04-12: MCP server is infrastructure, not just adoption
- 2026-04-12: Entity boost + entity graph gated off (net-neutral on quality)
- 2026-04-12: Session import decay rules (>14d → 0.1, >30d → evict)
- 2026-04-12: op injection via `op run` in .mcp.json for secrets

## Open Questions (Claude Code Integration)

1. **DB scope:** Global pool (shared with OpenClaw) vs per-project vs layered?
2. **Embedding strategy:** Zero-config BM25-only vs bundled local model vs cloud API?
3. **CLAUDE.md relationship:** Complement (static rules vs dynamic memory) vs generate sections?
4. **Document search:** Needed in Claude Code (which has file access) or OpenClaw-only?
5. **Standalone product:** Should memex work for users without OpenClaw?

Design doc: `docs/design/claude-code-integration.md`

## Next Session Should

1. **Research Claude Code integration** — study how other MCP memory servers handle DB scope, embedding, project context
2. **Verify session import eviction** — entries cross 30d on ~April 14
3. **Decide on Claude Code product direction** based on research
