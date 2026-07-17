# MCP Unified (Memory + Document) Retrieval — Design

**Status:** design (Spec A — scoped) · **Date:** 2026-07-13 · **Updated:** 2026-07-17
**Related:** `recall-quality-design.md`, `mcp-server.md`, `unified-retriever.ts`, `doc-indexer.ts`, `search.ts`

> **Scope of this spec (Spec A):** let the standalone MCP daemon search documents in addition to
> memories, using **collections as the namespace + visibility gate**. This spec deliberately does
> NOT change the scope-tag vocabulary or migrate memories — that is deferred to a separate
> **Spec B (readable scope vocabulary)**, tracked at the bottom.

## Context / Problem

The standalone MCP daemon (`src/mcp-server.ts`) is **memory-only**: `memory_recall` uses
`MemoryRetriever` over the `memories` table. Document search (`src/doc-indexer.ts` + `src/search.ts`)
is wired **only** into the openclaw plugin path (`index.ts` → `documentSearchFn` → `UnifiedRetriever`).

So today: **plugin `memory_recall` = memory + docs (unified); MCP `memory_recall` = memory only.**
A remote client (Claude Code on another machine, via the Tailscale daemon) cannot search documents.

Two doc sources (user decision "both"):
1. **Configured-dir** — a central corpus on the daemon host (env-configured paths), indexed at
   startup + interval via the existing `doc-indexer`.
2. **MCP push** — clients push document text + metadata via a new tool; the daemon chunks, embeds,
   and indexes. Remote-friendly (no shared filesystem).

## Decisions (locked)

- **Collection = namespace + visibility gate (option B).** Every document lives in a
  **client-named collection**. A caller names collection(s) on recall; the search is hard-gated to
  those collections. A caller that doesn't name a collection sees none of its docs. This is the
  isolation mechanism — it sidesteps the any-intersection isolation problem entirely.
- **Push model:** raw text + metadata via MCP tool; idempotent by a client-supplied `docId` within
  the collection. `document_upsert` requires `collection` (no default — prevents accidental
  global pushes).
- **Architecture:** reuse + extend the existing doc store (`doc-indexer` + `search.ts`); swap
  `MemoryRetriever` → `UnifiedRetriever` in `mcp-server.ts`; **backward-compatible** (no docs
  configured/pushed → today's memory-only behavior, `documentSearchFn` returns `[]`).
- **Doc scope tags: none in Spec A.** Collection membership is the sole visibility axis for
  documents. Memories keep using the existing scope-tag system unchanged. This avoids the
  document_scopes table, the migration, and the readable-vocabulary work (all deferred to Spec B).

## Goals

- MCP `memory_recall` returns both memories and documents via `UnifiedRetriever`.
- Two ingestion paths (configured-dir + push) into one document store.
- **Collections** as the namespace + visibility gate; callers name them on recall.
- **Backward-compatible / opt-in:** no docs configured/pushed → today's memory-only behavior.

## Non-goals (deferred to Spec B or rejected)

- Changing the scope-tag vocabulary (readable repo/host/path tags) — **Spec B**.
- Migrating existing `memory_scopes` rows — **Spec B**.
- `document_scopes` table / per-doc scope tags — not needed; collection is the gate.
- Pre-embedded chunk push (rejected — duplicates the pipeline, breaks model agreement).
- A new doc store from scratch (rejected — reuse `doc-indexer`/`search.ts`).

## Collection model

A collection is the unit of document namespace AND visibility.

| Aspect | Rule |
|---|---|
| Identity | `documents.UNIQUE(collection, path)` — `path` = the client `docId` |
| Push | `document_upsert({collection, docId, text, title, ...})` — **collection required** |
| Configured-dir | `MEMEX_DOC_PATHS=/srv/team-docs:shared` → `collection: "shared"` (config-supplied name) |
| Recall | `memory_recall({..., collections: ["my-project", "shared"]})` — **hard gate**: only named collections searched |
| Visibility | A caller that omits `collections` sees **no documents** (memory-only). Naming a collection grants access to all docs in it. |
| Listing | `document_stats` (or a list tool) exposes known collections so both sides can discover them |

Two concrete flows:
- **Isolated push:** a client (agent `main`) pushes to `collection: "memex-design"`. Only callers
  that pass `collections: ["memex-design"]` on recall see those docs.
- **Shared corpus:** `MEMEX_DOC_PATHS=/srv/team-docs:team` → `collection: "team"`. Any caller that
  includes `"team"` in its recall collections sees them.

## Architecture

```
configured dirs ──┐                       ┌─→ documents / documents_fts / document_sections
                  ├─ doc-indexer ─────────┤   (UNIQUE(collection, path) — unchanged schema)
MCP push ─────────┘  (upsert/forget)      └─→ content / content_vectors (shared vectors_vec)

memory_recall({query, scopes, collections}) ──→ UnifiedRetriever
  ├─ memory search   (scopeFilter via memory_scopes — UNCHANGED)
  └─ documentSearchFn(query, vec, limit, collections)  ← NEW param: collections[]
       → searchFTS + searchVec filtered by collection IN (collections)
  → z-calibrate + merge + diversity → results carry source: "conversation" | "document"
```

## Components

| Component | Change |
|---|---|
| `src/search.ts` | extend `searchFTS` (~l.2446) and `searchVec` (~l.2571) to accept `collections?: string[]` (array; the existing single-`collectionName` becomes a special-case of one) — `AND d.collection IN (...)` clause. The single-`collectionName` filter is preserved for the plugin path. |
| `src/doc-indexer.ts` | add `upsertDocument({collection, docId, text, title})` (chunk + embed + upsert by `(collection, docId)`, reusing the existing chunk/embed/content pipeline + `documents_fts` reindex) + `forgetDocument(collection, docId)`. |
| `src/unified-retriever.ts` | widen `documentSearchFn` signature to accept `collections?: string[]`; forward `options?.collections` at the call site (~l.224). (Today `options?.collection` is forwarded as a single string — extend to an array.) |
| `src/mcp-server.ts` | instantiate the doc store (call `initSearchDB` on the same sqlite handle — see DB bootstrap); build `documentSearchFn` (FTS + vec, collection-filtered); construct `UnifiedRetriever(memoryStore, documentSearchFn, embedder)`; route `memory_recall` through it; add `collections?: string[]` to `memory_recall` schema; register `document_upsert` + `document_forget` tools; configured-dir indexing on startup + interval when `MEMEX_DOC_PATHS` set. |
| config / env | `MEMEX_DOC_PATHS` (or plugin `documents.paths`) → collections to index; reuse `src/env-overrides.ts` so env overrides config. |

### DB bootstrap (called out by review)
The daemon opens one sqlite handle at `dbPath` for `MemoryStore` (`mcp-server.ts`). The documents
schema (`documents`, `documents_fts`, `document_sections`, `content`, `content_vectors`) is created
by `search.ts`'s `initSearchDB`, and `vectors_vec` is **shared** between memory + doc vectors. The
daemon must call `initSearchDB` on the **same handle** (or otherwise ensure `vectors_vec` is shared),
once, at startup. When `MEMEX_DOC_PATHS`/push are unconfigured, `initSearchDB` is still safe to call
(empty doc tables); `documentSearchFn` returns `[]`.

## Data flow

- **Push:** client → `document_upsert({collection, docId, text, title})` → chunk + embed →
  `documents`/`content` upsert (replace by `(collection, docId)`) → FTS reindex. Returns a doc
  anchor. `collection` is required.
- **Forget:** `document_forget({collection, docId})` → deletes the row (+ content/sections/vectors
  via existing cascade).
- **Recall:** `memory_recall({query, scopes, collections})` → `UnifiedRetriever.retrieve` →
  memory search (scopeFilter, unchanged) ∥ document search (`searchFTS` + `searchVec`,
  collection-filtered to `collections`; returns `[]` if `collections` omitted) → z-calibrate + merge
  + diversity → results carry `source: "conversation" | "document"`. The recall-debug trace already
  instruments `memory-fusion`, `document-search`, `merge`, `rerank`, `diversity` stages.

## Error handling

- Push/embed failures never break recall (best-effort, swallowed + logged); a failed upsert returns
  an error result, the doc store stays consistent.
- Empty/unconfigured doc store, OR `collections` omitted on recall → `documentSearchFn` returns `[]`
  → memory-only (no behavior change for deployments that don't opt in).
- Embedding-model change → handled by the existing `doc-indexer` re-embed backlog.

## Testing

- **Unit (doc search):** `collections[]` filter on `searchFTS`/`searchVec` (only named collections
  returned; omitted → no docs).
- **Integration (MCP):** `document_upsert` idempotency (re-push same `(collection, docId)` replaces;
  different `docId` adds); `document_forget` removes doc + vectors; `memory_recall` with
  `collections` returns the doc (`source:"document"`); recall WITHOUT `collections` returns no docs;
  configured-dir index surfaces docs in its collection.
- **Regression:** `validate-scoping` loop (scoping tests + full suite + domain-eval — must not move;
  domain-eval is memory-only and unaffected since docs are opt-in).
- **Trace:** a unified recall over docs shows `document-search` + `merge` stages.

## Alternatives considered

- **A — collection is identity-only (no visibility):** cleanest conceptually but discards the
  existing `collectionName` filter that already works in `searchFTS`/`searchVec`; rejected.
- **C — daemon auto-derives collection from caller:** zero client control over grouping; rejected.
- **Per-doc scope tags (document_scopes):** would reintroduce the any-intersection isolation problem
  the review flagged; collection gate makes them unnecessary in Spec A. Deferred.
- **Push-only (no configured-dir):** under-delivers the user's "both."
- **Greenfield scoped doc store:** duplicates `doc-indexer`/`search.ts`; rejected (YAGNI).

---

## Deferred: Spec B — Readable Scope Vocabulary (separate spec, later)

The brainstorm explored making scope tags human-readable (`repo:`, `host:`, `path:`, `subdir:`,
`project:` with stable ids) and migrating `memory_scopes` off the pure-hash `project:<hash>` format.
An adversarial review found this is **harder than it looks** and **orthogonal** to doc retrieval:

- **Migration is partially infeasible:** `metadata.cwd_hash` / `device_id` are SHA-256
  (non-reversible); readable `host:`/`path:` slugs cannot be recovered for legacy memories. Only
  `repo:` (raw git_remote stored) + `project:` are recoverable.
- **Privacy invariant reversal:** readable `host:`/`path:` reverses `scope-derive.ts`'s "raw paths
  never stored" + bypasses the `device:`-tag guard (`memory.ts:443-446`). Needs explicit revocation.
- **Isolation semantics:** under tag any-intersection, sharing facets (`project:`/`host:`/`path:`)
  cannot coexist with `agent:`/`session:` isolation without a two-tier filter rule.

Spec B will address these separately. **Spec A does not depend on Spec B** — docs use collections
(not scope tags) for visibility, so the scope vocabulary is untouched.
