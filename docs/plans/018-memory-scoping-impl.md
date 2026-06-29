# Memory Scoping — Implementation Plan (Problem 2)

**Spec:** `docs/design/memory-scoping.md` (read first — the locked design)
**Branch:** `feat/memory-scoping` (off `memex-v0.7`)
**Method:** TDD — failing test → implement → verify → commit per phase.

## Goal
Multi-valued scope **tags**, server-authoritative derivation, tag-intersection recall, scope-aware dreaming. Design doc stays design-only; all code in `src/` + `tests/`.

## Conventions
- Test (full): `node --import jiti/register --test tests/*.test.ts`
- Test (one): `node --import jiti/register --test tests/<file>.test.ts`
- Domain eval: `node --import jiti/register --test tests/domain-eval.ts`
- No `console.log` (use `console.warn` for stderr — stdio protocol).
- jiti loads `.ts` directly (no build for tests). Imports use `.js` extensions.
- sqlite-vec via `loadSqliteVec` from `src/db.ts`; better-sqlite3.
- Commit per phase; end each commit message with `Generated with Claude Code`.

## Phases (TDD each; commit per phase)

### P1 — Data model: `memory_scopes` table
- `MemoryStore` init creates `memory_scopes(memory_id TEXT, scope TEXT, PRIMARY KEY(memory_id, scope))` + index on `scope`.
- Migration: backfill one `global` tag per existing memory (all 413 are global today).
- `memory_scopes` is the source of truth for scope. (The old `memories.scope` column can remain but is no longer authoritative.)
- Tests: table exists; migration backfills `global` for existing; store writes tag rows.

### P2 — Scope derivation (server-authoritative): `src/scope-derive.ts`
- `deriveScopes({ cwd, env, clientName, sessionId, explicit }) → { tags: string[], metadata }`.
- **Auto tags** (always): `global` + `project:<hash>`.
  - project: `env.CLAUDE_PROJECT_DIR` else `cwd` → walk to `.git` → **`git_remote` (normalized) hash** is primary; local-path hash fallback; cwd-hash fallback; if no signal, omit project (global still set).
  - `git_remote` normalization: strip `.git`, SSH→HTTPS form, lowercase host.
  - hash = `sha256(value)[0:16]`.
- **Opt-in tags** (only when explicitly specific): `client:<name>`, `agent:<name>`, `session:<sha256(client)[0:8]:id>`.
- **device** → `metadata.device_id = device:<sha256(hostname+HOME)[0:12]>` — metadata ONLY, never a tag.
- Metadata also: `project_root` (hash), `cwd_hash`, `git_branch`, `git_remote` (normalized), `client`, `captured_at`. **Raw paths never stored — hashes only.**
- Tests: git repo → `project:<git_remote-hash>`; non-git → path/cwd hash; `CLAUDE_PROJECT_DIR` fast-path; no signal → `global` only; normalization; hashing; device in metadata not tags.

### P3 — Store path
- `memory_store` (mcp-server) + `MemoryStore.store`: derive tags via `deriveScopes` (stdio has cwd/env/clientInfo). Write tags to `memory_scopes`. Capture provenance metadata.
- Accept optional explicit params (`scope`, `agent_id`, `session_id`, `device_id`) from client; merge with derived (explicit wins for those dimensions).
- **Reject `device:` as a tag** (metadata-only); validate tag format.
- Tests: store derives `{global, project}`; explicit client/agent/session tags; metadata captured + paths hashed; `device:` rejected.

### P4 — Recall (tag intersection)
- Build active-context tag set: `{global, current project, [current client], [current session], [current agent]}`.
- Filter: a memory matches if `EXISTS` a `memory_scopes` row with `scope` in the active set.
- `memory_recall` accepts optional `scopes` override.
- Tests: no cross-project leak; `global` surfaces; client/session/agent filtering; sparse (memory with no `client` tag surfaces in all clients).

### P5 — Dreaming scope-aware (`src/dreaming.ts`)
- Dedup key: `(text, scope-set)` — identical text under different tag-sets is NOT a dupe.
- Reflection learnings inherit tags: single-context batch → those tags; mixed batch → `global`.
- Tests: dedup respects scope; reflection tag-inheriting.

### P6 — MCP tool surface + daemon authority
- `memory_store` / `memory_recall` tool schemas: add optional `scope`/`agent_id`/`session_id`/`device_id`/`scopes` params.
- Daemon validates/canonicalizes tags on store (reject malformed, canonicalize `git_remote`, re-derive when able).
- Tests: tool params wired; validation rejects bad input.

### P7 — E2E (sufficient, not 100%)
- New `tests/memory-scoping-e2e.test.ts`: integration through `MemoryStore` + retriever (or MCP via `InMemoryTransport`). Store memories under several contexts (projects A/B, clients, sessions); recall from each; assert: no cross-project leak, `global` surfaces, client/session filtering, sparse behavior, dreaming stays in-scope.
- Run **full suite** + **domain-eval**. Existing tests must stay green; domain-eval must not regress.

### P8 — Sync
- If implementation legitimately diverged, update `docs/design/memory-scoping.md` (keep design-only — no code blocks).
- Update `docs/plans/PROGRESS.md` with the outcome.

## Done when
- Full suite green (existing 742 + new tests).
- domain-eval passes (no regression).
- E2E proves scoping behavior.
- All committed on `feat/memory-scoping`.

## Report back
Phases completed · test counts before/after · domain-eval result · deviations from the design · anything blocked.
