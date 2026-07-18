# MCP Unified (Memory + Document) Retrieval — Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the standalone MCP daemon search documents (in addition to memories) via `UnifiedRetriever`, with **collections** as the namespace + hard visibility gate.

**Architecture:** Reuse the existing doc store (`doc-indexer.ts` + `search.ts`); when a doc source is configured, construct `UnifiedRetriever` (shared sqlite handle + shared `vectors_vec`) instead of `MemoryRetriever`; two ingestion paths (configured-dir + MCP push) into one store; recall passes `collections[]` which hard-gates the doc search. Backward-compatible: no doc source ⇒ today's memory-only path untouched.

**Tech Stack:** TypeScript, better-sqlite3, sqlite-vec, MCP SDK, jiti, node:test.

**Spec:** `docs/design/mcp-unified-doc-retrieval.md`. Boundary contracts B1–B7 referenced below.

> **⚠️ Amendment — collection visibility (supersedes the "omit → no docs" wording in Tasks 1/3/5 below).**
> Collections have **visibility** (`public` | `private`) in a new `document_collections(name, visibility, source, created_at)` table.
> - **Omit `collections` on recall → resolve to all `public` collections** (`SELECT name FROM document_collections WHERE visibility='public'`), not `[]`. Only if that set is also empty do we return no docs.
> - **Name `collections` → search exactly those** (public OR private).
> - **The gate moves INTO the daemon's `documentSearchFn`** (Task 5), which does the public-resolution. **UnifiedRetriever (Task 3) just forwards `collections` as-is** (undefined when omitted, or the named list) — it no longer skips the docSearch call. Update Task 3's gate test accordingly: omit → `documentSearchFn` IS called with `collections=undefined`; named → called with the list.
> - `document_upsert` gains `public?: boolean` (default false → private); configured-dir collections are `public`. `document_upsert`/`indexAllPaths` upsert a `document_collections` row. `document_collections` tool lists name+visibility+count.
> - No ACL yet — schema is shaped so a nullable `owner` column + `OR owner=?` clause add hard ACL later.


**Project conventions:** main is squash-only via PR; patch version bumps only; never commit secrets/infra — use placeholders; tests via `node --import jiti/register --test tests/<file>.test.ts`; full suite `npm test`.

**Key helper signatures (verified against code — use these exactly):**
- `hashContent(content: string): Promise<string>` — async, returns the content hash (`search.ts:1325`)
- `insertContent(db, hash, content, createdAt): void` — stores content row (`search.ts:1371`)
- `insertDocument(db, collection, path, title, hash, createdAt, modifiedAt): void` — **upsert** (`ON CONFLICT DO UPDATE`) + populates section-FTS (`search.ts:1379`)
- `removeSectionsFTS(db, documentId): void` (`search.ts:1515`)
- `insertEmbedding(db, hash, seq, pos, embedding: Float32Array, model, embeddedAt): void` — writes both `vectors_vec` + `content_vectors` (`search.ts:2703`)
- `cleanupOrphanedVectors(db): number` (`search.ts:1271`) — exposed on the Store object as `store.cleanupOrphanedVectors()`
- `embedDocuments(db, dim, embedder)` (`doc-indexer.ts:235`) — embeds the backlog after `indexAllPaths`
- `createStore(dbPath)` → `{ db, ensureVecTable(dim), cleanupOrphanedVectors(), … }` (`search.ts:952`)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/search.ts` | low-level doc search | add `collections?: string[]` filter to `searchFTS` (two branches: whole-doc `:2467` + section `:2524`) and `searchVec` (`:2615`) |
| `src/doc-indexer.ts` | doc ingest | add `upsertDocument` (async) + `forgetDocument` with vector cleanup |
| `src/unified-retriever.ts` | unified pipeline | add `collections?` option, forward it, keep `collection?`, memory always runs |
| `src/env-overrides.ts` | env > config | add `documents` / `MEMEX_DOC_PATHS` |
| `src/mcp-server.ts` | daemon | conditional UnifiedRetriever + shared-handle bootstrap + dimension assert + doc tools |
| `tests/search-collections.test.ts` (new) | collections filter | — |
| `tests/doc-indexer-upsert.test.ts` (new) | upsert/forget + B7 vector cleanup | — |
| `tests/unified-retriever-collections.test.ts` (new) | collections forwarding + memory-always + B4 | — |
| `tests/mcp-doc-tools.test.ts` (new) | MCP integration (gate, routing, tools, B5) | — |

---

## Task 1: `searchFTS` / `searchVec` — collections filter (3 filter sites)

**Spec ref:** B1 (low-level filter only; the gate is the docSearchFn, Task 5).

**Files:**
- Modify: `src/search.ts` — three filter sites: `searchFTS` whole-doc (`:2467`), `searchFTS` section (`:2524`), `searchVec` (`:2615`)
- Test: `tests/search-collections.test.ts` (new)

- [ ] **Step 1: Write the failing test** (seed via the canonical helpers, not raw INSERT — avoids the `documents_ai` trigger collision)

```ts
// tests/search-collections.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, searchFTS, insertContent, insertDocument } from "../src/search.js";

describe("searchFTS collections filter", () => {
  let dir: string, store: ReturnType<typeof createStore>;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "coll-fts-"));
    store = createStore(join(dir, "d.sqlite"));
    const now = new Date().toISOString();
    for (const [coll, body] of [["alpha", "deploy flux common"], ["beta", "deploy helm common"]] as const) {
      insertContent(store.db, coll + "-h", body, now);              // content row
      insertDocument(store.db, coll, "d1", "T", coll + "-h", now, now); // doc + section-FTS
    }
  });
  it("returns only docs in named collections", () => {
    const onlyA = searchFTS(store.db, "deploy common", 10, undefined, ["alpha"]);
    const onlyB = searchFTS(store.db, "deploy common", 10, undefined, ["beta"]);
    const both = searchFTS(store.db, "deploy common", 10, undefined, ["alpha", "beta"]);
    assert.ok(onlyA.length > 0 && onlyB.length > 0, "both collections have hits");
    assert.equal(both.length, onlyA.length + onlyB.length, "both = sum");
    // collection isolation: every alpha-only hit's filepath starts with qmd://alpha/
    assert.ok(onlyA.every((r: any) => r.filepath.includes("/alpha/")));
    assert.ok(onlyB.every((r: any) => !r.filepath.includes("/alpha/")));
  });
  it("omitting collections keeps the no-filter default (returns all)", () => {
    const all = searchFTS(store.db, "deploy common", 10);
    assert.ok(all.length >= 2);
  });
  after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `node --import jiti/register --test tests/search-collections.test.ts`
Expected: FAIL — `collections` arg not accepted.

- [ ] **Step 3: Add `collections?` to BOTH `searchFTS` filter sites + `searchVec`**

Add the param to `searchFTS` signature, then at each filter site apply the same pattern:
```ts
// at :2467 (whole-doc) AND :2524 (section) — identical branch:
if (collectionName) { /* existing single-collection filter */ }
else if (collections && collections.length) {
  const ph = collections.map(() => "?").join(",");
  sql += ` AND d.collection IN (${ph})`;        // use the right sql var name per branch
  params.push(...collections);
}
```
Do the same at `searchVec`'s filter (`:2615`). **All three sites must be patched** or section/vector results leak across collections.

- [ ] **Step 4: Run test — verify pass**

Run: `node --import jiti/register --test tests/search-collections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/search.ts tests/search-collections.test.ts
git commit -m "feat(search): add collections[] filter to searchFTS (whole-doc+section) and searchVec"
```

---

## Task 2: `upsertDocument` + `forgetDocument` (B7 — real vector cleanup)

**Spec ref:** B7, doc identity `(collection, docId)`.

**Files:**
- Modify: `src/doc-indexer.ts`
- Test: `tests/doc-indexer-upsert.test.ts` (new)

- [ ] **Step 1: Write the failing test** (seeds real embeddings so B7 is actually exercised)

```ts
// tests/doc-indexer-upsert.test.ts
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, insertEmbedding } from "../src/search.js";
import { upsertDocument, forgetDocument } from "../src/doc-indexer.js";

const vec = (n: number) => { const v = new Float32Array(8); for (let i=0;i<8;i++) v[i] = Math.sin(n+i); return v; };

describe("upsertDocument / forgetDocument (B7)", () => {
  let dir: string, store: any;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "upsert-"));
    store = createStore(join(dir, "d.sqlite"));
    store.ensureVecTable(8);
  });
  it("upserts by (collection, docId), idempotent, via insertDocument upsert", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d1", text: "hello world foo", title: "D1" });
    await upsertDocument(store.db, { collection: "proj", docId: "d1", text: "hello world foo", title: "D1" });
    const c = (store.db.prepare("SELECT count(*) c FROM documents WHERE collection=? AND path=?").get("proj", "d1") as any).c;
    assert.equal(c, 1, "re-push replaces via ON CONFLICT, not duplicates");
  });
  it("re-push with edited text removes OLD-hash vectors (B7 real)", async () => {
    // v1 upsert + seed its embedding under v1's hash
    await upsertDocument(store.db, { collection: "proj", docId: "d2", text: "version one content here", title: "D2" });
    const v1Hash = (store.db.prepare("SELECT hash FROM documents WHERE collection=? AND path=?").get("proj", "d2") as any).hash;
    insertEmbedding(store.db, v1Hash, 0, 0, vec(1), "test", new Date().toISOString());
    assert.equal((store.db.prepare("SELECT count(*) c FROM content_vectors WHERE hash=?").get(v1Hash) as any).c, 1, "v1 vector seeded");
    // re-push with different text → new hash
    await upsertDocument(store.db, { collection: "proj", docId: "d2", text: "version two totally different words", title: "D2" });
    // B7: the OLD hash's vectors must be gone (cleanupOrphanedVectors ran inside upsert)
    const leftover = (store.db.prepare("SELECT count(*) c FROM content_vectors WHERE hash=?").get(v1Hash) as any).c;
    assert.equal(leftover, 0, "old-hash content_vectors removed (B7)");
    const leftoverVec = (store.db.prepare("SELECT count(*) c FROM vectors_vec WHERE hash_seq LIKE ?").get(v1Hash + "_%") as any).c;
    assert.equal(leftoverVec, 0, "old-hash vectors_vec removed (B7)");
  });
  it("forget removes doc + sections + vectors", async () => {
    await upsertDocument(store.db, { collection: "proj", docId: "d3", text: "to be deleted now", title: "D3" });
    forgetDocument(store.db, "proj", "d3");
    const c = (store.db.prepare("SELECT count(*) c FROM documents WHERE collection=? AND path=?").get("proj", "d3") as any).c;
    assert.equal(c, 0);
  });
  after(async () => { store.db.close(); await rm(dir, { recursive: true, force: true }); });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `node --import jiti/register --test tests/doc-indexer-upsert.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement** (`src/doc-indexer.ts`) — use the verified helpers:

```ts
import { hashContent, insertContent, insertDocument, findActiveDocument,
         removeSectionsFTS, cleanupOrphanedVectors } from "./search.js";

export async function upsertDocument(db: Database, args: {
  collection: string; docId: string; text: string; title?: string;
}): Promise<void> {
  const { collection, docId, text, title = docId } = args;
  const now = new Date().toISOString();
  const hash = await hashContent(text);          // async hash
  insertContent(db, hash, text, now);            // content row (hash is INPUT)
  insertDocument(db, collection, docId, title, hash, now, now);  // upsert + section-FTS
  cleanupOrphanedVectors(db);                    // B7: drop vectors for orphaned old hashes
}

export function forgetDocument(db: Database, collection: string, docId: string): void {
  const doc = findActiveDocument(db, collection, docId);
  if (!doc) return;
  removeSectionsFTS(db, doc.id);                 // section-FTS is JS-managed, not cascaded
  db.prepare(`DELETE FROM documents WHERE id = ?`).run(doc.id);  // content/sections cascade via FK
  cleanupOrphanedVectors(db);                    // B7
}
```

> `insertDocument` already does `ON CONFLICT(collection,path) DO UPDATE` + `populateSectionsFTS`, so no manual findActiveDocument/branch needed — one call handles insert+replace+section-FTS.

- [ ] **Step 4: Run test — verify pass (incl. the real B7 assertions)**

Run: `node --import jiti/register --test tests/doc-indexer-upsert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/doc-indexer.ts tests/doc-indexer-upsert.test.ts
git commit -m "feat(doc-indexer): upsertDocument/forgetDocument with vector cleanup (B7)"
```

---

## Task 3: UnifiedRetriever — collections option, forwarding, memory-always (B2/B4)

**Spec ref:** B2 (memory always runs), B4 (keep `collection?` + add `collections?`; `collections` wins).

**Files:**
- Modify: `src/unified-retriever.ts` (`:174` type, `:189` options, `:220-224` routing+call)
- Test: `tests/unified-retriever-collections.test.ts` (new)

- [ ] **Step 1: Write the failing test** (uses a spy to prove the gate; covers B4 precedence)

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

describe("UnifiedRetriever collections (B2/B4)", () => {
  it("omitting collections => documentSearchFn NOT called (gate, via spy)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-gate-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    let calls = 0;
    const docSearch = async () => { calls++; return [{ id:"d1", text:"leak", score:0.9 }]; };
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    await (r.retrieve as any)("anything");
    assert.equal(calls, 0, "documentSearchFn must not be called when collections omitted");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  it("memory always runs for DOC_PATTERNS queries even with empty doc store (B2)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-b2-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    await store.store({ text:"the readme documents the deploy step", vector: await embedder.embedPassage("the readme documents the deploy step"), category:"fact", importance:0.7, scope:"global" } as any);
    const r = new UnifiedRetriever(store, (async()=>[]) as any, embedder);
    const res = await (r.retrieve as any)("what does the readme say", { collections: ["x"] });
    assert.ok(res.some((x:any)=>x.source==="conversation"), "memory returned despite DOC_PATTERNS (B2)");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
  it("B4: when both collection and collections set, collections wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ur-b4-"));
    const store = new MemoryStore({ dbPath: join(dir, "m.sqlite"), vectorDim: 16 });
    let received: any;
    const docSearch = async (_q:string,_v:number[],_l:number,_c?:string, colls?:string[]) => { received = colls; return []; };
    const r = new UnifiedRetriever(store, docSearch as any, embedder);
    await (r.retrieve as any)("q", { collection: "single", collections: ["a","b"] });
    assert.deepEqual(received, ["a","b"], "collections takes precedence over collection (B4)");
    store.close(); await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

- [ ] **Step 3: Implement** (`src/unified-retriever.ts`)
- options (`:189`): add `collections?: string[]` (keep `collection?: string`).
- widen `documentSearchFn` type (`:174`) to accept trailing `collections?: string[]`.
- resolve + forward:
```ts
const colls = options?.collections ?? (options?.collection ? [options.collection] : undefined);
// at the doc-search call (:223-224):
const docResults = (colls && colls.length && this.documentSearchFn)
  ? await this.documentSearchFn(query, queryVec, this.config.candidatePoolSize, undefined, colls)
  : [];
```
- **B2:** the memory-search call (`:221`, currently guarded `route !== "document"`) must ALWAYS run. Remove the `route !== "document"` guard on memory search; `route` may only gate the doc branch (already gated by `colls` above).

- [ ] **Step 4: Run test — verify pass**

- [ ] **Step 5: Regression — existing unified tests**

Run: `node --import jiti/register --test tests/unified-retriever.test.ts tests/unified-retriever-trace.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/unified-retriever.ts tests/unified-retriever-collections.test.ts
git commit -m "feat(unified-retriever): collections option + memory-always (B2/B4)"
```

> **Plugin path (B4):** the daemon-side change is sufficient for Spec A. The plugin's `documentSearchFn` (`index.ts:895`) keeps its 4-param signature and passes a single `collection` string positionally — it continues to work because `UnifiedRetriever` resolves `collection → [collection]` when `collections` is absent. No `index.ts` change required for Spec A (documented as "daemon-only" in the spec's B4).

---

## Task 4: env-overrides — `MEMEX_DOC_PATHS`

**Files:** `src/env-overrides.ts`, `tests/env-overrides.test.ts`

- [ ] **Step 1: Add tests**

```ts
// append to tests/env-overrides.test.ts
it("MEMEX_DOC_PATHS parses comma-separated path:name entries", () => {
  const cfg: any = {};
  applyEnvOverrides(cfg, { MEMEX_DOC_PATHS: "/srv/a:alpha,/opt/b:beta" });
  assert.deepEqual(cfg.documents?.paths, [{ path:"/srv/a", name:"alpha" }, { path:"/opt/b", name:"beta" }]);
});
it("MEMEX_DOC_PATHS splits on the LAST colon (paths may contain colons are unsupported; documented)", () => {
  const cfg: any = {};
  applyEnvOverrides(cfg, { MEMEX_DOC_PATHS: "/foo:bar:baz" });
  assert.deepEqual(cfg.documents?.paths, [{ path:"/foo:bar", name:"baz" }]);
});
```

- [ ] **Step 2: Run — verify FAIL**

- [ ] **Step 3: Implement** — add `documents?: { paths: Array<{ path: string; name: string }> }` to `EnvOverridableConfig`; in `applyEnvOverrides`, if `MEMEX_DOC_PATHS` present: split on `,`, each entry split on **last** `:` → `{ path: before, name: after }`.

- [ ] **Step 4: Run — verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/env-overrides.ts tests/env-overrides.test.ts
git commit -m "feat(env-overrides): MEMEX_DOC_PATHS -> documents.paths"
```

---

## Task 5: MCP daemon wiring (B1/B2/B3/B5/B6 + tools)

**Spec ref:** B1 (gate), B2 (conditional UnifiedRetriever), B3 (call-shape), B5 (dim assert), B6 (bootstrap).

**Files:** `src/mcp-server.ts`, `tests/mcp-doc-tools.test.ts` (new)

- [ ] **Step 1: Write the integration test** (mirror `tests/mcp-recall-debug.test.ts` setup)

```ts
// tests/mcp-doc-tools.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemexMcpServer } from "../src/mcp-server.js";

const embed = (t:string) => { let h=0; for(let i=0;i<t.length;i++) h=(h*31+t.charCodeAt(i))|0; const v=Array.from({length:16},(_,i)=>Math.sin((h+i)*0.1)); const n=Math.sqrt(v.reduce((s,x)=>s+x*x,0)); return v.map(x=>x/(n||1)); };
const embedder = { dimensions:16, embedQuery:async(t:string)=>embed(t), embedPassage:async(t:string)=>embed(t), embed:async(t:string)=>embed(t), embedBatch:async(ts:string[])=>ts.map(embed), embedBatchQuery:async(ts:string[])=>ts.map(embed), embedBatchPassage:async(ts:string[])=>ts.map(embed) } as any;

async function setup(docSource = true) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-doc-"));
  const { server } = createMemexMcpServer({
    dbPath: join(dir, "m.sqlite"), vectorDim: 16, embedder, noDream: true,
    documents: docSource ? { paths: [] } : undefined,   // enables doc tools when present
  });
  const client = new Client({ name:"t", version:"1" });
  const [c,s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return { dir, client, close: async () => { await client.close(); await server.close(); await rm(dir,{recursive:true,force:true}); } };
}

describe("MCP doc tools + unified recall", () => {
  it("upsert → recall with collections returns the doc; without collections returns none (B1)", async () => {
    const { client, close } = await setup();
    await client.callTool({ name:"document_upsert", arguments:{ collection:"p", docId:"d1", text:"the deploy uses flux and kustomize", title:"D1" } });
    const withColl = await client.callTool({ name:"memory_recall", arguments:{ query:"deploy flux", collections:["p"], limit:5 } });
    const withParsed = JSON.parse((withColl.content as any)[0].text);
    assert.ok(withParsed.results.some((r:any)=>r.source==="document"), "doc returned with collections");
    const noColl = await client.callTool({ name:"memory_recall", arguments:{ query:"deploy flux", limit:5 } });
    const noParsed = JSON.parse((noColl.content as any)[0].text);
    assert.equal(noParsed.results.filter((r:any)=>r.source==="document").length, 0, "no docs without collections (B1)");
    await close();
  });
  it("B2: doc-pattern query still returns memories when docs configured but no doc match", async () => {
    const { client, close } = await setup();
    await client.callTool({ name:"memory_store", arguments:{ text:"the readme explains the deploy", category:"fact" } });
    const res = await client.callTool({ name:"memory_recall", arguments:{ query:"readme deploy", collections:["nomatch"], limit:5 } });
    const parsed = JSON.parse((res.content as any)[0].text);
    assert.ok(parsed.results.length > 0, "memory returned despite DOC_PATTERNS (B2)");
    await close();
  });
  it("document_collections lists collections", async () => {
    const { client, close } = await setup();
    await client.callTool({ name:"document_upsert", arguments:{ collection:"p", docId:"d1", text:"x", title:"D1" } });
    const res = await client.callTool({ name:"document_collections", arguments:{} });
    const parsed = JSON.parse((res.content as any)[0].text);
    assert.ok(parsed.collections.some((c:any)=>c.collection==="p"));
    await close();
  });
});
```

- [ ] **Step 2: Add B5 dimension-mismatch test** (separate — construction must throw)

```ts
describe("MCP doc bootstrap (B5)", () => {
  it("throws when embedder dimensions != vectorDim", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-b5-"));
    assert.throws(() => createMemexMcpServer({
      dbPath: join(dir, "m.sqlite"), vectorDim: 32, embedder,   // embedder.dimensions=16 != 32
      documents: { paths: [] },
    }), /dimension/i);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 3: Run — verify FAIL**

- [ ] **Step 4: Wire the daemon** (`src/mcp-server.ts`, `createMemexMcpServer`):
  - `McpServerOptions`: add `documents?: { paths: Array<{ path: string; name: string }> }`; resolve via env-overrides (`MEMEX_DOC_PATHS`).
  - `docsConfigured = !!(options.documents || resolveDocPathsFromEnv())`.
  - **B5 assert + B6 bootstrap:**
    ```ts
    if (docsConfigured && embedder && embedder.dimensions !== dim)
      throw new Error(`dimension mismatch: embedder ${embedder.dimensions} != vectorDim ${dim} (B5)`);
    let store: MemoryStore;
    let ss: ReturnType<typeof createStore> | undefined;
    if (docsConfigured) {
      ss = createStore(dbPath);
      ss.ensureVecTable(dim);
      store = new MemoryStore({ dbPath, vectorDim: dim, db: ss.db });
    } else {
      store = new MemoryStore({ dbPath, vectorDim: dim });
    }
    ```
  - **B2 retriever:** `docsConfigured` → `new UnifiedRetriever(store, documentSearchFn, embedder, { captureTrace })` (capture `retrieverKind = "unified"`); else `createRetriever(...)` (kind `"memory"`).
  - **B1 documentSearchFn:**
    ```ts
    const documentSearchFn = async (query, vec, limit, _coll, collections) => {
      if (!collections?.length) return [];                                   // B1 gate
      const fts = searchFTS(ss!.db, query, limit, undefined, collections);
      const vecRes = await searchVec(ss!.db, query, embeddingModel, limit, undefined, undefined, vec, collections);  // 8 args — collections forwarded
      // merge per filepath → DocumentCandidate[] (mirror index.ts:895-938)
      return merged;
    };
    ```
  - **B3 call-shape** in `memory_recall`: branch on `retrieverKind`:
    ```ts
    if (retrieverKind === "unified") {
      results = await unifiedRetriever.retrieve(query, { limit, scopeFilter: effectiveScopes, collections, debugId });
    } else {
      results = await memoryRetriever.retrieve({ query, limit, scopes: effectiveScopes, debugId });
    }
    ```
    Add `collections?: z.array(z.string())` to the `memory_recall` input schema.
  - **Tools:** `document_upsert` (requires `collection`+`docId`+`text`; calls `upsertDocument`), `document_forget`, `document_collections` (`SELECT collection, count(*) c FROM documents WHERE active=1 GROUP BY collection`).
  - **Configured-dir indexing:** when `MEMEX_DOC_PATHS`/`documents.paths` set: on startup + interval (default 30 min) call `await indexAllPaths(ss.db, paths); await embedDocuments(ss.db, dim, embedder);`. Hold the interval handle; clear it on shutdown (mirror `index.ts:877` / shutdown trap).

- [ ] **Step 5: Run integration + B5 tests — verify PASS**

- [ ] **Step 6: Commit**

```bash
git add src/mcp-server.ts tests/mcp-doc-tools.test.ts
git commit -m "feat(mcp-server): unified doc retrieval + collection gate + tools (B1/B2/B3/B5/B6)"
```

---

## Task 6: Regression + finalize

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all green (prior count + new tests).

- [ ] **Step 2: Scoping regression**

Run: `node --import jiti/register --test tests/memory-scoping.test.ts tests/memory-scoping-e2e.test.ts`
Expected: PASS.

- [ ] **Step 3: domain-eval unaffected** (memory-only; docs opt-in) — run via proxy if embed env available; else note skipped.

- [ ] **Step 4: Push + PR**

```bash
git push -u origin feat/mcp-unified-doc-retrieval
# open PR: feat: MCP unified (memory + document) retrieval — references spec + B1–B7
```

---

## Verification (end-to-end, post-merge)

1. Configure `MEMEX_DOC_PATHS=/srv/docs:team` on the daemon, restart.
2. `document_upsert({collection:"scratch", docId:"note1", text:"...", title:"Note"})`.
3. `memory_recall({query:"...", collections:["team","scratch"]})` → memories AND docs.
4. `memory_recall({query:"..."})` (no collections) → memories only (gate holds).
5. `show-trace <debugId>` on a doc-containing recall shows `document-search` + `merge` stages.

## Risks / notes

- **Mirror `indexPath`'s pipeline exactly** in `upsertDocument` — the verified helpers (`hashContent` → `insertContent` → `insertDocument`) are the canonical sequence; do not raw-INSERT (loses section-FTS).
- **Three filter sites** in Task 1 (whole-doc FTS, section FTS, searchVec) — all must get the `collections` branch or results leak.
- **`searchVec` arg order:** `(db, query, model, limit, collectionName, session, precomputedEmbedding, collections)` — `collections` is the 8th positional; the `documentSearchFn` call must pass it.
- **B5 dimension assert is load-bearing** — without it, a dim mismatch silently wipes the other store's vectors via `ensureVecTable` drop+rebuild.
- **Commit hooks:** the pre-commit security hook flags the substring `eval(` (which appears inside `retrieval(`/`Retrieval(` method names when followed by `(`) — avoid writing those tokens with a paren in committed code/comments. The secret-pattern hook blocks real hostnames/IPs/domains — use placeholders.
