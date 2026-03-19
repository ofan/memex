# Chunk-Level FTS Indexing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace whole-document FTS indexing with chunk-level FTS indexing so BM25 scores reflect chunk-level term frequency, fixing score dilution for large multi-topic documents.

**Architecture:** Create a new `chunks_fts` FTS5 table that indexes one row per chunk (mirroring the existing `content_vectors` table). Replace the `documents_fts` triggers with application-level chunking at insert/update time. `searchFTS()` queries the new table, deduplicates by document (keeping the best-scoring chunk per doc), and returns the chunk position alongside the result. `hybridQuery()` step 5 can skip re-chunking for FTS-sourced candidates since their best chunk position is already known.

**Tech Stack:** SQLite FTS5, better-sqlite3, existing `chunkDocument()` from `src/qmd/store.ts`

---

## Problem Statement

FTS indexes each document as a single row in `documents_fts`, with the full document body in the `body` column. BM25 scoring uses TF-IDF, which penalizes documents where query terms appear infrequently relative to document length.

**Production impact (450 active docs):**

| Bucket | Docs | Avg chars | FTS impact |
|--------|------|-----------|------------|
| ≤3600 (1 chunk) | 299 (66%) | ~1500 | None — FTS and vector aligned |
| 3.6K-7.2K (2-3 chunks) | 80 (18%) | 5140 | Mild dilution |
| 7.2K-18K (3-5 chunks) | 51 (11%) | 10804 | Moderate dilution |
| >18K (6+ chunks) | 20 (4%) | 27632 | Severe dilution |

151 documents (34%) are affected. The worst case is a 62K-char task file (~21 chunks) where a query term appearing in one section competes against 62K chars of unrelated content for BM25 scoring.

**MEMORY.md (2030 chars) is NOT affected by this change** — it's below the 3600-char chunk threshold and will remain a single-chunk document. Its retrieval issues are caused by topic density (20+ topics in 2K chars), not by multi-chunk dilution.

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/qmd/store.ts` | Modify | New `chunks_fts` table, migration, updated `searchFTS()`, updated `insertDocument`/`updateDocument`/`deactivateDocument` |
| `tests/store.test.ts` | Modify | Tests for chunk-level FTS: multi-chunk doc ranking, dedup, migration |
| `tests/retrieval-quality.test.ts` | Modify | Update FTS baseline thresholds after improvement |

## Key Design Decisions

### 1. New table vs modifying existing table

**Decision: New `chunks_fts` table.** The existing `documents_fts` table is a standalone (non-content) FTS5 table, so its schema can't be ALTER'd. We must drop and recreate, or create a new table. A new table allows a clean migration with rollback capability.

### 2. Triggers vs application-level inserts

**Decision: Application-level inserts.** SQL triggers cannot run the JavaScript `chunkDocument()` function. The FTS insert logic must move into `insertDocument()`, `updateDocument()`, and `deactivateDocument()`. The old triggers on `documents_fts` stay for backward compatibility but are inert once `chunks_fts` is the active table.

### 3. FTS result granularity

**Decision: Return one result per document (best-scoring chunk).** The current `searchFTS()` returns one `SearchResult` per document. Changing this contract would cascade into `hybridQuery()`, RRF fusion, dedup logic, and all callers. Instead, `searchFTS()` queries `chunks_fts`, groups by document, keeps the best BM25 score per document, and attaches `chunkPos` to the result.

### 4. Chunk storage for FTS

**Decision: Store chunk text in a new `content_chunks` table.** The `chunks_fts` table needs text to index, but we don't want to duplicate text in both `content` (full doc) and `chunks_fts` (FTS internal storage). A `content_chunks` table with `(hash, seq, pos, text)` serves as the source of truth for chunk text, referenced by both FTS and vector indexing.

### 5. Re-chunking in `hybridQuery()` step 5

**Decision: Skip re-chunking for FTS-sourced candidates.** If `searchFTS()` already provides the best chunk position, `hybridQuery()` step 5 can use that directly instead of calling `chunkDocument()` again. Vector-sourced candidates still need re-chunking since `searchVec()` returns chunk positions but not chunk text.

---

## Chunk 1: Schema + Migration + Application-Level FTS Inserts

### Task 1: Add `content_chunks` table and `chunks_fts` FTS5 table

**Files:**
- Modify: `src/qmd/store.ts:660-745` (database initialization)

- [ ] **Step 1: Write the failing test for chunk-level FTS search**

Add to `tests/store.test.ts` in a new describe block after the existing `buildFTS5Query` tests:

```typescript
import { createStore, chunkDocument, insertContent, insertDocument, CHUNK_SIZE_CHARS } from "../src/qmd/store.js";
import { mkdtempSync, rmSync } from "node:fs";

describe("chunk-level FTS", () => {
  it("ranks a multi-chunk doc higher when query matches one chunk", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "chunk-fts-"));
    const store = createStore(join(tmpDir, "test.sqlite"));
    const now = new Date().toISOString();

    // Create a large doc (>3600 chars) where "selenium" only appears in section 3
    const filler = "This is generic content about various topics. ".repeat(50); // ~2300 chars
    const largeDoc = `# Big Doc\n\n## Section 1\n${filler}\n## Section 2\n${filler}\n## Section 3\nSelenium prevents cancer in laboratory studies.\n`;
    const hash1 = "hash-large";
    insertContent(store.db, hash1, largeDoc, now);
    insertDocument(store.db, "test", "large.md", "Big Doc", hash1, now, now);

    // Create a small doc that also mentions selenium
    const smallDoc = "# Small Doc\nSelenium is a browser testing framework.";
    const hash2 = "hash-small";
    insertContent(store.db, hash2, smallDoc, now);
    insertDocument(store.db, "test", "small.md", "Small Doc", hash2, now, now);

    const results = store.searchFTS("selenium", 10, "test");
    assert.ok(results.length >= 2, `Expected >=2 results, got ${results.length}`);

    // With chunk-level FTS, the large doc's chunk with "selenium" should score
    // comparably to the small doc (not be penalized for surrounding content)
    const largeResult = results.find(r => r.filepath.includes("large.md"));
    const smallResult = results.find(r => r.filepath.includes("small.md"));
    assert.ok(largeResult, "large.md should appear in results");
    assert.ok(smallResult, "small.md should appear in results");

    // The large doc should not be ranked more than 2 positions below the small doc
    const largeIdx = results.findIndex(r => r.filepath.includes("large.md"));
    const smallIdx = results.findIndex(r => r.filepath.includes("small.md"));
    assert.ok(
      largeIdx - smallIdx <= 2,
      `large.md at rank ${largeIdx + 1} vs small.md at rank ${smallIdx + 1} — gap too large (chunk dilution)`
    );

    store.close();
    rmSync(tmpDir, { recursive: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep "chunk-level FTS" -A 5`

Expected: The test should pass or fail depending on current behavior. If it passes already, increase the doc size or tighten the assertion. The point is to establish a baseline.

- [ ] **Step 3: Add `content_chunks` table and `chunks_fts` table to `initializeDatabase()`**

In `src/qmd/store.ts`, after the `content_vectors` table creation (~line 698), add:

```typescript
  // Content chunks — stores chunk text for FTS indexing
  // Mirrors content_vectors layout but stores text instead of embeddings.
  // Populated by application code (insertDocument/updateDocument), not triggers.
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_chunks (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      text TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Chunk-level FTS — one row per chunk instead of one row per document.
  // Replaces documents_fts for search. Gives BM25 chunk-level TF-IDF precision.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);
```

- [ ] **Step 4: Create `populateChunkFTS()` helper function**

Add after `insertDocument()` (~line 1295):

```typescript
/**
 * Populate chunk-level FTS rows for a document.
 * Chunks the content and inserts one FTS row per chunk.
 * Also stores chunk text in content_chunks for later retrieval.
 */
function populateChunkFTS(
  db: Database,
  documentId: number,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  content: string
): void {
  const filepath = `${collectionName}/${path}`;
  const chunks = chunkDocument(content);

  // Store chunk text in content_chunks
  const insertChunkStmt = db.prepare(
    `INSERT OR REPLACE INTO content_chunks (hash, seq, pos, text) VALUES (?, ?, ?, ?)`
  );
  for (let seq = 0; seq < chunks.length; seq++) {
    insertChunkStmt.run(hash, seq, chunks[seq]!.pos, chunks[seq]!.text);
  }

  // Insert one FTS row per chunk using synthetic rowid: documentId * 1000 + seq
  // This gives us up to 1000 chunks per document (max ~3.6M chars, well beyond any doc).
  const insertFtsStmt = db.prepare(
    `INSERT INTO chunks_fts(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`
  );
  for (let seq = 0; seq < chunks.length; seq++) {
    const syntheticRowid = documentId * 1000 + seq;
    insertFtsStmt.run(syntheticRowid, filepath, title, chunks[seq]!.text);
  }
}

/**
 * Remove all chunk-level FTS rows for a document.
 */
function removeChunkFTS(db: Database, documentId: number): void {
  // Delete all possible synthetic rowids for this document
  const minRowid = documentId * 1000;
  const maxRowid = minRowid + 999;
  db.prepare(`DELETE FROM chunks_fts WHERE rowid BETWEEN ? AND ?`).run(minRowid, maxRowid);
  // Also remove content_chunks (need hash, get from documents table)
  const doc = db.prepare(`SELECT hash FROM documents WHERE id = ?`).get(documentId) as { hash: string } | undefined;
  if (doc) {
    db.prepare(`DELETE FROM content_chunks WHERE hash = ?`).run(doc.hash);
  }
}
```

- [ ] **Step 5: Update `insertDocument()` to populate chunk FTS**

Modify `insertDocument()` at line 1278:

```typescript
export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string
): void {
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      active = 1
  `).run(collectionName, path, title, hash, createdAt, modifiedAt);

  // Get the document ID (whether just inserted or updated via ON CONFLICT)
  const doc = db.prepare(
    `SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1`
  ).get(collectionName, path) as { id: number } | undefined;

  if (doc) {
    // Fetch content for chunking
    const content = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(hash) as { doc: string } | undefined;
    if (content) {
      removeChunkFTS(db, doc.id);
      populateChunkFTS(db, doc.id, collectionName, path, title, hash, content.doc);
    }
  }
}
```

- [ ] **Step 6: Update `updateDocument()` to repopulate chunk FTS**

Modify `updateDocument()` at line 1330:

```typescript
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): void {
  // Get collection/path before update (needed for FTS filepath)
  const doc = db.prepare(`SELECT collection, path FROM documents WHERE id = ?`).get(documentId) as
    { collection: string; path: string } | undefined;

  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ? WHERE id = ?`)
    .run(title, hash, modifiedAt, documentId);

  if (doc) {
    const content = db.prepare(`SELECT doc FROM content WHERE hash = ?`).get(hash) as { doc: string } | undefined;
    if (content) {
      removeChunkFTS(db, documentId);
      populateChunkFTS(db, documentId, doc.collection, doc.path, title, hash, content.doc);
    }
  }
}
```

- [ ] **Step 7: Update `deactivateDocument()` to remove chunk FTS**

Modify `deactivateDocument()` at line 1344:

```typescript
export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  const doc = db.prepare(
    `SELECT id FROM documents WHERE collection = ? AND path = ? AND active = 1`
  ).get(collectionName, path) as { id: number } | undefined;

  db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);

  if (doc) {
    removeChunkFTS(db, doc.id);
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep -E "(chunk-level|pass |fail )"`

Expected: The chunk-level FTS test should now pass (but `searchFTS` still queries old `documents_fts`). We need Task 2 to switch `searchFTS` to use `chunks_fts`.

- [ ] **Step 9: Commit**

```bash
git add src/qmd/store.ts tests/store.test.ts
git commit -m "feat: add content_chunks table and chunks_fts for chunk-level FTS indexing"
```

### Task 2: Switch `searchFTS()` to query `chunks_fts`

**Files:**
- Modify: `src/qmd/store.ts:2006-2057` (`searchFTS` function)

- [ ] **Step 1: Write tests that verify chunk-level scoring works**

Add to the `chunk-level FTS` describe block in `tests/store.test.ts`:

```typescript
  it("returns chunkPos for multi-chunk documents", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "chunk-fts-pos-"));
    const store = createStore(join(tmpDir, "test.sqlite"));
    const now = new Date().toISOString();

    // Create a doc where the term appears only in a late chunk
    const filler = "Unrelated content about gardening and cooking tips. ".repeat(100); // ~5200 chars
    const doc = `# Multi Chunk\n\n${filler}\n## Late Section\nQuantum computing is revolutionary.\n`;
    const hash = "hash-multichunk";
    insertContent(store.db, hash, doc, now);
    insertDocument(store.db, "test", "multi.md", "Multi Chunk", hash, now, now);

    const results = store.searchFTS("quantum", 5, "test");
    assert.ok(results.length >= 1, "Should find 'quantum'");
    assert.ok(results[0]!.chunkPos !== undefined, "Should have chunkPos");
    assert.ok(results[0]!.chunkPos! > 0, "chunkPos should be > 0 (term is in a late chunk)");

    store.close();
    rmSync(tmpDir, { recursive: true });
  });

  it("deduplicates to one result per document (best-scoring chunk)", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "chunk-fts-dedup-"));
    const store = createStore(join(tmpDir, "test.sqlite"));
    const now = new Date().toISOString();

    // Create a doc where the term appears in multiple chunks
    const section1 = "Selenium is used for browser testing. ".repeat(30); // ~1140 chars
    const filler = "Other content here. ".repeat(150); // ~3000 chars
    const section2 = "Selenium also has health benefits. ".repeat(30); // ~1050 chars
    const doc = `# Selenium Doc\n${section1}\n${filler}\n${section2}`;
    const hash = "hash-dedup";
    insertContent(store.db, hash, doc, now);
    insertDocument(store.db, "test", "selenium.md", "Selenium Doc", hash, now, now);

    const results = store.searchFTS("selenium", 10, "test");
    const seleniumResults = results.filter(r => r.filepath.includes("selenium.md"));
    assert.equal(seleniumResults.length, 1, "Should deduplicate to 1 result per document");

    store.close();
    rmSync(tmpDir, { recursive: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep "chunk-level FTS" -A 20`

Expected: `chunkPos` test fails (current `searchFTS` doesn't return `chunkPos` from `chunks_fts`).

- [ ] **Step 3: Update `searchFTS()` to query `chunks_fts`**

Replace the `searchFTS` function at line 2006:

```typescript
export function searchFTS(db: Database, query: string, limit: number = 20, collectionName?: string): SearchResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  // Check if chunks_fts exists and has data (migration may not have run yet)
  const hasChunksFts = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'`
  ).get();
  const chunksFtsCount = hasChunksFts
    ? (db.prepare(`SELECT count(*) as n FROM chunks_fts`).get() as { n: number }).n
    : 0;

  if (!hasChunksFts || chunksFtsCount === 0) {
    // Fallback to old documents_fts for un-migrated databases
    return searchFTSLegacy(db, query, ftsQuery, limit, collectionName);
  }

  // Query chunks_fts — may return multiple rows per document.
  // Reverse-engineer document ID from synthetic rowid: docId = rowid / 1000
  // Chunk seq: rowid % 1000
  let sql = `
    SELECT
      f.filepath,
      f.title,
      bm25(chunks_fts, 10.0, 1.0) as bm25_score,
      f.rowid as synthetic_rowid
    FROM chunks_fts f
    WHERE chunks_fts MATCH ?
  `;
  const params: (string | number)[] = [ftsQuery];

  if (collectionName) {
    sql += ` AND f.filepath LIKE ? || '/%'`;
    params.push(String(collectionName));
  }

  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  // Fetch more rows than limit to handle dedup (multiple chunks per doc)
  params.push(limit * 5);

  const rows = db.prepare(sql).all(...params) as {
    filepath: string; title: string; bm25_score: number; synthetic_rowid: number;
  }[];

  // Deduplicate: keep best-scoring chunk per document
  const bestPerDoc = new Map<string, {
    filepath: string; title: string; bm25_score: number; chunkSeq: number;
  }>();

  for (const row of rows) {
    const chunkSeq = row.synthetic_rowid % 1000;

    const existing = bestPerDoc.get(row.filepath);
    if (!existing || row.bm25_score < existing.bm25_score) {
      bestPerDoc.set(row.filepath, {
        filepath: row.filepath,
        title: row.title,
        bm25_score: row.bm25_score,
        chunkSeq,
      });
    }
  }

  // Convert to SearchResult[], sorted by score
  const deduped = [...bestPerDoc.values()]
    .sort((a, b) => a.bm25_score - b.bm25_score)
    .slice(0, limit);

  return deduped.map(row => {
    const qmdFilepath = `qmd://${row.filepath}`;
    const collName = row.filepath.split('/')[0] || "";

    // Look up the document hash and body
    const [coll, ...pathParts] = row.filepath.split('/');
    const docPath = pathParts.join('/');
    const doc = db.prepare(
      `SELECT d.hash, c.doc as body
       FROM documents d JOIN content c ON d.hash = c.hash
       WHERE d.collection = ? AND d.path = ? AND d.active = 1`
    ).get(coll, docPath) as { hash: string; body: string } | undefined;

    // Look up chunk position from content_chunks
    const chunkRow = doc ? db.prepare(
      `SELECT pos FROM content_chunks WHERE hash = ? AND seq = ?`
    ).get(doc.hash, row.chunkSeq) as { pos: number } | undefined : undefined;

    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      filepath: qmdFilepath,
      displayPath: row.filepath,
      title: row.title,
      hash: doc?.hash || "",
      docid: doc ? getDocid(doc.hash) : "",
      collectionName: collName,
      modifiedAt: "",
      bodyLength: doc?.body.length || 0,
      body: doc?.body || "",
      context: getContextForFile(db, qmdFilepath),
      score,
      source: "fts" as const,
      chunkPos: chunkRow?.pos,
    };
  });
}
```

- [ ] **Step 4: Extract old `searchFTS` as `searchFTSLegacy`**

Rename the old query logic into a private function for backward compatibility with un-migrated databases:

```typescript
/** Legacy whole-document FTS search — used when chunks_fts is empty/missing. */
function searchFTSLegacy(
  db: Database, query: string, ftsQuery: string, limit: number, collectionName?: string
): SearchResult[] {
  let sql = `
    SELECT
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body,
      d.hash,
      bm25(documents_fts, 10.0, 1.0) as bm25_score
    FROM documents_fts f
    JOIN documents d ON d.id = f.rowid
    JOIN content ON content.hash = d.hash
    WHERE documents_fts MATCH ? AND d.active = 1
  `;
  const params: (string | number)[] = [ftsQuery];
  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(String(collectionName));
  }
  sql += ` ORDER BY bm25_score ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as {
    filepath: string; display_path: string; title: string;
    body: string; hash: string; bm25_score: number;
  }[];
  return rows.map(row => {
    const collName = row.filepath.split('//')[1]?.split('/')[0] || "";
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName: collName,
      modifiedAt: "",
      bodyLength: row.body.length,
      body: row.body,
      context: getContextForFile(db, row.filepath),
      score,
      source: "fts" as const,
    };
  });
}
```

- [ ] **Step 5: Verify `chunkPos` exists on `SearchResult` type**

At ~line 1017, check the type. `chunkPos` should already be there from vector search. If not, add it:

```typescript
export type SearchResult = DocumentResult & {
  score: number;
  source: "fts" | "vec";
  chunkPos?: number;
};
```

- [ ] **Step 6: Run tests**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep -E "(tests |pass |fail )"`

Expected: All tests pass including new chunk-level FTS tests.

- [ ] **Step 7: Commit**

```bash
git add src/qmd/store.ts tests/store.test.ts
git commit -m "feat: switch searchFTS to chunk-level FTS5 for better BM25 precision"
```

### Task 3: Migration — backfill `chunks_fts` for existing databases

**Files:**
- Modify: `src/qmd/store.ts` (add migration in `initializeDatabase`)
- Modify: `tests/store.test.ts` (migration test)

Existing production databases have data in `documents_fts` but nothing in `chunks_fts`. On first startup after this change, we need to backfill.

- [ ] **Step 1: Write test for migration**

Add to the `chunk-level FTS` describe block:

```typescript
  it("migrates existing documents into chunks_fts on database open", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "chunk-fts-migrate-"));
    const dbPath = join(tmpDir, "migrate.sqlite");

    // Phase 1: Create a store with docs (populates chunks_fts via insertDocument)
    const store1 = createStore(dbPath);
    const now = new Date().toISOString();
    const filler = "Migration test content about various topics. ".repeat(100);
    insertContent(store1.db, "hash-migrate", filler, now);
    insertDocument(store1.db, "test", "migrate.md", "Migrate Test", "hash-migrate", now, now);

    // Verify chunks_fts has data
    const before = (store1.db.prepare(`SELECT count(*) as n FROM chunks_fts`).get() as { n: number }).n;
    assert.ok(before > 0, "chunks_fts should have rows after insert");

    // Phase 2: Simulate a pre-migration database by clearing chunks_fts
    store1.db.exec(`DELETE FROM chunks_fts`);
    store1.db.exec(`DELETE FROM content_chunks`);
    const cleared = (store1.db.prepare(`SELECT count(*) as n FROM chunks_fts`).get() as { n: number }).n;
    assert.equal(cleared, 0, "chunks_fts should be empty after clear");
    store1.close();

    // Phase 3: Re-open — migration should detect empty chunks_fts and backfill
    const store2 = createStore(dbPath);
    const results = store2.searchFTS("migration", 5, "test");
    assert.ok(results.length >= 1, "Should find 'migration' after backfill migration");
    store2.close();

    rmSync(tmpDir, { recursive: true });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep "migrates existing" -A 5`

Expected: FAIL — no migration logic yet.

- [ ] **Step 3: Add migration logic at end of `initializeDatabase()`**

After creating the `chunks_fts` table, check if it's empty while `documents` has rows, and backfill:

```typescript
  // Migration: backfill chunks_fts from existing documents
  const chunksFtsCount = (db.prepare(
    `SELECT count(*) as n FROM chunks_fts`
  ).get() as { n: number }).n;
  const docsCount = (db.prepare(
    `SELECT count(*) as n FROM documents WHERE active = 1`
  ).get() as { n: number }).n;

  if (chunksFtsCount === 0 && docsCount > 0) {
    console.warn(`[qmd] Migrating ${docsCount} documents to chunk-level FTS...`);
    const docs = db.prepare(`
      SELECT d.id, d.collection, d.path, d.title, d.hash, c.doc
      FROM documents d JOIN content c ON d.hash = c.hash
      WHERE d.active = 1
    `).all() as {
      id: number; collection: string; path: string;
      title: string; hash: string; doc: string;
    }[];

    const insertChunkStmt = db.prepare(
      `INSERT OR REPLACE INTO content_chunks (hash, seq, pos, text) VALUES (?, ?, ?, ?)`
    );
    const insertFtsStmt = db.prepare(
      `INSERT INTO chunks_fts(rowid, filepath, title, body) VALUES (?, ?, ?, ?)`
    );

    const migrate = db.transaction(() => {
      for (const doc of docs) {
        const chunks = chunkDocument(doc.doc);
        const filepath = `${doc.collection}/${doc.path}`;
        for (let seq = 0; seq < chunks.length; seq++) {
          insertChunkStmt.run(doc.hash, seq, chunks[seq]!.pos, chunks[seq]!.text);
          insertFtsStmt.run(doc.id * 1000 + seq, filepath, doc.title, chunks[seq]!.text);
        }
      }
    });
    migrate();
    console.warn(`[qmd] Migration complete.`);
  }
```

- [ ] **Step 4: Run tests**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep -E "(tests |pass |fail )"`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/qmd/store.ts tests/store.test.ts
git commit -m "feat: add migration to backfill chunks_fts for existing databases"
```

---

## Chunk 2: hybridQuery Optimization + Retrieval Quality Verification

### Task 4: Use FTS chunkPos in hybridQuery step 5

**Files:**
- Modify: `src/qmd/store.ts:2928-2949` (step 5 of `hybridQuery`)

Currently, `hybridQuery()` step 5 re-chunks ALL candidates to find the best keyword-overlapping chunk. For FTS-sourced candidates, the `chunkPos` from `searchFTS()` already identifies the best chunk.

- [ ] **Step 1: Write test for FTS chunkPos passthrough**

Add to `tests/store.test.ts`:

```typescript
  it("hybridQuery uses chunkPos from FTS for multi-chunk docs", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "chunk-fts-hybrid-"));
    const store = createStore(join(tmpDir, "test.sqlite"));
    const now = new Date().toISOString();

    const filler = "Unrelated gardening content about roses. ".repeat(200);
    const doc = `# Test Doc\n${filler}\n## Target Section\nNeutron star collisions produce gold.\n`;
    const hash = "hash-hybrid-test";
    insertContent(store.db, hash, doc, now);
    insertDocument(store.db, "test", "neutron.md", "Test Doc", hash, now, now);

    // FTS-only hybrid (no vectors available)
    const { hybridQuery } = await import("../src/qmd/store.js");
    const results = await hybridQuery(store, "neutron star gold", {
      collection: "test", limit: 5,
    });
    const hit = results.find(r => r.file.includes("neutron.md"));
    if (hit) {
      assert.ok(
        hit.bestChunkPos > 0,
        `bestChunkPos should be >0 for late-section match, got ${hit.bestChunkPos}`
      );
    }

    store.close();
    rmSync(tmpDir, { recursive: true });
  });
```

- [ ] **Step 2: Modify hybridQuery step 5 to use FTS chunkPos**

In `hybridQuery()` at step 5 (~line 2930), use FTS-provided chunk positions:

```typescript
  // Step 5: Chunk documents, pick best chunk per doc for reranking.
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const chunksToRerank: { file: string; text: string }[] = [];
  const docChunkMap = new Map<string, {
    chunks: { text: string; pos: number }[]; bestIdx: number;
  }>();

  // Collect FTS chunkPos from the initial FTS probe
  const ftsChunkPos = new Map<string, number>();
  for (const r of initialFts) {
    if (r.chunkPos !== undefined) ftsChunkPos.set(r.filepath, r.chunkPos);
  }

  for (const cand of candidates) {
    const chunks = chunkDocument(cand.body);
    if (chunks.length === 0) continue;

    let bestIdx = 0;

    // If FTS already identified the best chunk, use its position
    const ftsPos = ftsChunkPos.get(cand.file);
    if (ftsPos !== undefined && chunks.length > 1) {
      for (let i = 0; i < chunks.length; i++) {
        if (chunks[i]!.pos <= ftsPos
            && (i + 1 >= chunks.length || chunks[i + 1]!.pos > ftsPos)) {
          bestIdx = i;
          break;
        }
      }
    } else {
      // Fallback: keyword overlap scoring
      let bestScore = -1;
      for (let i = 0; i < chunks.length; i++) {
        const chunkLower = chunks[i]!.text.toLowerCase();
        const score = queryTerms.reduce(
          (acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0
        );
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
    }

    chunksToRerank.push({ file: cand.file, text: chunks[bestIdx]!.text });
    docChunkMap.set(cand.file, { chunks, bestIdx });
  }
```

- [ ] **Step 3: Run tests**

Run: `node --import jiti/register --test tests/store.test.ts 2>&1 | grep -E "(tests |pass |fail )"`

Expected: All pass.

- [ ] **Step 4: Commit**

```bash
git add src/qmd/store.ts tests/store.test.ts
git commit -m "perf: use FTS chunkPos to guide chunk selection in hybridQuery step 5"
```

### Task 5: Run retrieval quality evaluation and update baselines

**Files:**
- Modify: `tests/retrieval-quality.test.ts` (update thresholds if improved)

- [ ] **Step 1: Run retrieval quality test**

Run: `node --import jiti/register --test tests/retrieval-quality.test.ts 2>&1 | tail -40`

The golden corpus only has 36 docs, most under 3600 chars, so improvements may be modest. The real impact is on the production database (450 docs, 151 multi-chunk).

- [ ] **Step 2: Run production FTS spot-check**

Create a quick diagnostic script and test queries against the production QMD database after migration.

- [ ] **Step 3: Update FTS baseline thresholds if improved**

If the golden corpus FTS metrics improved, tighten the baseline assertions in `tests/retrieval-quality.test.ts`:

```typescript
assert.ok(avgRecall >= 0.75, `FTS avg recall@5 = ${avgRecall.toFixed(3)}, should be >= 0.75`);
```

- [ ] **Step 4: Run full test suite**

Run: `node --import jiti/register --test tests/adaptive-retrieval.test.ts tests/capture-quality.test.ts tests/chunker.test.ts tests/doc-indexer.test.ts tests/embedder.test.ts tests/importance.test.ts tests/ir-metrics.test.ts tests/noise-filter.test.ts tests/plugin-mock.test.ts tests/rerank-utils.test.ts tests/retriever.test.ts tests/scopes.test.ts tests/session-indexer.test.ts tests/store.test.ts tests/unified-recall.test.ts 2>&1 | grep -E "(tests |pass |fail )"`

Expected: All 312+ tests pass.

- [ ] **Step 5: Commit**

```bash
git add tests/retrieval-quality.test.ts
git commit -m "test: update FTS baselines after chunk-level indexing"
```

### Task 6: Test in OpenClaw production

- [ ] **Step 1: Restart the OpenClaw gateway to trigger migration**

The symlinked plugin code is already updated. Restart the gateway so it reopens the QMD database, triggering the migration logic.

- [ ] **Step 2: Verify migration ran**

Check the debug log for migration messages:

```
tail -20 /tmp/openclaw-debug.log | grep -i "migrat"
```

Expected: `[qmd] Migrating 450 documents to chunk-level FTS...` then `Migration complete.`

- [ ] **Step 3: Run production FTS spot-check**

Test the same queries from GH#6 plus multi-chunk doc queries via `openclaw memex search`.

- [ ] **Step 4: Verify stats are correct**

Run `openclaw memex stats` and confirm chunk counts are reasonable.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Synthetic rowid collision (doc ID > 2M) | 1000 chunks/doc is generous; max doc ID would need to exceed 2^53/1000. Not realistic. |
| Migration takes too long (450 docs) | Migration runs in a transaction; chunking is CPU-only, no network. Expect <1 second. |
| Legacy `documents_fts` becomes stale | Keep old triggers in place — they still fire and keep `documents_fts` updated. It's just not queried by default. Can be removed in a future cleanup. |
| `searchFTSLegacy` fallback masks bugs | Only activates if `chunks_fts` table doesn't exist or is empty. Any database opened after this change will have the table. |
| FTS index size ~2-3x | Production has 883 chunks for 450 docs (~2x). FTS5 internal storage is efficient; 12MB total QMD disk is negligible. |
| `content_chunks` duplicates text from `content` | Intentional — `content` stores full doc body, `content_chunks` stores per-chunk text. The overlap is bounded by corpus size (~12MB) and enables FTS5 to score per-chunk without runtime chunking. |
