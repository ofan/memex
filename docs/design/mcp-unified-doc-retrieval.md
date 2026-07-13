# MCP Unified (Memory + Document) Retrieval — Design

**Status:** design (awaiting review) · **Date:** 2026-07-12
**Supersedes:** none · **Related:** `recall-quality-design.md`, `mcp-server.md`, `unified-retriever.ts`

## Context / Problem

The standalone MCP daemon (`src/mcp-server.ts`) is **memory-only**: `memory_recall` uses
`MemoryRetriever` over the `memories` table. Document search (`src/doc-indexer.ts` +
`src/search.ts`, tables `documents` / `documents_fts` / `document_sections`) is wired **only**
into the openclaw plugin path (`index.ts` builds a `documentSearchFn` → `UnifiedRetriever`).

So today: **plugin `memory_recall` = memory + docs (unified); MCP `memory_recall` = memory only.**
A remote client (Claude Code on another machine, via the Tailscale daemon) cannot search
documents at all. We want the MCP path to combine memory AND document search, like the plugin.

Two doc sources, both (user decision "C both"):
1. **Configured-dir** — a central corpus on the daemon host (env-configured paths), indexed at
   startup + interval via the existing `doc-indexer`.
2. **MCP push** — clients push document text + metadata via a new tool; the daemon chunks,
   embeds, and indexes. Remote-friendly (no shared filesystem).

User decisions locked in brainstorm:
- **Push model:** raw text + metadata; idempotent by a client-supplied `docId`.
- **Isolation:** documents are **scope-tagged like memories** — `memory_recall`'s existing
  scope-intersection filter covers both uniformly.

## Goals

- MCP `memory_recall` returns both memories and documents via `UnifiedRetriever`.
- Two ingestion paths (configured-dir + push) into one document store.
- Documents scope-tagged; recall filter is uniform across memories + docs.
- **Backward-compatible / opt-in:** no docs configured/pushed → today's memory-only behavior.

## Non-goals

- Changing the plugin path (already unified).
- Pre-embedded chunk push (rejected — duplicates the pipeline, breaks model agreement).
- A new doc store from scratch (rejected — reuse `doc-indexer`/`search.ts`).
- Auto-discovery of client workspace paths on the daemon (remote; paths are pushed or configured).

## Architecture

The daemon gains an **optional document store** and constructs a `UnifiedRetriever` instead of a
`MemoryRetriever`. When the doc store is empty/unconfigured, `documentSearchFn` returns `[]` and
unified recall degrades to memory-only.

```
configured dirs ──┐                       ┌─→ documents / documents_fts / document_sections
                  ├─ doc-indexer ─────────┤
MCP push ─────────┘  (upsert/forget)      └─→ document_scopes (NEW)

memory_recall ──→ UnifiedRetriever ──┬─→ memory search (scope-intersection)
                                     └─→ documentSearchFn: searchFTS + searchVec (scope-intersection)
                                         → z-calibrate + merge + diversity → results
```

## Decision: document identity + scope model

The `documents` table keys on `UNIQUE(collection, path)`. Push maps:
- client `docId` → `path`
- `collection` → client-supplied namespace (default `push`)

Re-push same `(namespace, docId)` **replaces**; `document_forget` deletes by `(namespace, docId)`.

**Scopes** (the open decision, flagged for review):
- **(a) Simple-namespace:** the client passes `scopes` explicitly on push (default `global`).
  Minimal; relies on clients to scope correctly.
- **(a-alt) Auto-scope-from-caller (RECOMMENDED):** pushed docs are auto-tagged with the caller's
  derived scope (agent/session, via the same `detectClientName`/session the daemon already has),
  UNION the client-supplied scopes. A scope-less push still isolates to the caller — safer on a
  shared daemon (no accidental cross-client leakage). Explicit client scopes extend, never
  restrict, the auto tags (same union semantics as `memoryAgents`).

`document_scopes(document_id, scope)` mirrors `memory_scopes`. `searchFTS`/`searchVec` gain a
`scopeFilter?: string[]` param (tag-intersection).

## Components

| Component | Change |
|---|---|
| `src/search.ts` | add `document_scopes` table + migration; add `scopeFilter?` param to `searchFTS` (line ~2446) and `searchVec` (line ~2571); scope-intersection join |
| `src/doc-indexer.ts` | add `upsertDocument({collection, docId, text, title, scopes})` (chunk + embed + upsert by `(collection,path)`, write scope tags; reuse existing chunk/embed/content pipeline) + `forgetDocument(collection, docId)` |
| `src/mcp-server.ts` | instantiate the doc store; build `documentSearchFn` (FTS + vec, scope-filtered); construct `UnifiedRetriever(memoryStore, documentSearchFn, embedder)`; route `memory_recall` through it; register `document_upsert` + `document_forget` tools; configured-dir indexing on startup + interval when `MEMEX_DOC_PATHS` set |
| config / env | `MEMEX_DOC_PATHS` (or plugin `documents.paths`) → collections to index; reuse `src/env-overrides.ts` so env overrides config |

## Data flow

- **Push:** client → `document_upsert({docId, text, title, scopes?, collection?})` → caller scope
  derived → chunk + embed → `documents`/`content`/`document_scopes` upsert (replace by
  `(collection,docId)`) → FTS reindex. Returns a doc anchor.
- **Recall:** `memory_recall({query, scopes})` → `UnifiedRetriever.retrieve` → memory search
  (scope) ∥ document search (`searchFTS` + `searchVec`, scope) → z-calibrate + merge + diversity
  → results carry `source: "conversation" | "document"`. The recall-debug trace already
  instruments `memory-fusion`, `document-search`, `merge`, `rerank`, `diversity` stages.

## Error handling

- Push/embed failures never break recall (best-effort, swallowed + logged); a failed upsert
  returns an error result, the doc store stays consistent.
- Empty/unconfigured doc store → `documentSearchFn` returns `[]` → memory-only (no behavior
  change for deployments that don't opt in).
- Embedding-model change → handled by the existing `doc-indexer` re-embed backlog.

## Testing

- **Unit:** doc scope-filter (tag-intersection in `searchFTS`/`searchVec`); push idempotency
  (re-push replaces) + replace-on-edit; `forget` removes doc + scopes + vectors.
- **Integration (MCP):** `document_upsert` → `memory_recall` returns the doc
  (`source:"document"`); scope isolation (client A's scoped doc not seen by client B's recall);
  configured-dir index surfaces docs on recall.
- **Regression:** `validate-scoping` loop (scoping tests + full suite + domain-eval unaffected —
  domain-eval is memory-only and must not move).
- **Trace:** a unified recall over docs shows `document-search` + `merge` stages.

## Alternatives considered (from brainstorm)

- **B — push-only, no configured-dir on daemon:** simpler but under-delivers the user's "both."
- **C — greenfield scoped doc store:** duplicates `doc-indexer`/`search.ts`; rejected (YAGNI).

## Open decisions for review

1. Scope model: **(a)** simple-namespace vs **(a-alt)** auto-scope-from-caller (recommended).
2. Default `collection` name for push (`push`) — acceptable?
3. Should `document_forget` also fire when a configured-dir file disappears (already handled by
   `indexAllPaths` stale-collection deactivation) — confirm no double-delete conflict.
