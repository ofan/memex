# MCP Unified (Memory + Document) Retrieval — Design

**Status:** design (resolved) · **Date:** 2026-07-12 · **Updated:** 2026-07-13
**Supersedes:** none · **Related:** `recall-quality-design.md`, `mcp-server.md`, `unified-retriever.ts`, `scope-derive.ts`

## Context / Problem

The standalone MCP daemon (`src/mcp-server.ts`) is **memory-only**: `memory_recall` uses
`MemoryRetriever` over the `memories` table. Document search (`src/doc-indexer.ts` +
`src/search.ts`, tables `documents` / `documents_fts` / `document_sections`) is wired **only**
into the openclaw plugin path (`index.ts` builds a `documentSearchFn` → `UnifiedRetriever`).

So today: **plugin `memory_recall` = memory + docs (unified); MCP `memory_recall` = memory only.**
A remote client (Claude Code on another machine, via the Tailscale daemon) cannot search
documents at all. We want the MCP path to combine memory AND document search, like the plugin.

Two doc sources, both (user decision):
1. **Configured-dir** — a central corpus on the daemon host (env-configured paths), indexed at
   startup + interval via the existing `doc-indexer`.
2. **MCP push** — clients push document text + metadata via a new tool; the daemon chunks,
   embeds, and indexes. Remote-friendly (no shared filesystem).

### Decisions locked during brainstorm

- **Push model:** raw text + metadata via MCP tool; idempotent by a client-supplied `docId`.
- **Doc identity:** `docId → path`, `collection → namespace` (default `push`). `UNIQUE(collection,
  path)` ⇒ repush same id replaces; `document_forget` deletes by `(namespace, docId)`.
- **Architecture:** reuse + extend the existing doc store (`doc-indexer` + `search.ts`), swap
  `MemoryRetriever` → `UnifiedRetriever` in `mcp-server.ts`, backward-compatible (empty doc
  store → memory-only).
- **Scope isolation:** `agent:<id>` and `session:<client>:<id>` are the isolation keys; all other
  tags are sharing/affinity facets under tag-intersection. See §Scope Vocabulary.

## Goals

- MCP `memory_recall` returns both memories and documents via `UnifiedRetriever`.
- Two ingestion paths (configured-dir + push) into one scope-tagged document store.
- One unified scope vocabulary across memories and docs; recall filter is uniform.
- Scope vocabulary is readable (no pure-hash tags; hashes only as disambiguating suffixes where
  needed for collision-safety).
- **Backward-compatible / opt-in:** no docs configured/pushed → today's memory-only behavior.

## Non-goals

- Changing the plugin path (already unified).
- Pre-embedded chunk push (rejected — duplicates the pipeline, breaks model agreement).
- A new doc store from scratch (rejected — reuse `doc-indexer`/`search.ts`).
- Auto-discovery of client workspace paths on the daemon (remote; paths are pushed or configured).

## Scope Vocabulary

All memory + document scope tags use the same readable vocabulary. Tags are **facets**; recall
uses **tag-intersection** (a memory/doc is visible if it shares ≥1 tag with the caller's
`effectiveScopes`). Only `agent:` / `session:` are **isolation keys** (a caller must
pass them explicitly to restrict visibility). All other tags are **sharing facets** (they
broaden visibility under any-intersection).

### Tag set

| Tag | Form | Example | Source |
|---|---|---|---|
| `global` | literal | `global` | always written (memories, configured-dir docs) |
| `project:<id>` | project identity (resolved per §Project-id resolution) | `project:memex` | `deriveScopes` |
| `repo:<forge>-<owner>-<name>` | git remote identity, normalized | `repo:github-ofan-memex` | git remote (when available) |
| `host:<slug>` | hostname slug | `host:dev` | `os.hostname()` |
| `path:<full-abs-slug>` | absolute project path slugified (Claude-style, `/` → `-`) | `path:home-ubuntu-projects-memex` | `cwd` resolved to absolute path |
| `subdir:<slug>` | within-repo subdir (monorepo; only when cwd != git root) | `subdir:packages-ui` | relative path from git root |
| `agent:<id>` | caller-supplied agent id (isolates, opt-in) | `agent:main` | explicit param |
| `session:<client>:<id>` | caller-supplied session id (isolates, opt-in) | `session:claude-code:s7q3k` | explicit param |

Notes:
- `project:` is always derived (cannot be omitted). It is a **sharing facet**, not an isolation key.
- `repo:` / `host:` / `path:` / `subdir:` are derived by `deriveScopes` like today, but emitted as
  **separate readable tags** instead of one hashed `project:<hash>`.
- `agent:` / `session:` are opt-in (only when the caller passes `agent_id`/`session_id`).
- No standalone hashes. The path slug is self-disambiguating (Claude's encoding); `repo:`
  `<forge>-<owner>-<name>` is unique by construction.

### Project-id resolution

The `project:<id>` tag is resolved per:

1. **Explicit** — `MEMEX_PROJECT_ID` env var, or a `.memex/project-id` file at the project root.
2. **Git remote** — normalized `<forge>-<owner>-<name>` (e.g. `github-ofan-memex`).
3. **Directory basename** — non-git projects, same slug as the basename (e.g. `notes`).
4. **Collision auto-suffix** — if steps 1–3 resolve to an id already claimed by a *different*
   project (different path/repo), append a stable suffix: a short hash of the absolute path.
   This keeps the id deterministic-per-host, but makes collided non-git ids path-dependent
   (acknowledged cost — cross-host sharing of non-git projects requires an explicit id).
   
   Detection: at ingestion, check whether the resolved id exists in the pool for a different path.

### Ecosystem alignment

| Ecosystem | Anchor | memex equivalent |
|---|---|---|
| Claude Code (`.claude/projects/<slug>` + `CLAUDE.md` tiers) | absolute path slug + user/project/local | `path:`, `project:`, `repo:` |
| Codex (`AGENTS.md` anchored at git root + nested dirs) | git root + subdirectory | `repo:`, `subdir:` |
| Cursor (`.cursor/rules/*.mdc` globbed by path/type) | project-dir globs | `path:`, `host:` |

([Claude memory docs](https://code.claude.com/docs/en/memory),
[Codex AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md),
[Claude project-dir naming issue #24789](https://github.com/anthropics/claude-code/issues/24789))

### Document scope model

| Source | Default tags | Isolation? |
|---|---|---|
| **MCP push** | client `scopes` (best-effort) **∪** server-auto `{agent:<caller>, session:<client>:<id>}` **∪** derived project/repo/host/path facets | isolated by default via `agent:`/`session:` (no `global` unless client passes it explicitly) |
| **Configured-dir** | `global`, `collection:<name>`, derived project/host/path facets | shared corpus (global default) |

Push callers can pass `scopes: ["global"]` to opt-in to sharing. Configured-dir docs always have
`global` (they're the shared corpus).

## Memory scope migration

Existing `memory_scopes` rows use the old pure-hash `project:<hash>` format. A one-time
migration rewrites them to the new readable vocabulary:

1. For each memory with a `project:<hash>` tag, re-derive the tag set from the memory's stored
   `metadata` (which includes `git_remote`, `project_name`, `cwd_hash`, `device_id`).
2. Replace old tags with: `project:<resolved-id>`, `repo:<forge>-<owner>-<name>` (if git),
   `host:<slug>`, `path:<slug>`, `global`.
3. If `metadata` is too stale to re-derive (ancient entries, before `metadata` was populated),
   preserve the old tag as-is with a `legacy:` prefix (e.g. `legacy:9f2cfdf1`).
4. The old `scope` column on `memories` (single-valued, deprecated) is **not** migrated — it
   stays as a fallback for code that hasn't transitioned to `memory_scopes`.

Tested via a migration dry-run that validates every memory gets at least `global` + `project:`
tags, and no memory with git metadata loses its `repo:` tag.

## Architecture

```
configured dirs ──┐                       ┌─→ documents / documents_fts / document_sections
                  ├─ doc-indexer ─────────┤
MCP push ─────────┘  (upsert/forget)      └─→ document_scopes (NEW)

memory_recall ──→ UnifiedRetriever ──┬─→ memory search (scope-intersection via memory_scopes)
                                     └─→ documentSearchFn: searchFTS + searchVec (scope-intersection via document_scopes)
                                         → z-calibrate + merge + diversity → results
```

## Components

| Component | Change |
|---|---|
| `src/search.ts` | add `document_scopes(document_id, scope)` table + migration; extend `searchFTS` (line ~2446) and `searchVec` (line ~2571) with `scopeFilter?: string[]` param (tag-intersection join) |
| `src/scope-derive.ts` | emit separate readable tags (repo, host, path, subdir) instead of one hashed `project:`; implement project-id resolution precedence (explicit → git → basename → collision-suffix) |
| `src/memory.ts` | migration: rewrite `memory_scopes` rows from old `project:<hash>` to new readable tags; add `legacy:` prefix for unresolvable stale entries |
| `src/doc-indexer.ts` | add `upsertDocument({collection, docId, text, title, scopes})` (chunk + embed + upsert by `(collection,path)`, write scope tags; reuse existing chunk/embed/content pipeline) + `forgetDocument(collection, docId)` |
| `src/mcp-server.ts` | instantiate the doc store; build `documentSearchFn` (FTS + vec, scope-filtered); construct `UnifiedRetriever(memoryStore, documentSearchFn, embedder)`; route `memory_recall` through it; register `document_upsert` + `document_forget` tools; configured-dir indexing on startup + interval when `MEMEX_DOC_PATHS` set |
| config / env | `MEMEX_DOC_PATHS` (or plugin `documents.paths`) → collections to index; reuse `src/env-overrides.ts` so env overrides config |

## Data flow

- **Push:** client → `document_upsert({docId, text, title, scopes?, collection?})` → caller
  scope derived (server-auto `agent:`, `session:`, `project:`, `repo:`, `host:`, `path:`) ∪
  client `scopes` → chunk + embed → `documents`/`content`/`document_scopes` upsert (replace
  by `(collection, docId)`) → FTS reindex. Returns a doc anchor.
- **Recall:** `memory_recall({query, scopes})` → `UnifiedRetriever.retrieve` → memory search
  (scope-intersection via `memory_scopes`) ∥ document search (`searchFTS` + `searchVec`,
  scope-intersection via `document_scopes`) → z-calibrate + merge + diversity → results
  carry `source: "conversation" | "document"`. The recall-debug trace already instruments
  `memory-fusion`, `document-search`, `merge`, `rerank`, `diversity` stages.

## Error handling

- Push/embed failures never break recall (best-effort, swallowed + logged); a failed upsert
  returns an error result, the doc store stays consistent.
- Empty/unconfigured doc store → `documentSearchFn` returns `[]` → memory-only (no behavior
  change for deployments that don't opt in).
- Embedding-model change → handled by the existing `doc-indexer` re-embed backlog.
- Scope migration failures (stale metadata) → fall back to `legacy:<hash>`; memory remains
  searchable.

## Testing

- **Unit (scope vocabulary):** `deriveScopes` emits readable tags; project-id resolution
  precedence (explicit > git > basename); collision detection + suffix.
- **Unit (memory migration):** old `project:<hash>` → new tag set; stale metadata → `legacy:`
  fallback; every migrated memory has at least `global` + `project:`.
- **Unit (doc search):** scope-filter on `searchFTS`/`searchVec` (tag-intersection join).
- **Integration (MCP):** `document_upsert` + push idempotency (re-push replaces, forget removes
  scopes + vectors); `memory_recall` returns the doc (`source:"document"`); isolation (client A's
  scoped doc not seen by client B); configured-dir index surfaces docs.
- **Regression:** `validate-scoping` loop (scoping tests + full suite + domain-eval — must not move).

## Alternatives considered (from brainstorm)

- **B — push-only, no configured-dir on daemon:** simpler but under-delivers the user's "both."
- **C — greenfield scoped doc store:** duplicates `doc-indexer`/`search.ts`; rejected (YAGNI).
