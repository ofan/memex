# Changelog

## [Unreleased] — feat/memory-scoping

**Theme: context-aware memory isolation.** Multi-valued scope tags replace the single `scope` column with a `memory_scopes` join table. Server-authoritative derivation ensures consistency; recall uses additive tag intersection so cross-project leakage is impossible. Tests: 830 → 851 (+21 E2E).

### Added
- **`memory_scopes(memory_id, scope)` table** — multi-valued scope tags per memory. Supersedes the single `memories.scope` column. Migration converts existing `global` memories to one `global` tag each.
- **`src/scope-derive.ts`** — server-authoritative scope derivation (`deriveScopes()`). Auto-tags `global` + `project:<git_remote-hash>`; opt-in `client:`, `session:`, `agent:`; device is metadata-only. Works from stdio (has client cwd); HTTP clients must supply project context.
- **Tag-intersection recall** — `vectorSearch`, `bm25Search`, `list`, `stats`, `bulkDelete`, `update`, `delete` all filter via `EXISTS`/join on `memory_scopes` against the active-context tag set. `retriever.retrieve()` accepts `scopes` override.
- **Scope-aware dreaming** (`src/dreaming.ts`) — dedup key is `(text, scope-set)`; identical text under different tags is not a duplicate. Reflection learnings inherit tags: single-context batch → those tags; mixed-context batch → `global`.
- **MCP tool surface** — `memory_store` accepts `agent_id`, `session_id`, `scopes` params and calls `deriveScopes()` for server-authoritative derivation. `memory_recall` accepts `agent_id`, `session_id` params.

### Known gap
- **Plugin auto-recall hook** (`index.ts`) still uses the legacy `scopeManager.getAccessibleScopes(agentId)` for the active-context scope set. It does not yet derive `project:` tags because the plugin runs inside the OpenClaw gateway process where `process.cwd()` is the gateway directory, not the agent's project directory. The standalone MCP server correctly derives project tags. Deferred to T2.1/T2.2.

### Plans
- See `docs/plans/018-memory-scoping-impl.md` for the implementation plan.
- See `docs/design/memory-scoping.md` for the design.

---

## [0.7.3] — 2026-07-09

**Theme: recall-quality correctness + production wiring.** Wires the reranker into the MCP path, fixes dead config (hardMinScore, recordRecalls), adds LLM-based reranker, retries on 500, and hardens dependency resolution. Domain eval expanded to 26 queries with Wilson 95% CI: baseline 69%, cross-encoder 77%, LLM reranker 85%.

### Added
- **LLM reranker** (`src/rerankers/llm-reranker.ts`) — ordering-based relevance judge using a chat model (deepseek-v4-flash). Opt-in via `MEMEX_RERANK_LLM_MODEL`. Uses `node:http` directly (not fetch) to avoid chunked-encoding issues with the nginx ingress. Quality: 85% on domain eval (vs 69% baseline, 77% cross-encoder).
- **`src/transient-retry.ts`** — retry helper for embedding + reranker clients. Retries on 500/502/503/504 (llama.cpp "Compute error" returns 500 for transient OOM/queue-full) + network timeouts (AbortError/TimeoutError). 4 attempts with exponential backoff (1s, 2s, 4s).
- **`MEMEX_HARD_MIN_SCORE_OVERRIDE` env var** — runtime kill-switch for the absolute score floor. Set to override `config.hardMinScore` without redeploy.
- **`MEMEX_RELEVANCE_FIRST` env flag** (opt-in, off by default) — caps recency to a tie-break (+0.05 max) and relevance-gates it (no boost when score < 0.40). Disables multiplicative timeDecay.
- **Domain eval expansion** (PR #97) — 26 queries (was 15), Wilson 95% CI on hit rate, `QUERY_DELAY_MS` pacing, `RERANK` env supports `"1"|"cross-encoder"|"llm"|"none"`.
- **Scope-visibility** (PR #100) — `memory_stats` now returns `byProject` and `byClient` breakdowns read from metadata JSON. Makes scope tags human-readable.

### Fixed
- **F5: `recordRecalls` wired in MCP path** (`src/mcp-server.ts`) — `memory_recall` now calls `store.recordRecalls()` in both the retriever and BM25 fallback paths. Fixes the 99.26% zero `recall_count` data-corruption bug (Gap 10).
- **F12: `hardMinScore` wired** (`src/retriever.ts`) — `applyAdaptiveMinScore` now reads `this.config.hardMinScore` instead of hardcoding `0.15`. Default changed from 0.40 to 0.15 (preserves pre-fix behavior). Kill-switch via `MEMEX_HARD_MIN_SCORE_OVERRIDE`. 8+ test files that set `hardMinScore: 0.0` were vacuously testing at the old hardcoded floor.
- **Reranker enabled in MCP path** (PR #103) — `createMemexMcpServer` reads `MEMEX_RERANK_ENDPOINT`, `MEMEX_RERANK_API_KEY`, `MEMEX_RERANK_MODEL` and dynamically sets `rerank: "cross-encoder"` (or `"llm"` when `MEMEX_RERANK_LLM_MODEL` is set). Was hardcoded `rerank: "none"` (C5, Gap 5).
- **CoT filter in dreaming** (`src/dreaming.ts`) — `filterLlmCommentary` strips LLM meta-commentary from reflection learnings (13 purged, PR #95).
- **`@modelcontextprotocol/sdk` declared as direct dependency** (PR #104) — was transitive via openclaw; broke when openclaw bumped its peer. Pinned at `^1.29.0`.
- **Typebox dedup with openclaw** (PRs #105, #106) — exact-pin `typebox` to `1.1.39` to guarantee single copy (dual-instance breaks `tools.ts`). Paired with openclaw's matching pin.
- **`/health` exempt from auth** (PR #101) — Docker/k8s liveness probes can check `/health` without a bearer token.
- **Secrets hygiene** (PRs #98, #99) — anonymized domain eval queries and original eval. Broadened secret-pattern guidance in AGENTS.md.

### Changed
- **`better-sqlite3` 11.x → 12.11.1** (PR #75) — Node 26 compatible native bindings.
- **Node engine floor raised to >=22.19.0** (PR #105) — required by undici dep via openclaw.
- **`openai` ^6.46.0** — dependency bumps.
- **Temporal signals behind `MEMEX_RELEVANCE_FIRST` flag** (PR #96) — off by default, prevents recency from overriding relevance.

### Known gap
- `VERSION` in `src/mcp-server.ts` is still `"0.7.2"` (UNFIXED as of 0.7.3 — needs bump to 0.7.3).
- `retriever.ts:3` header comment still says "RRF fusion" instead of "weighted or zscore fusion".
- `openclaw.plugin.json` `openclawVersion` is `"2026.5.7"` — should be `"2026.6.11"` matching the `openclaw` dep.
- Domain eval uses zscore fusion (0.8/0.2 weights), not the production weighted default (0.7/0.3) — config drift remains (Gap 4).
- Plugin auto-recall hook still uses legacy scope derivation (deferred to T2.1/T2.2).

---

## [0.7.2] — 2026-05-11

**Theme: configuration ergonomics + debug visibility.** Three user-visible improvements on top of v0.7.1, all backward-compatible. Test count 725 → 740 (+15). `npm audit` still 0.

### Added
- **`memoryAgents` unified config key** (issue #30, `src/agent-merge.ts`) — single agent whitelist that controls both recall and capture. Replaces the separate `autoRecallAgents` + `autoCaptureAgents` pair. Backward compat via union semantics: legacy keys never restrict, only extend.
- **`MEMEX_DEBUG_RECALL` env flag** (issue #23, `src/debug-recall.ts`) — when set, every auto-recall turn writes a JSON snapshot of the formatted text prepended to the prompt plus per-item metadata. Lets you answer "what low-quality items actually made it into the context this turn?" — otherwise impossible from logs alone. Off by default; zero overhead. Truthy values (`1`/`true`/`on`) → `${tmpdir}/memex-debug-recall/`; other strings → literal path.
- **Two design notes** committed for future-session work: `docs/design/production-benchmark.md` (BEIR 3-subset for externally-comparable IR quality, issue #19) and `docs/design/memory-browser.md` (HTML playground served via existing `api.registerHttpRoute`, issue #27).

### Changed
- **`typescript` dev-dep bumped 5.9 → 6.0.3** (closes PR #43). Zero-friction bump; no code changes needed. Real `tsc` build still clean.
- **`@sinclair/typebox` replaced by unscoped `typebox`** in direct deps. Eliminates a dual-package situation surfaced by v0.7.1's `npm audit fix` — memex's `Type` and openclaw's `stringEnum` now come from the same package. Removes 4 type-bridge casts from `src/tools.ts`.
- **`memex-v0.7` merged into `main`** via PR #73 (squash) — main was stuck at v0.6.2; the 2 dependabot UI alerts on default branch should auto-close on next scan.

### Plans
- See `docs/plans/017-resolve-everything-loop.md` for the loop that produced this release.
- 016 housekeeping loop summary recorded in `docs/plans/PROGRESS.md` (branch count 27 → 3).

---

## [0.7.1] — 2026-05-10

**Theme: security bump.** Closes 18 transitive vulnerabilities (2 critical, 6 high, 10 moderate) surfaced by `npm audit` after v0.7.0 ship. No new features, no behavior change.

### Fixed — security
- **`npm audit fix` (non-force)** resolved all 18 transitive vulns in one shot: lockfile-only changes (added 121 packages, removed 26, changed 140). Final `npm audit` count: **0 vulnerabilities**. Affected upstream packages included `protobufjs` (critical RCE), `axios` (12 advisories: SSRF / prototype pollution / CRLF), `picomatch` (high+moderate ReDoS / glob method injection), `@anthropic-ai/sdk` (sandbox escape), `@hono/node-server` (middleware bypass), `path-to-regexp`, `fast-xml-parser`, `protobufjs`, `uuid`, and others — all transitive through `openclaw` / `openai` / `@ofan/telemetry-relay-sdk`.
- **`src/tools.ts`** — added 4 type bridges (`as unknown as Parameters<typeof Type.Optional>[0]`) at the `stringEnum()` call sites. The audit-fix lockfile shift moved openclaw's transitive resolution from `@sinclair/typebox` onto unscoped `typebox@1.1.37`. Memex's own schema construction still uses `@sinclair/typebox@0.34.48`, so `Type.Optional()` and `stringEnum()` now come from two different typebox packages whose `TUnsafe`/`TSchema` types disagree at the TypeScript level (runtime is structurally compatible). Surgical cast — no code refactor.

### Changed
- Direct `dependencies` in `package.json` unchanged. All vulnerability fixes were achieved via lockfile-only resolution updates.

### Plan
- See [`docs/plans/015-v0.7.1-security-bump-loop.md`](docs/plans/015-v0.7.1-security-bump-loop.md) for the loop that produced this release.

---

## [0.7.0] — 2026-05-10

**Theme: cross-device memory daemon, ready for self+others.** v0.7 builds on v0.6.2 (citation-anchored recall, build step) and adds the daemon / dreaming / Claude Code integration that turn memex from a per-project plugin into a personal cross-device memory layer. Architecture decisions are intentionally limited to "current implementation is one valid answer" — see `docs/plans/013-post-v0.6.2-roadmap.md` for the deferred questions.

### Added — features
- **Standalone MCP server with HTTP transport** (`src/mcp-server.ts`) — runs as a daemon (per-session transports + bearer auth) so multiple devices and platforms (OpenClaw, Claude Code, future MCP clients) can share a single SQLite memory pool. stdio mode preserved for local subprocess.
- **Claude Code plugin** at `plugin/memex-claude-code/` — bundled `SessionStart` / `UserPromptSubmit` / `Stop` hooks plus `.mcp.json` referencing `${MEMEX_ENDPOINT}` / `${MEMEX_AUTH_TOKEN}` env vars.
- **Dreaming consolidation** (`src/dreaming.ts`) — light sweep + deep sweep + LLM reflection (DeepSeek v4-pro by default). `/dream` slash command replaces the previous timer-based scheduler.
- **Entity graph** (`src/graph.ts`, `src/entities.ts`) — entity extraction as 3rd retrieval signal (ACT-R spreading activation), adjacency links, one-hop expansion, link-backfill on startup.
- **Temporal query detection** (`src/temporal.ts`) — regex date-range filtering wired into the retriever.
- **Intake guards** — text-hash dedup, conversation-fragment rejection, schema migration.
- **Reranker upgrade**: Qwen3-Reranker-0.6B-Q8_0 replaces bge-reranker-v2-m3-Q8_0. R@1 78% → 82%, E2E 90% → 94% on `LongMemEval_s` N=50.
- **Eval harness** — model-bakeoff (`scripts/bakeoff`), domain-eval (`tests/domain-eval.ts`), BEIR benchmark, latency probe.

### Added — citation feature parity with v0.6.2
- **`src/anchor.ts`** — citation-anchor helpers (`anchor()`, `expandAnchor()`, `looksLikeAnchor()`, `AnchorAmbiguityError`). Backported from main.
- **MCP server `memory_recall`** — results include `anchor` + `scope` fields and a citation-guidance `note` in the response payload.
- **MCP server `memory_forget`** — accepts a citation anchor (8+ hex chars) or any longer prefix; returns `anchor_ambiguous` / `anchor_not_found` errors.
- **Plugin README** — new "Citation anchors" section.

### Fixed — sensitive-references audit (cleanup before wider sharing)
- **`plugin/memex-claude-code/README.md`** — Tailscale IP and 1Password vault name in examples replaced with `<your-memex-host>` / `<your-vault>` placeholders.
- **`scripts/bakeoff`, `tests/latency-probe.ts`, `docs/architecture.html`** — `op://` references genericized to `op://<vault>/<item>/...`.
- **`docs/research/embed-rerank-upgrade-brief.md`, `docs/design/model-bakeoff.md`** — `~/infra-project/...` paths replaced with `~/<infra-repo>/...`; explicit vault/item naming removed.
- **`docs/plans/2026-04-10-loop-report.md`, `CHANGELOG.md`** — private-infra repo references in commit citations replaced with `infra-repo`.
- **`docs/plans/012-memex-dreaming.md`** — telemetry-relay worker subdomain replaced with `<your-telemetry-relay>` placeholder.
- **`docs/design/mcp-server.md`** — Tailscale CGNAT example IP replaced with `<embed-host>:<port>`.
- **`docs/research/003-memory-retrieval-sota.md`** — example metadata strings switched from `homelab/infra` to `myproject/infra`.
- **Test fixtures + docs (~25 files)** — homelab-named host fixtures (`host-a` / `host-b` etc.) and persona names (`Alex` / `Jordan`) replace previous personal naming. Public model names like Gemma/Qwen kept as-is.
- **`.githooks/pre-commit`** — sensitive pattern list moved to gitignored `.githooks/secret-patterns.local`; hook now sources patterns from there with a committed `.example` template. Universal secret prefixes (OpenAI / GitHub / etc.) kept inline.

### Changed
- Inherits all v0.6.2 changes (see below).
- `package.json` `openclaw.compat.pluginApi` and `runtimeExtensions` set to current openclaw version.
- `package.json` `bin.memex-mcp` points at compiled `./dist/src/mcp-server.js`.

---

## [0.6.2] — 2026-05-10

**Add `runtimeExtensions` and `files` to package.json — what clawhub actually wanted.** The "requires compiled runtime output" error from clawhub validator was misleading — the file was always present in `dist/`, but clawhub finds it via the `openclaw.runtimeExtensions` field, not by inferring `./dist/index.js` from the source `./index.ts` entry. `@openclaw/lobster` has this field; memex was missing it. Verified locally with `clawhub package pack`.

### Added
- **`openclaw.runtimeExtensions: ["./dist/index.js"]`** in `package.json` — points clawhub at compiled output (matches `@openclaw/lobster`'s manifest shape).
- **`files`** field in `package.json` — npm-pack inclusion list (`dist/**`, manifests, docs).

### Changed
- **`.github/workflows/release.yml`** — drops `index.ts` and `src/` from the publish payload (matches lobster's compiled-only shape; source is gitignored from the package even though it's in the repo).

## [0.6.1] — 2026-05-10

**Track `dist/` in git so clawhub finds it.** v0.6.0 built `dist/` correctly in the workflow but clawhub validates against the GitHub source-repo at the tagged commit, not the local publish payload. Since `dist/` was gitignored, clawhub didn't find it. Removing `dist/` from `.gitignore` and committing the compiled output.

### Changed
- **`.gitignore`** — `dist/` is now tracked (with explanatory comment).
- **`dist/`** — committed alongside source. Run `npm run build` to refresh before tagging.

## [0.6.0] — 2026-05-10

**Theme: real build step + version-line shift.** ClaHub's validator now requires compiled JS output for TypeScript code plugins. memex now compiles `index.ts` and `src/**/*.ts` to `dist/` at publish time. Source remains the editable artifact; tests still run against `.ts` via jiti. The `memex-v0.6` development branch is concurrently renamed to `memex-v0.7` so its in-flight architectural work (HTTP MCP daemon, dreaming, entity graph, Claude Code plugin) lands as v0.7+ and doesn't collide with the now-shipped v0.6 namespace.

### Added
- **`tsconfig.build.json`** — extends the main config with `noEmit: false`, `outDir: dist`, excluding tests. Used only for publish.
- **`build` script** in `package.json` — `tsc --noCheck -p tsconfig.build.json`. `--noCheck` strips types without type-checking (jiti-equivalent semantics; the existing 42 latent type errors are out of scope for this release and will be addressed separately).
- **`prepublishOnly`** runs build automatically.
- **`.github/workflows/release.yml`** — runs `npm run build` between `npm ci` and the publish step; copies `dist/` alongside the source files in the publish payload.

### Changed
- **`.gitignore`** — `dist/` excluded.
- **Version-line shift:** main bumps to `0.6.0`. The previously-named `memex-v0.6` branch is renamed to `memex-v0.7` (its in-flight features will ship as v0.7+).

### Notes for downstream
- ClaHub installs of `memex@0.6.0` get pre-built JS in `dist/`. OpenClaw's loader can use either `dist/index.js` or `index.ts` (jiti); local `npm link` deploys still work without running `npm run build`.
- 42 latent type errors exist in the codebase (jiti was hiding them). They don't block the build (`--noCheck`) but should be cleaned up in a follow-up PR. Run `npx tsc` to see the list.

## [0.5.15] — 2026-05-10

**Re-publish of v0.5.13/v0.5.14 after release-pipeline shakeout.** The clawhub CLI required a sequence of fixes (`--slug` → `--name`, `--family code-plugin`, `--source-repo`/`--source-commit`/`--source-ref`, and finally `openclaw.compat.pluginApi` + `openclaw.build.openclawVersion` in `package.json`). Code is identical to v0.5.13.

### Fixed
- **`package.json`** — added `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` (required for external code plugins per the new clawhub validator).
- **`.github/workflows/release.yml`** — added `workflow_dispatch` trigger so future re-publishes don't need a fresh version bump.

## [0.5.14] — 2026-05-09

**Re-publish of v0.5.13 after release-workflow fix.** v0.5.13 was tagged but its publish job failed because the `clawhub` CLI changed its publish syntax (`clawhub publish` → `clawhub package publish`) and nothing landed on ClaHub. Code is identical to v0.5.13.

### Fixed
- **`.github/workflows/release.yml`** — use `clawhub package publish <source>` (the old `clawhub publish <source>` form fails with "This looks like a plugin. Use `clawhub package publish <source>` instead.").

## [0.5.13] — 2026-05-09

**Theme: citation-anchored recall.** Each recalled memory now carries a short stable handle (`[mem:abc12345]`); the LLM is instructed to cite it when used and can `memory_forget` by the anchor. Inspired by ENGRAM-R (`arXiv:2511.12987`), which reports −85% input / −75% reasoning tokens vs full-context with this pattern at maintained accuracy.

### Added

- **`src/anchor.ts`** — citation-anchor helpers: `anchor(id)` returns the 8-char hex prefix used in `[mem:...]` / `[doc:...]` markers; `expandAnchor(prefix, candidates)` resolves a prefix back to a full id and detects ambiguity (`AnchorAmbiguityError`); `looksLikeAnchor(s)` for input validation. Storage-agnostic — caller passes the candidate id list. Unit tests in `tests/anchor.test.ts` (12 cases).
- **Citation instruction** added to `buildRecallContext` (`src/memory-instructions.ts`): tells the LLM to cite recalled memories by anchor in reasoning and how to delete by anchor via `memory_forget`. Verified by two new assertions in `tests/plugin-mock.test.ts`.

### Changed

- **Auto-recall format** (`index.ts` `before_prompt_build` hook) — both unified-recall and memory-only paths now render `- [mem:abc12345 · category · scope] ...` and `- [doc:abc12345 · path] ...` in the prepended `<relevant-memories>` block. Replaces the previous `[memory:category:scope]` / `[doc:path]` format.
- **`memory_recall` tool output** (`src/tools.ts`) — all three response paths (unified-retriever, unified-recall fallback, conversation-only fallback) now use the same `[mem:anchor · category · scope]` / `[doc:anchor · path]` format the auto-recall hook uses, so the LLM sees one consistent anchor surface across both auto and explicit recall.
- **`memory_forget` tool** (`src/tools.ts`) — `memoryId` parameter now accepts a citation anchor (8 hex chars) or any longer prefix in addition to the full UUID. Ambiguous prefixes return `error: anchor_ambiguous` with the matches list; non-matching prefixes return `error: anchor_not_found`. Tool description updated. Telemetry: `forget` events now include `anchor_prefix`, `anchor_ambiguous`, and `via_anchor` flags.
- **`memory_forget` candidates list** (the "Found N candidates" path) now uses `[mem:abc12345]` to match the canonical anchor format.

### Documentation

- **README** — new "Citation anchors" section explains the format, the LLM-side citation contract, and how `memory_forget` accepts anchor prefixes.
