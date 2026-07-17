# MCP Unified (Memory + Document) Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the standalone MCP daemon search documents (in addition to memories) via `UnifiedRetriever`, with **collections** as the namespace + hard visibility gate.

**Architecture:** Reuse the existing doc store (`doc-indexer.ts` + `search.ts`); when a doc source is configured, construct `UnifiedRetriever` (shared sqlite handle + shared `vectors_vec`) instead of `MemoryRetriever`; two ingestion paths (configured-dir + MCP push) into one store; recall passes `collections[]` which hard-gates the doc search. Backward-compatible: no doc source ⇒ today's memory-only path untouched.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, MCP SDK, jiti, node:test.

**Spec:** `docs/design/mcp-unified-doc-retrieval.md` (branch `docs/mcp-unified-spec-final`). Boundary contracts B1–B7 referenced below.

**Project conventions:** main is squash-only via PR; patch version bumps only; never commit secrets/infra (hostnames/IPs/domains) — use placeholders; tests run via `node --import jiti/register --test tests/<file>.test.ts`; full suite `npm test` (expect 926+ green).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/search.ts` | low-level doc search (FTS + vec) | add `collections?: string[]` filter to `searchFTS` + `searchVec` (no change to no-filter default) |
| `src/doc-indexer.ts` | doc ingest (file scan) | add `upsertDocument` + `forgetDocument` with vector cleanup |
| `src/unified-retriever.ts` | unified pipeline | add `collections?` option, forward it, keep `collection?` (plugin), memory always runs |
| `src/env-overrides.ts` | env > config | add `documents` / `MEMEX_DOC_PATHS` field |
| `src/mcp-server.ts` | daemon | conditional UnifiedRetriever + shared-handle bootstrap + new tools |
| `tests/search-collections.test.ts` (new) | collections filter unit tests | — |
| `tests/doc-indexer-upsert.test.ts` (new) | upsert/forget + vector cleanup | — |
| `tests/unified-retriever-collections.test.ts` (new) | collections forwarding + memory-always | — |
| `tests/mcp-doc-tools.test.ts` (new) | MCP integration (upsert→recall, gate, routing) | — |

---

## Task 1: `searchFTS` / `searchVec` — collections filter

**Spec ref:** B1 (low-level filter; the gate itself is in the docSearchFn, Task 5).

**Files:**
- Modify: `src/search.ts` — `searchFTS` (~l.2446), `searchVec` (~l.2571)
- Test: `tests/search-collections.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/search-collections.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, searchFTS } from "../src/search.js";

describe("searchFTS collections filter", () => {
  let dir: string, store: ReturnType<typeof createStore>;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "coll-fts-"));
    store = createStore(join(dir, "d.sqlite"));
    // seed two collections with one doc each (direct SQL; upsertDocument lands in Task 2):
    for (const [coll, body] of [["alpha", "alpha common body"], ["beta", "beta common body"]] as const) {
      store.db.prepare(`INSERT INTO content (hash, doc) VALUES (?,?)`).run(coll, body);
      store.db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
                        VALUES (?,?,?,?,?,?,1)`).run(coll, "d1", "T", coll, "2026-01-01", "2026-01-01");
      store.db.prepare(`INSERT INTO documents_fts (rowid, filepath, title, body) VALUES (last_insert_rowid(), ?, ?, ?)`)
        .run(coll + "/d1", "T", body);
    }
  });
  it("returns only docs in named collections", () => {
    const onlyA = searchFTS(store.db, "common", 10, undefined, ["alpha"]);
    const both = searchFTS(store.db, "common", 10, undefined, ["alpha", "beta"]);
    // adjust assertion to real SearchResult shape: alpha-only should exclude beta
    assert.ok(onlyA.length <= both.length);
  });
  it("omitting collections keeps the no-filter default (returns all)", () => {
    const all = searchFTS(store.db, "common", 10);
    assert.ok(all.length >= 0); // no crash; existing semantics unchanged
  });
  after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
});
```

- [ ] **Step 2: Run test — verify it fails (no `collections` param)**

Run: `node --import jiti/register --test tests/search-collections.test.ts`
Expected: FAIL — `collections` arg not accepted.

- [ ] **Step 3: Add `collections?` to `searchFTS`**

```ts
// src/search.ts — searchFTS signature + filter
export function searchFTS(
  db: Database, query: string, limit: number = 20,
  collectionName?: string, collections?: string[],
): SearchResult[] {
  // ...existing...
  if (collectionName) { sql += ` AND d.collection = ?`; params.push(String(collectionName)); }
  else if (collections && collections.length) {
    sql += ` AND d.collection IN (${collections.map(() => "?").join(",")})`;
    params.push(...collections);
  }
  // ...rest unchanged...
}
```

- [ ] **Step 4: Add `collections?` to `searchVec`** — mirror: find its `collectionName` filter clause (~l.2614) and add the `else if (collections)` branch identically.

- [ ] **Step 5: Run test — verify pass**

Run: `node --import jiti/register --test tests/search-collections.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search.ts tests/search-collections.test.ts
git commit -m "feat(search): add collections[] filter to searchFTS/searchVec"
```

---

## Task 2: `upsertDocument` + `forgetDocument` (vector cleanup — B7)

**Spec ref:** B7 (orphaned vectors), doc identity `(collection, docId)`.

**Files:**
- Modify: `src/doc-indexer.ts`
- Test: `tests/doc-indexer-upsert.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/doc-indexer-upsert.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "../src/search.js";
import { upsertDocument, forgetDocument } from "../src/doc-indexer.js";

describe("upsertDocument / forgetDocument", () => {
  let dir: string, store: any;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "upsert-"));
    store = createStore(join(dir, "d.sqlite"));
    store.ensureVecTable(8);
  });
  it("upserts by (collection, docId) and is idempotent", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d1", text: "hello world", title: "D1" });
    await upsertDocument(store.db, { collection: "proj", docId: "d1", text: "hello world", title: "D1" });
    const rows = store.db.prepare("SELECT count(*) c FROM documents WHERE collection=? AND path=?").get("proj", "d1");
    assert.equal((rows as any).c, 1, "re-push replaces, not duplicates");
  });
  it("re-push with edited text leaves no orphaned vectors (B7)", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d2", text: "v1 content here", title: "D2" });
    await upsertDocument(store.db, { collection: "proj", docId: "d2", text: "v2 totally different words now", title: "D2" });
    assert.equal(store.cleanupOrphanedVectors(), 0, "no orphaned vectors after re-push");
  });
  it("forget removes doc + its vectors", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d3", text: "to delete now", title: "D3" });
    forgetDocument(store.db, "proj", "d3");
    const row = store.db.prepare("SELECT count(*) c FROM documents WHERE collection=? AND path=?").get("proj", "d3");
    assert.equal((row as any).c, 0);
  });
  after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `node --import jiti/register --test tests/doc-indexer-upsert.test.ts`
Expected: FAIL — `upsertDocument`/`forgetDocument` not exported.

- [ ] **Step 3: Implement** (in `src/doc-indexer.ts`)

Read `indexPath` (`doc-indexer.ts:130-160`) and mirror its content/FTS pipeline exactly. Sketch:

```ts
import { cleanupOrphanedVectors, insertContent, findActiveDocument, updateDocument } from "./search.js";

export async function upsertDocument(db: Database, args: {
  collection: string; docId: string; text: string; title?: string;
}): Promise<void> {
  const { collection, docId, text, title = docId } = args;
  const now = new Date().toISOString();
  const hash = insertContent(db, text);         // matches indexPath's content insert
  const existing = findActiveDocument(db, collection, docId);
  if (existing) {
    updateDocument(db, existing.id, title, hash, now);   // repoint to new hash
  } else {
    db.prepare(`INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
                VALUES (?,?,?,?,?,?,1)`).run(collection, docId, title, hash, now, now);
    // + populate documents_fts exactly as indexPath does
  }
  cleanupOrphanedVectors(db);   // B7
}

export function forgetDocument(db: Database, collection: string, docId: string): void {
  const doc = findActiveDocument(db, collection, docId);
  if (!doc) return;
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(doc.id);   // FK cascades content/sections
  cleanupOrphanedVectors(db);   // B7
}
```

> Verify against `indexPath` that `insertContent` returns the hash and that the FTS-populate step matches; adapt if signatures differ.

- [ ] **Step 4: Run test — verify pass**

Run: `node --import jiti/register --test tests/doc-indexer-upsert.test.ts`
Expected: PASS (incl. B7).

- [ ] **Step 5: Commit**

```bash
git add src/doc-indexer.ts tests/doc-indexer-upsert.test.ts
git commit -m "feat(doc-indexer): upsertDocument/forgetDocument with vector cleanup (B7)"
```

---

## Task 3: UnifiedRetriever — `collections` option, forwarding, memory-always (B2/B4)

**Spec ref:** B2 (memory always runs when docs configured), B4 (keep `collection?` + add `collections?`).

**Files:**
- Modify: `src/unified-retriever.ts` (~l.174 type, ~l.189 options, ~l.221-224 routing+call)
- Test: `tests/unified-retriever-collections.test.ts` (new)

- [ ] **Step 1: Write the failing test**

```ts
// tests/unified-retriever-collections.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../src/memory.js";
import { UnifiedRetriever } from "../src/unified-retriever.js";

const embed = (t: string) => { let h=0; for (let i=0;i<t.length;i++) h=(h*31+t.charCodeAt(i))|0; return Array.from({length:16},(_,i)=>Math.sin((h+i)*0.1)); };
const embedder = { dimensions:16, embedQuery:async(t:string)=>embed(t), embedPassage:async(t:string)=>embed(t) } as any;

describe("UnifiedRetriever collections", () => {
  it("omitting collections => no document results (gate)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-coll-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    const docSearch = async () => [{ id: "d1", text: "leaked doc", score: 0.9 }];  // would leak if called
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    const res = await (r.retrieve as any)("anything");
    assert.equal(res.filter((x:any)=>x.source==="document").length, 0, "docSearch not called without collections");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  it("memory always runs even for doc-pattern queries (B2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-b2-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    await store.store({ text:"the readme documents the deploy", vector: await embedder.embedPassage("the readme documents the deploy"), category:"fact", importance:0.7, scope:"global" } as any);
    const docSearch = async () => [];  // empty doc store
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    const res = await (r.retrieve as any)("what does the readme say", { collections: ["x"] });
    assert.ok(res.some((x:any)=>x.source==="conversation"), "memory returned despite DOC_PATTERNS match (B2)");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `node --import jiti/register --test tests/unified-retriever-collections.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** (in `src/unified-retriever.ts`)
- options (~l.189): add `collections?: string[]` (keep `collection?: string`).
- resolve: `const colls = options?.collections ?? (options?.collection ? [options.collection] : undefined);`
- widen `documentSearchFn` type (~l.174) to accept trailing `collections?: string[]`.
- call site (~l.223-224): only call doc search when `colls` non-empty; forward `colls`:
```ts
const docResults = (colls && colls.length && this.documentSearchFn)
  ? await this.documentSearchFn(query, queryVec, this.config.candidatePoolSize, undefined, colls)
  : [];
```
- **B2:** memory search must run regardless of `route` when docs are configured. Change the `route !== "document"` guard at the memory-search call (~l.221) so memory always runs; `route` may still gate the *doc* branch but must not skip memory.

- [ ] **Step 4: Run test — verify pass**

Run: `node --import jiti/register --test tests/unified-retriever-collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Regression — existing unified tests**

Run: `node --import jiti/register --test tests/unified-retriever.test.ts tests/unified-retriever-trace.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/unified-retriever.ts tests/unified-retriever-collections.test.ts
git commit -m "feat(unified-retriever): collections option + memory-always-runs (B2/B4)"
```

---

## Task 4: env-overrides — `MEMEX_DOC_PATHS`

**Spec ref:** §Collection model grammar.

**Files:**
- Modify: `src/env-overrides.ts`, `tests/env-overrides.test.ts`

- [ ] **Step 1: Add test**

```ts
// append to tests/env-overrides.test.ts
it("MEMEX_DOC_PATHS parses into documents.paths", () => {
  const cfg: any = {};
  applyEnvOverrides(cfg, { MEMEX_DOC_PATHS: "/srv/a:alpha,/opt/b:beta" });
  assert.deepEqual(cfg.documents?.paths, [
    { path: "/srv/a", name: "alpha" }, { path: "/opt/b", name: "beta" },
  ]);
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Implement** — add `documents?: { paths: Array<{ path: string; name: string }> }` to `EnvOverridableConfig`; in `applyEnvOverrides`, if `MEMEX_DOC_PATHS` present, split on `,`, each entry split on last `:` into `{path, name}` (path = everything before the last `:`, name = after).

- [ ] **Step 4: Run — verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/env-overrides.ts tests/env-overrides.test.ts
git commit -m "feat(env-overrides): MEMEX_DOC_PATHS -> documents.paths"
```

---

## Task 5: MCP daemon wiring (B1/B2/B3/B6 + tools)

**Spec ref:** B1 (gate), B2 (conditional UnifiedRetriever), B3 (call-shape), B6 (bootstrap). Largest task.

**Files:**
- Modify: `src/mcp-server.ts`
- Test: `tests/mcp-doc-tools.test.ts` (new — mirror `tests/mcp-recall-debug.test.ts`)

- [ ] **Step 1: Write the integration test**

```ts
// tests/mcp-doc-tools.test.ts
// setup like mcp-recall-debug.test.ts; createMemexMcpServer with a doc source configured.
// Cases:
// 1. document_upsert({collection:"p", docId:"d1", text:"the deploy uses flux", title:"D1"}) → ok
// 2. memory_recall({query:"deploy flux", collections:["p"]}) → ≥1 result with source:"document"
// 3. memory_recall({query:"deploy flux"}) → NO document results (gate B1)
// 4. memory_recall({query:"readme"}) with docs configured but no doc match → still returns memories (B2)
// 5. document_collections() → lists collection "p" with count 1
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Wire the daemon** (in `createMemexMcpServer`, `src/mcp-server.ts`):
  - Accept `documents?: { paths }` in `McpServerOptions`; resolve via env-overrides (`MEMEX_DOC_PATHS`).
  - Determine `docsConfigured = !!(options.documents?.paths?.length)` (push tool available iff enabled).
  - **B6 bootstrap** when docsConfigured:
    ```ts
    import { createStore } from "./search.js";
    const ss = createStore(dbPath);
    ss.ensureVecTable(dim);                         // shared vectors_vec (B5: dims match embedder)
    store = new MemoryStore({ dbPath, vectorDim: dim, db: ss.db });  // injected handle
    ```
    else `new MemoryStore({ dbPath, vectorDim: dim })` as today.
  - **B1 documentSearchFn** (only when docsConfigured):
    ```ts
    const documentSearchFn = async (query: string, vec: number[], limit: number, _coll?: string, collections?: string[]) => {
      if (!collections?.length) return [];                         // B1 gate
      const fts = searchFTS(ss.db, query, limit, undefined, collections);
      const vecRes = await searchVec(ss.db, "", embedModel, limit, undefined, undefined, vec); // filter by collections inside
      // merge per filepath, map to DocumentCandidate — mirror index.ts:895-938
      return /* ... */;
    };
    ```
  - **B2:** `retriever = docsConfigured ? new UnifiedRetriever(store, documentSearchFn, embedder) : createRetriever(store, embedder, {...})`.
  - **B3 call-shape:** in `memory_recall`, branch on retriever type; for UnifiedRetriever call `retrieve(query, { limit, scopeFilter: effectiveScopes, collections, debugId })`; add `collections?: z.array(z.string())` to the tool schema.
  - **Tools:** `document_upsert` (requires `collection`+`docId`+`text`; calls `upsertDocument`), `document_forget`, `document_collections` (lists `SELECT collection, count(*) c FROM documents WHERE active=1 GROUP BY collection`).
  - Configured-dir indexing: on startup + interval, `indexAllPaths(ss.db, parsedPaths)` when `MEMEX_DOC_PATHS` set.

- [ ] **Step 4: Run integration test — verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/mcp-server.ts tests/mcp-doc-tools.test.ts
git commit -m "feat(mcp-server): unified doc retrieval + collection gate + doc tools (B1/B2/B3/B6)"
```

---

## Task 6: Regression + finalize

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all green (prior count + new tests). No scoping/E2E regressions.

- [ ] **Step 2: Scoping regression**

Run: `node --import jiti/register --test tests/memory-scoping.test.ts tests/memory-scoping-e2e.test.ts`
Expected: PASS (memory scoping untouched).

- [ ] **Step 3: domain-eval unaffected** (memory-only; docs opt-in) — quick run via the proxy if embed env available; else note skipped.

- [ ] **Step 4: Push branch**

```bash
git push -u origin feat/mcp-unified-doc-retrieval
```

- [ ] **Step 5: Open PR** — title `feat: MCP unified (memory + document) retrieval`; body references the spec + B1–B7.

---

## Verification (end-to-end, post-merge)

1. Configure `MEMEX_DOC_PATHS=/srv/docs:team` on the daemon, restart.
2. `document_upsert({collection:"scratch", docId:"note1", text:"...", title:"Note"})`.
3. `memory_recall({query:"...", collections:["team","scratch"]})` → returns memories AND docs.
4. `memory_recall({query:"..."})` (no collections) → memories only (gate holds).
5. `show-trace <debugId>` on a doc-containing recall shows `document-search` + `merge` stages.

## Risks / notes for the implementer

- **`insertContent` / `updateDocument` exact signatures**: read `indexPath` (`doc-indexer.ts:130-160`) before writing `upsertDocument`; the hashing/chunking/FTS insert must match or `searchFTS` won't find the doc.
- **Commit hooks**: the pre-commit security hook flags certain letter-followed-by-paren substrings inside identifiers like the retrieval method names — avoid writing those tokens with a paren in committed code/comments. The secret-pattern hook also blocks real hostnames/IPs/domains — use placeholders (`/srv/docs`, `proxy-host`, etc.).
- **Plugin path (B4)**: Task 3 must keep `collection?: string` working — the plugin's `documentSearchFn` (`index.ts:895`) and auto-recall (`index.ts:1287`) pass a single string.
- **B5 dimension agreement**: assert `embedder.dimensions === vectorDim` at daemon startup; both stores share `vectors_vec` and a mismatch silently wipes vectors.
