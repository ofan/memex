# SQLite Consolidation: Drop LanceDB, Unify Both Stores

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace LanceDB with SQLite + sqlite-vec + FTS5 for conversation memory, unifying both stores into a single database. Preserve all retriever/tool interfaces exactly.

**Architecture:** Reimplement `MemoryStore` class using SQLite (same interface, same method signatures). The retriever, tools, unified-recall, and session-indexer depend on `MemoryStore`'s interface, not LanceDB internals — so they work unchanged. The QMD document store already uses SQLite + sqlite-vec + FTS5, so we extend that database with a `memories` table.

**Tech Stack:** SQLite (better-sqlite3), sqlite-vec, FTS5, TypeScript (jiti, no build step)

---

## Context

The plugin currently uses two databases:
- **LanceDB** (Arrow-based): conversation memory (~500 entries, ~230MB RSS)
- **SQLite** (QMD): document search (~450 docs, ~10MB)

Research (2026-03-14) showed LanceDB provides no benefit at our scale (<100K vectors for years). Consolidation saves ~200MB RSS, 267MB disk, and unifies the indexing experience.

## Existing Code to Reuse

- `src/qmd/store.ts` — SQLite database setup, FTS5, sqlite-vec already working
- `src/qmd/db.ts` — `openDatabase()`, `loadSqliteVec()` helpers
- `src/retriever.ts` — 7-stage pipeline, untouched (depends on MemoryStore interface)
- `src/tools.ts` — agent tools, untouched (depends on MemoryStore interface)
- `src/unified-recall.ts` — simplifies (no more dual-source fan-out)
- All existing QMD document search functionality preserved

## Key Interfaces to Preserve

```typescript
// MemoryStore interface (from src/store.ts)
// These method signatures MUST NOT change — retriever/tools depend on them
class MemoryStore {
  async store(entry: Omit<MemoryEntry, "id" | "timestamp">): Promise<MemoryEntry>
  async bulkStore(entries: Omit<MemoryEntry, "id" | "timestamp">[]): Promise<MemoryEntry[]>
  async importEntry(entry: MemoryEntry): Promise<MemoryEntry>
  async update(id: string, updates: Partial<MemoryEntry>, scopeFilter?: string[]): Promise<MemoryEntry | null>
  async delete(id: string, scopeFilter?: string[]): Promise<boolean>
  async hasId(id: string): Promise<boolean>
  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number>
  async vectorSearch(vector: number[], limit?, minScore?, scopeFilter?): Promise<MemorySearchResult[]>
  async bm25Search(query: string, limit?, scopeFilter?): Promise<MemorySearchResult[]>
  async list(scopeFilter?, category?, limit?, offset?): Promise<MemoryEntry[]>
  async stats(scopeFilter?): Promise<StoreStats>
  get dbPath(): string
  get hasFtsSupport(): boolean
  async rebuildFtsIndex(): Promise<void>
}
```

## Files to Modify/Create

| File | Action | Changes |
|------|--------|---------|
| `src/store.ts` | **Rewrite** | Replace LanceDB with SQLite implementation, same interface |
| `src/unified-recall.ts` | **Simplify** | Both sources now in same DB; simplify fan-out |
| `index.ts` | **Modify** | Remove LanceDB init, wire single SQLite DB |
| `src/session-indexer.ts` | **Minor** | Update import path if store interface changes |
| `tests/store.test.ts` | **Rewrite** | Test SQLite-backed MemoryStore |
| `tests/unified-recall.test.ts` | **Update** | Adapt to simplified architecture |
| `package.json` | **Modify** | Remove `@lancedb/lancedb` dependency |

## Migration Strategy

Existing LanceDB data needs to be migrated to SQLite on first run:
1. Check if legacy LanceDB directory exists
2. If yes, read all memories from LanceDB
3. Insert into new SQLite `memories` table
4. Log migration count
5. Do NOT delete LanceDB data (keep as backup)

---

## Chunk 1: SQLite MemoryStore (Tasks 1-3)

### Task 1: Schema — Add `memories` Table to QMD Database

**Files:**
- Modify: `src/qmd/store.ts` (add to `initializeDatabase()`)

**Design:** Add a `memories` table alongside existing document tables. Uses same SQLite connection, same FTS5 tokenizer, same sqlite-vec. The memories table mirrors the LanceDB schema exactly.

- [ ] **Step 1: Add memories table to initializeDatabase()**

In `src/qmd/store.ts`, add after the sections_fts backfill block (around line 790):

```sql
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  scope TEXT NOT NULL DEFAULT 'global',
  importance REAL NOT NULL DEFAULT 0.5,
  timestamp INTEGER NOT NULL,
  metadata TEXT
)
```

Add indexes:
```sql
CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope)
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC)
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)
```

Add FTS5 for memories:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  text,
  tokenize='porter unicode61'
)
```

Add triggers to keep memories_fts in sync:
```sql
-- After insert
CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END

-- After delete
CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.rowid;
END

-- After update
CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE rowid = old.rowid;
  INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
END
```

Memory vectors go in the existing `vectors_vec` sqlite-vec table using the memory id as the key (like documents use `hash_seq`). Add a `memory_vectors` table for the mapping:

```sql
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedded_at TEXT NOT NULL
)
```

The actual vector data goes in `vectors_vec` with key `mem_<id>`.

- [ ] **Step 2: Run existing tests to verify no regressions**

Run: `node --import jiti/register --test tests/store.test.ts tests/dual-fts.test.ts`

- [ ] **Step 3: Commit**

---

### Task 2: SQLite MemoryStore Implementation

**Files:**
- Rewrite: `src/store.ts`
- Create: `tests/memory-store-sqlite.test.ts`

**Design:** Reimplement the `MemoryStore` class using SQLite. Same constructor signature (`StoreConfig`), same method signatures. The class wraps a `better-sqlite3` Database instance.

Key differences from LanceDB implementation:
- `vectorSearch()`: uses sqlite-vec `vectors_vec` table with `WHERE embedding MATCH ? AND k = ?`
- `bm25Search()`: uses FTS5 `memories_fts` with `MATCH` and `bm25()` scoring
- Score normalization: vector uses `1 / (1 + distance)`, BM25 uses `|bm25| / (1 + |bm25|)` (same as QMD)
- Scope filtering: SQL `WHERE scope IN (...)` instead of LanceDB string filter
- No dynamic import needed (better-sqlite3 is synchronous)

- [ ] **Step 1: Write failing tests**

Create `tests/memory-store-sqlite.test.ts` with tests for:
- `store()` — creates entry with id, timestamp, returns full MemoryEntry
- `store()` — validates vector dimensions match configured dim
- `bulkStore()` — stores multiple entries
- `importEntry()` — stores with existing id/timestamp preserved
- `vectorSearch()` — returns results sorted by similarity, scores in [0,1]
- `bm25Search()` — finds by text keywords, scores in [0,1]
- `update()` — updates text, re-embeds if vector provided
- `delete()` — removes entry, returns true
- `delete()` — returns false for non-existent id
- `hasId()` — returns true/false
- `bulkDelete()` — deletes by scope and optional timestamp
- `list()` — returns entries filtered by scope/category, with limit/offset
- `stats()` — returns counts by scope, category, source
- `hasFtsSupport` — returns true (always, since FTS5 is built-in)
- `rebuildFtsIndex()` — rebuilds FTS index
- Scope filtering on vector/bm25/list/update/delete

Use temp directory for each test (same pattern as QMD tests).

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement MemoryStore class**

Rewrite `src/store.ts`. Key implementation notes:

Constructor:
- Takes `StoreConfig` with `dbPath` and `vectorDim`
- Opens/creates SQLite database using `openDatabase()` from `src/qmd/db.ts`
- Calls `initializeDatabase()` to ensure all tables exist
- Calls `ensureVecTable()` with configured dimensions
- Store `db` reference and config

`store(entry)`:
- Generate `id` with `randomUUID()`
- Set `timestamp` to `Date.now()`
- INSERT into `memories` table
- INSERT vector into `vectors_vec` with key `mem_<id>`
- INSERT into `memory_vectors` mapping
- FTS triggers handle `memories_fts` automatically
- Return complete MemoryEntry

`vectorSearch(vector, limit, minScore, scopeFilter)`:
- Query `vectors_vec` with embedding MATCH, k = limit * 3
- Filter to `mem_*` keys only
- JOIN with `memories` table
- Apply scope filter
- Compute score: `1 / (1 + distance)`
- Filter by minScore
- Return sorted, limited results

`bm25Search(query, limit, scopeFilter)`:
- Build FTS5 query using `buildFTS5Query()` from QMD store (reuse!)
- Query `memories_fts` JOIN `memories`
- Apply scope filter
- Normalize BM25: `|score| / (1 + |score|)` (same as QMD)
- Return sorted, limited results

`update(id, updates, scopeFilter)`:
- SELECT existing entry
- Check scope access
- UPDATE fields in `memories`
- If vector changed: DELETE old from `vectors_vec`, INSERT new
- FTS trigger handles text update
- Return updated entry

`delete(id, scopeFilter)`:
- Check scope access
- DELETE from `memories` (CASCADE handles memory_vectors)
- DELETE from `vectors_vec` where key = `mem_<id>`
- FTS trigger handles deletion
- Return success boolean

`list(scopeFilter, category, limit, offset)`:
- SELECT from `memories` with WHERE clauses
- ORDER BY timestamp DESC
- LIMIT/OFFSET

`stats(scopeFilter)`:
- COUNT grouped by scope, category
- Parse metadata for source counts

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Run full test suite for regressions**

Run: `node --import jiti/register --test tests/memory-store-sqlite.test.ts tests/store.test.ts tests/dual-fts.test.ts tests/section-splitting.test.ts`

- [ ] **Step 6: Commit**

---

### Task 3: Verify Retriever + Tools Work with New Store

**Files:**
- Modify: `tests/retriever.test.ts` — update store creation
- Modify: `tests/unified-recall.test.ts` — update store creation

**Design:** The retriever and tools depend on `MemoryStore` interface. If our new SQLite MemoryStore has the same interface, they should work without code changes. This task verifies that.

- [ ] **Step 1: Update retriever tests to use SQLite MemoryStore**

Change the import and construction of MemoryStore in `tests/retriever.test.ts` to use the new SQLite-backed version. The test setup should create a temp SQLite DB instead of a temp LanceDB directory.

- [ ] **Step 2: Run retriever tests**

Run: `node --import jiti/register --test tests/retriever.test.ts`

Fix any interface mismatches. The scoring pipeline code should not change — only the store layer.

- [ ] **Step 3: Update unified-recall tests**

Similar update for `tests/unified-recall.test.ts`.

- [ ] **Step 4: Run unified-recall tests**

- [ ] **Step 5: Run full test suite**

Run all 16 non-network test files.

- [ ] **Step 6: Commit**

---

## Chunk 2: Wiring + Migration (Tasks 4-5)

### Task 4: Wire Single Database in index.ts

**Files:**
- Modify: `index.ts`
- Modify: `src/unified-recall.ts` (simplify)

**Design:** Both conversation memory and document search now use the same SQLite database. The `index.ts` initialization creates one DB, passes it to both the MemoryStore and the QMD store. UnifiedRecall simplifies — no more dual-source fan-out with score normalization, since both sources are queried through the same DB.

- [ ] **Step 1: Update index.ts initialization**

Remove LanceDB setup code. Create single SQLite DB path. Pass to both MemoryStore and QMD createStore.

Key change: MemoryStore now takes the same DB path as QMD. Both use the same `better-sqlite3` connection.

- [ ] **Step 2: Simplify unified-recall.ts**

Since both stores use the same DB, unified recall can be simplified:
- Remove dual-source fan-out
- Remove independent score normalization
- The `recall()` method can query both memories and documents in a single pipeline
- Keep source attribution ("conversation" vs "document") in results

OR: keep unified-recall as-is but with both stores pointing to the same DB. This is simpler and preserves the existing tested code paths. Decide based on complexity.

- [ ] **Step 3: Run full test suite**

- [ ] **Step 4: Commit**

---

### Task 5: LanceDB → SQLite Migration

**Files:**
- Create: `src/migrate-lancedb.ts`
- Modify: `index.ts` (call migration on startup)

**Design:** On first startup after upgrade, check if legacy LanceDB data exists. If so, read all memories and insert into the new SQLite `memories` table. Keep LanceDB data as backup.

- [ ] **Step 1: Implement migration function**

```typescript
export async function migrateLanceDBToSQLite(
  lanceDbPath: string,
  sqliteStore: MemoryStore
): Promise<{ migrated: number; skipped: number; errors: string[] }>
```

Algorithm:
1. Check if `lanceDbPath` directory exists
2. If not, return `{ migrated: 0, skipped: 0, errors: [] }`
3. Dynamically import `@lancedb/lancedb` (keep dependency for migration only)
4. Open LanceDB, read all entries from `memories` table
5. For each entry, call `sqliteStore.importEntry()` (preserves id/timestamp)
6. Skip entries that already exist (by id)
7. Log migration results
8. Return counts

- [ ] **Step 2: Wire migration into index.ts**

Call `migrateLanceDBToSQLite()` during plugin initialization, after MemoryStore is created.

- [ ] **Step 3: Test migration**

Create a test that:
1. Seeds a LanceDB with sample memories
2. Creates SQLite MemoryStore
3. Runs migration
4. Verifies all memories are in SQLite
5. Runs migration again → verifies 0 new migrations (idempotent)

- [ ] **Step 4: Commit**

---

## Chunk 3: Cleanup + Validation (Tasks 6-7)

### Task 6: Remove LanceDB Dependency

**Files:**
- Modify: `package.json` — remove `@lancedb/lancedb`
- Modify: `src/store.ts` — remove any remaining LanceDB imports
- Delete: any LanceDB-specific utility files
- Modify: `CLAUDE.md` — update architecture, memory footprint

- [ ] **Step 1: Remove @lancedb/lancedb from package.json**

Keep it as an optional dependency for migration only, OR move migration to a separate script that users run once.

Decision: Keep `@lancedb/lancedb` as `optionalDependencies` so migration works but fresh installs don't download it.

- [ ] **Step 2: Update CLAUDE.md**

Update architecture diagram, memory footprint (~30MB instead of ~230MB), remove LanceDB references from deployment docs.

- [ ] **Step 3: npm install to verify**

- [ ] **Step 4: Run full test suite**

- [ ] **Step 5: Commit**

---

### Task 7: End-to-End Validation

**Files:**
- Modify: `tests/benchmark.ts` — update for SQLite store

- [ ] **Step 1: Run all non-network tests**

Run all 16+ test files. Target: 330+ tests passing, 0 failures.

- [ ] **Step 2: Run retrieval quality tests**

Verify no regression in golden corpus metrics.

- [ ] **Step 3: Run benchmarks**

Compare memory footprint (target: <50MB RSS vs current ~230MB).
Compare vector search latency (target: <5ms at current scale).

- [ ] **Step 4: Deploy to openclaw**

```bash
rsync -av --exclude='.git' --exclude='node_modules' ... ~/.openclaw/plugins/memex/
```

Restart gateway. Verify migration runs and logs.

- [ ] **Step 5: Test live queries**

Verify memory recall, document search, and unified recall all work in production.

- [ ] **Step 6: Commit any final fixes**

---

## Verification

1. All existing tests pass (330+)
2. Retrieval quality metrics unchanged
3. Memory footprint reduced from ~230MB to <50MB RSS
4. All memory tools work: recall, store, forget, update
5. Session import works with new store
6. Migration from LanceDB is idempotent
7. Production deployment works
