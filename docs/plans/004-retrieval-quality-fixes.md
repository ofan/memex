# Retrieval Quality Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two retrieval quality issues — (1) hybrid fusion hurting vector results when BM25 returns garbage, and (2) BM25/FTS fundamentally broken for natural language queries due to strict AND matching and document-level indexing.

**Architecture:** Two independent fixes to `src/qmd/store.ts`. Fix A adds adaptive fusion that detects when BM25 contributes nothing useful and skips FTS list pushes entirely so vector-only ranking proceeds cleanly. Fix B replaces strict AND FTS matching with OR-based matching. Both are verified against three evaluation benchmarks: golden corpus (30 queries), SciFact (50 queries), FiQA (50 queries).

**Tech Stack:** TypeScript, SQLite FTS5, sqlite-vec, node:test

---

## Current Baselines

These numbers were measured with the evaluation framework committed at `77aa91d`. Any fix must improve (or at minimum not regress) these metrics.

| Benchmark | Method | nDCG@5 | MRR | Recall@5 | Zero-recall |
|-----------|--------|--------|-----|----------|-------------|
| **Golden (30q)** | FTS | 0.347 | 0.355 | 0.383 | 57% |
| | Vector | 0.455 | 0.478 | 0.433 | 50% |
| | **Hybrid** | **0.641** | **0.662** | **0.700** | **23%** |
| **SciFact (50q)** | FTS | 0.060 | 0.080 | 0.055 | 92% |
| | Vector | **0.825** | 0.807 | **0.900** | 10% |
| | **Hybrid** | 0.792 | 0.810 | 0.794 | 18% |
| **FiQA (50q)** | FTS | 0.014 | 0.040 | 0.005 | 96% |
| | Vector | **0.712** | 0.775 | **0.752** | 6% |
| | **Hybrid** | 0.524 | 0.690 | 0.456 | 30% |

**Key problem:** On SciFact and FiQA, hybrid is *worse* than vector-only because RRF fusion dilutes good vector results with garbage BM25 results.

## Score Ranges Reference

`searchFTS()` returns scores normalized to [0,1) via `|bm25_score| / (1 + |bm25_score|)` (line 2034 of `src/qmd/store.ts`). Strong matches score ~0.91, medium ~0.67, weak ~0.33, none ~0. All thresholds in this plan reference these normalized scores.

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/qmd/store.ts` | Modify | Fix A: adaptive fusion in `hybridQuery()`. Fix B: OR-based `buildFTS5Query()` |
| `src/qmd/store.ts` | Export | Export `buildFTS5Query` for direct testing |
| `tests/retrieval-quality.test.ts` | Modify | Add adaptive fusion regression test |
| `tests/beir-retrieval.test.ts` | Read-only | Run BEIR eval to verify fixes |
| `tests/store.test.ts` | Modify | Add `buildFTS5Query` unit tests |

---

## Chunk 1: Fix A — Adaptive Hybrid Fusion

### Problem

When BM25 returns zero or near-zero useful results (common for natural language queries), RRF fusion still treats BM25 ranked lists equally with vector ranked lists. This dilutes good vector rankings because:

1. RRF assigns scores based on rank position, not result quality
2. Documents that appear only in vector results get lower fused scores than documents appearing in both lists
3. The position-aware blending (Step 7) further compounds this by weighting RRF rank heavily (75% for top-3)

### Solution: BM25 Quality Gate — Skip FTS Pushes

Instead of pushing FTS results into `rankedLists` and then trying to remove them later (which would change list ordering and break the `i < 2` weight heuristic), **guard the FTS pushes at the source**. When BM25 is not useful, simply don't push FTS results into `rankedLists` at all. This preserves the existing list ordering (vector lists stay at the same indices) and the `i < 2` weight logic works correctly.

Three FTS push sites must be guarded:
1. **Initial FTS probe push** (line 2842-2848)
2. **Lex expansion loop** (line 2857-2868)
3. The `hasStrongSignal` logic (line 2828-2830) must also respect the gate

### Task 1: Add BM25 quality detection to `hybridQuery()`

**Files:**
- Modify: `src/qmd/store.ts:2806-2985` (hybridQuery function)
- Modify: `tests/retrieval-quality.test.ts` (add regression test)

- [ ] **Step 1: Write the failing test**

Refactor `tests/retrieval-quality.test.ts` to store per-query metrics at the `describe` block level so they can be compared across methods. Add a new test inside the existing hybrid section.

The test file currently computes metrics inside each `it()` block as local variables. Hoist the results arrays to `describe` scope:

```typescript
// At the top of the "retrieval quality" describe block, add shared state:
let ftsQueryMetrics: { id: string; recall5: number }[] = [];
let vectorQueryMetrics: { id: string; recall5: number }[] = [];
let hybridQueryMetrics: { id: string; recall5: number }[] = [];
```

In each existing `it()` block, after computing metrics, push to the shared array:
```typescript
ftsQueryMetrics.push({ id: q.id, recall5: recallAtK(relevantIds, resultIds, 5) });
```

Then add the regression test:
```typescript
it("hybrid does not degrade vector results when FTS returns nothing", () => {
  // Only meaningful when we have all three methods
  if (vectorQueryMetrics.length === 0 || hybridQueryMetrics.length === 0) return;

  const ftsZeroIds = new Set(
    ftsQueryMetrics.filter(m => m.recall5 === 0).map(m => m.id)
  );

  let degradations = 0;
  for (const vecM of vectorQueryMetrics) {
    if (!ftsZeroIds.has(vecM.id)) continue; // FTS found something — skip
    const hybM = hybridQueryMetrics.find(m => m.id === vecM.id);
    if (hybM && hybM.recall5 < vecM.recall5) {
      console.warn(`  DEGRADED: ${vecM.id} — vec R@5=${vecM.recall5} hybrid R@5=${hybM.recall5}`);
      degradations++;
    }
  }

  assert.equal(
    degradations, 0,
    `${degradations} queries where hybrid degraded vector results when FTS returned nothing`
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/retrieval-quality.test.ts`
Expected: FAIL on the new assertion (or SKIP if embedder unavailable — that's OK, the BEIR test with `BEIR_FULL=1` will catch it)

- [ ] **Step 3: Add BM25 quality constants**

In `src/qmd/store.ts`, near the existing constants (line ~223-227, after `STRONG_SIGNAL_MIN_GAP`):

```typescript
/** Minimum FTS results to consider BM25 "useful" for fusion */
const BM25_MIN_USEFUL_RESULTS = 2;

/** Minimum top FTS score (normalized [0,1)) to consider BM25 "useful" */
const BM25_MIN_USEFUL_SCORE = 0.15;
```

Note: Scores are already normalized to [0,1) by `searchFTS()` via `|x|/(1+|x|)` (line 2034). A score of 0.15 corresponds to a raw BM25 score of ~-0.18, which is an extremely weak match.

- [ ] **Step 4: Add quality detection logic**

In `hybridQuery()` after Step 1 (the BM25 probe, after line 2832), add:

```typescript
const bm25IsUseful = initialFts.length >= BM25_MIN_USEFUL_RESULTS
  && (initialFts[0]?.score ?? 0) >= BM25_MIN_USEFUL_SCORE;
```

- [ ] **Step 5: Guard all three FTS push sites**

**Site 1 — Initial FTS probe push (line 2842-2848):**

Change:
```typescript
if (initialFts.length > 0) {
```
To:
```typescript
if (initialFts.length > 0 && bm25IsUseful) {
```

**Site 2 — Lex expansion loop (line 2857-2868):**

Change:
```typescript
// 3a: Run FTS for all lex expansions right away (no LLM needed)
for (const q of expanded) {
  if (q.type === 'lex') {
```
To:
```typescript
// 3a: Run FTS for all lex expansions right away (no LLM needed)
// Skip if BM25 probe showed FTS is not useful for this query
for (const q of expanded) {
  if (q.type === 'lex' && bm25IsUseful) {
```

**Site 3 — No change needed** for `hasStrongSignal` (line 2828-2830). If BM25 is not useful, `hasStrongSignal` will already be false because `initialFts.length < 2` or `topScore < 0.85`. The `bm25IsUseful` threshold (0.15) is well below `STRONG_SIGNAL_MIN_SCORE` (0.85), so any strong signal implies useful BM25. No guard needed here.

**Preserve docidMap population** — even when skipping FTS from fusion, we still want docids for context. Keep the `docidMap.set()` calls but skip the `rankedLists.push()`:

```typescript
if (initialFts.length > 0) {
  for (const r of initialFts) docidMap.set(r.filepath, r.docid);
  if (bm25IsUseful) {
    rankedLists.push(initialFts.map(r => ({
      file: r.filepath, displayPath: r.displayPath,
      title: r.title, body: r.body || "", score: r.score,
    })));
  }
}
```

And similarly for the lex expansion loop — move the push inside a `bm25IsUseful` guard but keep `docidMap.set()`.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --import jiti/register --test tests/retrieval-quality.test.ts`
Expected: PASS — hybrid no longer degrades vector when FTS returns nothing

- [ ] **Step 7: Run full evaluation suite to measure improvement**

Run: `node --import jiti/register --test tests/retrieval-quality.test.ts`
Run: `node --import jiti/register --test tests/beir-retrieval.test.ts`

Record new metrics. Expected improvements:
- SciFact hybrid R@5 should rise from 0.794 toward 0.900 (vector-only level)
- FiQA hybrid R@5 should rise from 0.456 toward 0.752
- Golden hybrid R@5 should stay at ~0.700 (BM25 is useful there, gate won't trigger)

**Important:** After Fix B (OR matching) is also applied, BM25 will become useful for more queries. This means the gate will trigger less often, and the final combined metrics may differ from Fix A alone. Validate both fixes together at the end.

- [ ] **Step 8: Commit**

```bash
git add src/qmd/store.ts tests/retrieval-quality.test.ts
git commit -m "fix: adaptive hybrid fusion — skip BM25 when it returns garbage"
```

---

## Chunk 2: Fix B — OR-Based FTS Matching

### Problem

`buildFTS5Query()` (line 1990-1997) joins all query terms with AND + prefix match:
```
"term1"* AND "term2"* AND "term3"*
```

This means if ANY single term is missing from a document, the document is excluded entirely. For natural language queries like "Does selenium help prevent cancer?", terms like "prevent" may not appear verbatim, killing recall.

### Solution: OR-Based Matching

Replace strict AND with OR matching. For multi-term queries, emit: `"term1"* OR "term2"* OR "term3"*`

This dramatically increases recall at the cost of some precision, but precision is handled downstream by vector search and reranking.

**Score impact:** BM25 scoring with OR matching produces different rankings than AND. Documents that matched ALL terms under AND may now rank differently because partial matches enter the result set. This is expected and desirable — the reranker (Step 6 of hybridQuery) handles precision.

### Task 2: Fix `buildFTS5Query()` to use OR matching

**Files:**
- Modify: `src/qmd/store.ts:1990-1997` (buildFTS5Query function — must also add `export`)
- Modify: `tests/store.test.ts` (add unit tests for buildFTS5Query)

- [ ] **Step 1: Export `buildFTS5Query` and write the failing test**

First, in `src/qmd/store.ts:1990`, change:
```typescript
function buildFTS5Query(query: string): string | null {
```
To:
```typescript
export function buildFTS5Query(query: string): string | null {
```

Then add this to `tests/store.test.ts`:

```typescript
import { buildFTS5Query } from "../src/qmd/store.js";

describe("buildFTS5Query", () => {
  it("returns null for empty/whitespace input", () => {
    assert.equal(buildFTS5Query(""), null);
    assert.equal(buildFTS5Query("   "), null);
  });

  it("uses prefix matching for single terms", () => {
    const result = buildFTS5Query("selenium");
    assert.equal(result, '"selenium"*');
  });

  it("uses OR matching for multi-term queries", () => {
    const result = buildFTS5Query("selenium prevent cancer");
    assert.ok(result !== null);
    assert.ok(!result.includes(" AND "), `Expected OR matching, got: ${result}`);
    assert.ok(result.includes(" OR "), `Expected OR in query, got: ${result}`);
    assert.equal(result, '"selenium"* OR "prevent"* OR "cancer"*');
  });

  it("sanitizes special characters", () => {
    const result = buildFTS5Query("hello-world foo.bar");
    assert.ok(result !== null);
    assert.ok(!result.includes("-"), `Should strip hyphens: ${result}`);
    assert.ok(!result.includes("."), `Should strip dots: ${result}`);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import jiti/register --test tests/store.test.ts`
Expected: FAIL — "uses OR matching" test fails because current code uses AND. The export and other tests should pass.

- [ ] **Step 3: Modify `buildFTS5Query` to use OR**

In `src/qmd/store.ts:1996`, change the single line:

```typescript
// Current (line 1996):
  return terms.map(t => `"${t}"*`).join(' AND ');

// New:
  return terms.map(t => `"${t}"*`).join(' OR ');
```

**Do NOT change anything else** in the function. Keep `sanitizeFTS5Term()` call, keep `string | null` return type, keep the `null` return for empty input.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import jiti/register --test tests/store.test.ts`
Expected: All buildFTS5Query tests PASS

- [ ] **Step 5: Run full test suite to check for regressions**

Run: `node --import jiti/register --test tests/*.test.ts`
Expected: All existing tests pass. Note that OR matching returns a superset of AND results, so any test asserting "FTS found document X" will still pass. However, **score rankings may change** because partial matches dilute BM25 scores. Check for any tests that assert specific score values or orderings.

- [ ] **Step 6: Run evaluation to measure FTS improvement**

Run: `node --import jiti/register --test tests/retrieval-quality.test.ts`
Run: `node --import jiti/register --test tests/beir-retrieval.test.ts`

Record new FTS metrics. Expected improvements:
- SciFact FTS R@5 should rise significantly from 0.055 (92% zero-recall is unacceptable)
- FiQA FTS R@5 should rise from 0.005
- Golden FTS R@5 should rise from 0.383
- Hybrid should also improve since BM25 now contributes useful signal to fusion

- [ ] **Step 7: Commit**

```bash
git add src/qmd/store.ts tests/store.test.ts
git commit -m "fix: use OR matching in FTS5 queries for better recall"
```

---

## Chunk 3: Fix B.2 — Chunk-Level FTS Indexing (Optional, Higher Effort)

### Problem

`searchFTS()` indexes full document bodies in the `documents_fts` virtual table. BM25 scores are computed over the entire document, not individual chunks. This means:

1. Long documents with many keyword mentions get disproportionately high scores
2. Short, dense documents (like MEMORY.md at 2030 chars) get diluted scores
3. The "best chunk" selection (Step 5) is a post-hoc heuristic that can pick the wrong chunk

### Solution: Index chunks in FTS, not full documents

This is a deeper change that touches the FTS table schema and indexing pipeline. It should be attempted **only after Fix A and Fix B are verified and their combined metrics measured**.

### Task 3: Add chunk-level FTS indexing

**Files:**
- Modify: `src/qmd/store.ts` — FTS table creation, `insertContent()`, `searchFTS()`
- Modify: `src/qmd/db.ts` — Schema migration for chunk-level FTS table

- [ ] **Step 1: Design the chunk-level FTS schema**

Current FTS table (in `db.ts`):
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts
USING fts5(title, body, content=documents, content_rowid=id);
```

New approach — a separate `chunks_fts` table:
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
USING fts5(title, body, hash UNINDEXED, seq UNINDEXED);
```

Where `hash` is the content hash and `seq` is the chunk sequence number. `UNINDEXED` means these columns are stored but not searchable — they're metadata for joining back to documents.

- [ ] **Step 2: Write the failing test**

```typescript
it("FTS search returns chunk-level results with better precision for multi-topic docs", () => {
  // Create a store with a document that has two distant topics
  const store = createStore(":memory:");
  const longBody = [
    "# Machine Learning\n",
    "Neural networks are used for image classification. ".repeat(50),
    "\n\n# Database Optimization\n",
    "Index tuning improves query performance significantly. ".repeat(50),
  ].join("");

  // Index the doc
  const hash = hashContentSync(longBody);
  insertContent(store.db, hash, longBody, new Date().toISOString());
  insertDocument(store.db, "test", "ml-and-db.md", "ML and DB", hash, now, now);

  // Search for "database optimization index tuning" — should find the doc
  const results = store.searchFTS("database optimization index tuning", 5, "test");
  assert.ok(results.length > 0, "Should find the document");

  // The key assertion: the result should indicate which chunk matched,
  // not just the full document
  // (Details depend on searchFTS return type changes — flesh out after schema design)
});
```

- [ ] **Step 3: Add `chunks_fts` table creation to `db.ts`**

In the schema initialization, add the new FTS table alongside the existing one. Keep the old table for backward compatibility during migration.

- [ ] **Step 4: Modify `insertContent()` to also populate `chunks_fts`**

After inserting the full document body, chunk it and insert each chunk into `chunks_fts`:

```typescript
const chunks = chunkDocument(body);
for (let seq = 0; seq < chunks.length; seq++) {
  db.prepare(`INSERT INTO chunks_fts(title, body, hash, seq) VALUES (?, ?, ?, ?)`)
    .run(title, chunks[seq].text, hash, seq);
}
```

- [ ] **Step 5: Modify `searchFTS()` to query `chunks_fts`**

Replace the `documents_fts` query with a `chunks_fts` query. Join back to documents for file path and metadata. Dedup by filepath, keeping the highest-scoring chunk.

- [ ] **Step 6: Run evaluation to verify chunk-level FTS improves scores**

Run: `node --import jiti/register --test tests/retrieval-quality.test.ts`

Expected: FTS scores improve for queries targeting specific sections of multi-topic documents (e.g., golden queries in the `multi_topic_doc` and `factoid_lookup` categories).

- [ ] **Step 7: Run full test suite**

Run: `node --import jiti/register --test tests/*.test.ts`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/qmd/store.ts src/qmd/db.ts tests/store.test.ts
git commit -m "feat: chunk-level FTS indexing for better BM25 precision"
```

---

## Verification Checklist

After all fixes are applied, run the full evaluation suite and compare against baselines:

```bash
# Golden corpus (fast, no network needed for FTS):
node --import jiti/register --test tests/retrieval-quality.test.ts

# BEIR FTS-only (fast):
node --import jiti/register --test tests/beir-retrieval.test.ts

# BEIR full hybrid (requires embedder, ~6min):
BEIR_FULL=1 node --import jiti/register --test tests/beir-retrieval.test.ts

# Full test suite (should still pass all 309+ tests):
node --import jiti/register --test tests/*.test.ts
```

### Success Criteria

| Benchmark | Metric | Baseline | Target | Rationale |
|-----------|--------|----------|--------|-----------|
| Golden | Hybrid R@5 | 0.700 | ≥ 0.700 | Must not regress |
| Golden | FTS R@5 | 0.383 | ≥ 0.450 | OR matching helps keyword queries too |
| SciFact | Hybrid R@5 | 0.794 | ≥ 0.880 | Should approach vector-only (0.900) |
| SciFact | FTS R@5 | 0.055 | ≥ 0.200 | OR matching dramatically improves NL queries |
| FiQA | Hybrid R@5 | 0.456 | ≥ 0.700 | Should approach vector-only (0.752) |
| FiQA | FTS R@5 | 0.005 | ≥ 0.100 | OR matching helps here too |

### Non-Regression

- All 309+ existing tests must pass
- Hybrid must never be worse than vector-only on any benchmark (enforced by the new adaptive fusion test)
- Latency must not increase by more than 20% (OR matching may return more FTS results)

### Cross-Fix Interaction

Fix A and Fix B interact: after Fix B, BM25 returns useful results for more queries, so Fix A's quality gate triggers less often. **The final metric validation must run with both fixes applied together.** Individual fix metrics are intermediate checkpoints only.

## Implementation Order

1. **Fix B (OR matching)** first — simpler, one-line change, improves FTS baseline everywhere, and makes BM25 more useful for Fix A's quality gate
2. **Fix A (adaptive fusion)** second — handles remaining cases where BM25 is still useless even with OR matching
3. **Fix B.2 (chunk-level FTS)** — optional, depends on Fix B, higher effort

Fix A and Fix B touch different parts of `store.ts` (fusion logic vs query builder) so they could technically be implemented in parallel, but sequential is safer to isolate metric changes.
