# MCP Unified (Memory + Document) Retrieval — Design

**Status:** design (Spec A — review v2) · **Date:** 2026-07-13 · **Updated:** 2026-07-17
**Related:** `recall-quality-design.md`, `mcp-server.md`, `unified-retriever.ts`, `doc-indexer.ts`, `search.ts`

> **Scope (Spec A):** let the standalone MCP daemon search documents in addition to memories, using
> **collections as the namespace + visibility gate**. Does NOT change the scope-tag vocabulary or
> migrate memories — that is deferred to **Spec B** (bottom).

## Context / Problem

The MCP daemon (`src/mcp-server.ts`) is **memory-only** (`MemoryRetriever`). Document search
(`doc-indexer.ts` + `search.ts`) is wired only into the plugin path (`index.ts` → `UnifiedRetriever`).
So a remote client (Claude Code via the Tailscale daemon) can't search documents.

Two doc sources (decision: "both"):
1. **Configured-dir** — central corpus on the daemon host (env paths), indexed at startup + interval.
2. **MCP push** — clients push text + metadata; daemon chunks/embeds/indexes.

## Decisions (locked)

- **Collection = namespace + visibility gate (option B).** Every doc lives in a client-named
  collection. Recall names collection(s); search is hard-gated to them. Omitting `collections` →
  no documents returned. This sidesteps the any-intersection scope-tag isolation problem.
- **Push:** raw text + metadata; idempotent by client `docId` within the collection. `collection`
  is **required** on `document_upsert` (no default).
- **Doc scope tags: none in Spec A.** Collection membership is the sole doc visibility axis.
- **Backward-compat:** when NO doc source is configured (no `MEMEX_DOC_PATHS`, no push capability
  enabled), the daemon keeps `MemoryRetriever` — `UnifiedRetriever` is only constructed when a doc
  source exists. (See §Routing & backward-compat — addresses review P0-1.)

## Goals

- MCP `memory_recall` returns memories + documents via `UnifiedRetriever` (when docs configured).
- Two ingestion paths into one document store.
- Collections as namespace + hard visibility gate.
- **Zero regression:** memory-only deployments behave exactly as today.

## Non-goals (Spec B or rejected)

- Readable scope vocabulary / `memory_scopes` migration — **Spec B**.
- `document_scopes` / per-doc scope tags — collection is the gate.
- Pre-embedded chunk push; greenfield doc store — rejected.

## Collection model

| Aspect | Rule |
|---|---|
| Identity | `documents.UNIQUE(collection, path)` — `path` = client `docId`; collection name used **verbatim** (no slug normalization — matches `doc-indexer`'s `pathConfig.name`) |
| Push | `document_upsert({collection, docId, text, title})` — `collection` required |
| Configured-dir | `MEMEX_DOC_PATHS` (grammar below) → named collections |
| Recall | `memory_recall({..., collections: ["my-proj", "shared"]})` — hard gate |
| Visibility | Omit `collections` → **no documents** (memory-only results) |
| Discovery | new `document_collections` tool lists known collections (names + counts) |

`MEMEX_DOC_PATHS` grammar: comma-separated `entries`, each `<abs-path>:<collection-name>`; the
`:name` suffix is required (no default). Example: `/srv/team-docs:team,/opt/runbooks:ops`. Paths
containing `:` are not supported (documented limitation; use a symlink if needed).

## Boundary contracts (the hard invariants — review P0/P1 resolutions)

### B1. The collection gate lives at the `documentSearchFn` boundary, NOT in searchFTS/searchVec
`searchFTS`/`searchVec` keep their **existing** no-filter-means-all semantics (the plugin path
depends on it). The hard gate is enforced by `documentSearchFn` (and/or `UnifiedRetriever.retrieve`
before calling it): **if `collections` is omitted/empty → return `[]` without invoking
searchFTS/searchVec.** This is non-negotiable — it's what makes "omit collections → no docs" true.
(P0-2)

### B2. Memory always runs; routing never starves memory
`UnifiedRetriever.routeQuery` can return `"document"` for queries matching `DOC_PATTERNS`
(readme/config/.md/.ts/…), which today **skips memory search**. To prevent a memory-recall
regression when docs are sparse/empty, the daemon-side `UnifiedRetriever` must run memory search
unconditionally (treat route as `"both"` or `"memory"` minimum), OR the daemon only constructs
`UnifiedRetriever` when a doc source is actually configured (so memory-only deployments never hit
`routeQuery`). The spec picks the latter: **no doc source configured ⇒ `MemoryRetriever` (today's
behavior); doc source configured ⇒ `UnifiedRetriever` with memory always searched.** (P0-1)

### B3. Call-shape change at the daemon call site
`MemoryRetriever.retrieve({query, limit, scopes, debugId})` (object) → `UnifiedRetriever.retrieve(query,
{limit, scopeFilter, collections, debugId})` (positional + `scopeFilter` not `scopes`). The daemon's
`memory_recall` handler must map `scopes → scopeFilter` and pass `collections`. (P1-5)

### B4. Plugin path preserved (lockstep widening)
`documentSearchFn` today is `(query, queryVec, limit, collection?: string)`. Widen to
`(query, queryVec, limit, collection?: string, collections?: string[])` — keep the single-string
`collection` param (plugin auto-recall passes `collection: docCollection` at `index.ts:1287`).
`UnifiedRetriever.retrieve` options keep `collection?: string` **and** add `collections?: string[]`;
forwarding at `:224` passes whichever is set. The plugin's `documentSearchFn` accepts both.
`collection` and `collections` are mutually exclusive (if both set, `collections` wins). (P1-6)

### B5. Shared `vectors_vec` requires identical dimensions + shared handle
Both `MemoryStore.ensureVecTable` and the doc store's `ensureVecTableInternal` **drop+rebuild**
`vectors_vec` on dimension mismatch — a disagreement silently wipes the other side's vectors. The
memory and doc embedders **must use identical dimensions** (they share one embedder on the daemon —
assert at startup). Both stores must receive the **same sqlite handle** so the second
`ensureVecTable` is a no-op. (P1-4)

### B6. DB bootstrap uses the real machinery
There is no `initSearchDB`; the doc schema is created by the private `initializeDatabase(db)`
(`search.ts:628`), reachable via `createStore(dbPath)` (`search.ts:952`) which opens its own handle.
The daemon must mirror the plugin's sequence (`index.ts:345-351`):
```
const ss = createStore(dbPath);          // creates doc tables + opens handle
ss.ensureVecTable(dim);                  // shared vectors_vec
const store = new MemoryStore({ dbPath, vectorDim: dim, db: ss.db });  // injected handle
```
`MemoryStore` accepts an injected `db` (`memory.ts:44,175`). When no doc source is configured, the
daemon skips `createStore` and uses `new MemoryStore({ dbPath, vectorDim })` as today. (P1-3)

### B7. Push/forget must clean up vectors (not just content)
`cleanupOrphanedContent` (`search.ts:1259`) only deletes the `content` table — it does NOT touch
`content_vectors` or `vectors_vec` (the existing `cleanupOrphanedVectors` at `search.ts:1271` is
never called in the index path). Re-pushing an edited doc orphans old vectors, which pollute
`searchVec`'s `k = limit*3` nearest-neighbor fetch and degrade ranking. `upsertDocument` and
`forgetDocument` **must** delete old-hash rows from `content_vectors` + `vectors_vec` (invoke
`cleanupOrphanedVectors` or delete explicitly) before/after repointing the document. (P1-7)

## Architecture

```
configured dirs ──┐                       ┌─→ documents / documents_fts / document_sections
                  ├─ doc-indexer ─────────┤   (UNIQUE(collection, path) — unchanged schema)
MCP push ─────────┘  (upsert/forget)      └─→ content / content_vectors / shared vectors_vec

memory_recall({query, scopes, collections}) ──→ UnifiedRetriever.retrieve(query, {scopeFilter, collections})
  ├─ memory search   (scopeFilter via memory_scopes — UNCHANGED, always runs)
  └─ documentSearchFn: if !collections?.length → [] (B1); else searchFTS+searchVec collection-filtered
  → z-calibrate + merge + diversity → results carry source: "conversation" | "document"
```

## Components

| Component | Change |
|---|---|
| `src/search.ts` | add optional `collections?: string[]` to `searchFTS` (`~l.2446`) + `searchVec` (`~l.2571`) → `AND d.collection IN (...)` when present. **No change to no-filter-means-all default** (B1). |
| `src/doc-indexer.ts` | `upsertDocument({collection, docId, text, title})` (chunk+embed+upsert by `(collection,docId)`; **clean old vectors** per B7) + `forgetDocument(collection, docId)` (delete row + content + vectors). |
| `src/unified-retriever.ts` | `retrieve` options: add `collections?: string[]`, keep `collection?: string` (B4); forward per B4 at `:224`. Memory search always runs (B2). |
| `src/mcp-server.ts` | if doc source configured: `createStore`+shared-handle bootstrap (B6); build `documentSearchFn` (gate per B1); construct `UnifiedRetriever`; route `memory_recall` (call-shape B3); add `collections?: string[]` to schema; register `document_upsert`/`document_forget`/`document_collections`. Else: `MemoryRetriever` as today. Configured-dir indexing on startup+interval when `MEMEX_DOC_PATHS` set. |
| `src/env-overrides.ts` | add `documents`/`MEMEX_DOC_PATHS` to `EnvOverridableConfig` (net-new field — not reuse). |

## Data flow

- **Push:** `document_upsert({collection, docId, text, title})` → chunk + embed → upsert
  `(collection, docId)` → **delete old-hash vectors** (B7) → FTS reindex. Returns anchor.
- **Forget:** `document_forget({collection, docId})` → delete row + content + vectors (B7).
- **Recall:** `memory_recall({query, scopes, collections})` → `UnifiedRetriever.retrieve(query,
  {scopeFilter: scopes, collections, limit, debugId})` → memory search (always, scopeFilter) ∥
  document search (gated B1; `[]` if no collections) → merge/diversity → results with
  `source: "conversation"|"document"`. Recall-debug trace covers `memory-fusion`, `document-search`,
  `merge`, `rerank`, `diversity`.

## Error handling

- Push/embed failures never break recall (best-effort, logged); doc store stays consistent.
- No doc source configured ⇒ `MemoryRetriever` (today's behavior, no regression — B2).
- `collections` omitted ⇒ `documentSearchFn` returns `[]` (memory-only) — B1.
- Embedding-model change ⇒ existing re-embed backlog; dimension agreement asserted at startup (B5).

## Testing

- **Unit:** `collections[]` filter on `searchFTS`/`searchVec`; `documentSearchFn` gate (empty → []);
  upsert idempotency + **vector cleanup** (B7 — assert old vectors gone after re-push); forget
  removes vectors; `collection` vs `collections` mutual exclusivity (B4).
- **Integration (MCP):** `document_upsert`→`memory_recall` returns doc (`source:"document"`);
  recall without `collections` returns no docs; **recall with docs configured still returns memories
  for `DOC_PATTERNS` queries** (B2 regression test); configured-dir index surfaces in its collection;
  `document_collections` lists names.
- **Regression:** `validate-scoping` loop (scoping tests + full suite + domain-eval — must not move).
- **Trace:** unified recall shows `document-search` + `merge` stages.

## Alternatives considered

- **A — collection identity-only (no visibility):** discards the working `collectionName` filter.
- **C — daemon auto-derives collection:** no client control.
- **Per-doc scope tags:** reintroduces the any-intersection isolation problem; deferred.
- **Push-only / greenfield store:** rejected.

---

## Deferred: Spec B — Readable Scope Vocabulary (separate spec)

Making scope tags readable (`repo:`/`host:`/`path:`/`subdir:`/`project:`) + migrating `memory_scopes`
off `project:<hash>`. Harder + orthogonal: migration infeasible for hashed host/path (SHA-256
non-reversible); reverses the "raw paths never stored" privacy invariant; sharing facets can't
coexist with agent/session isolation under any-intersection without a two-tier filter. **Spec A does
not depend on Spec B.**
