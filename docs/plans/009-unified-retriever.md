# Unified Retriever Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the dual-pipeline architecture (separate MemoryRetriever + hybridQuery + UnifiedRecall) with a single UnifiedRetriever that searches all sources in one pass with one embed call, one optional rerank call, z-score calibration, and durability-aware time decay.

**Architecture:** Single `src/unified-retriever.ts` (~500 LOC) implements the 10-stage pipeline from `docs/research/unified-pipeline-design.md`. All data access layers (`memory.ts`, `search.ts`, `embedder.ts`) remain unchanged. The new retriever consumes their existing search methods directly.

**Tech Stack:** TypeScript (jiti, no build step), SQLite FTS5, sqlite-vec, cross-encoder reranker (bge-reranker-v2-m3)

---

## Context

The current system runs two independent retrieval pipelines:
- `MemoryRetriever` (src/retriever.ts) — 7-stage scoring with its own embed + rerank
- `hybridQuery` (src/search.ts) — query expansion + embed + rerank + RRF fusion
- `UnifiedRecall` (src/unified-recall.ts) — merges results from both

Problems: 4 API calls/query, 2-4 model swaps, score incompatibility between sources, 82.5% score compression from multiplicative cascade. See `docs/research/unified-pipeline-design.md` for full analysis.

## Design Reference

Full pipeline specification: `docs/research/unified-pipeline-design.md`
Mathematical foundations: `docs/research/ranking-mathematics.md`
SOTA survey: `docs/research/memory-retrieval-sota.md`

## Files

| File | Action | Purpose |
|------|--------|---------|
| `src/unified-retriever.ts` | **Create** | The new pipeline (~500 LOC) |
| `src/tools.ts` | **Modify** | Wire `memory_recall` tool to use UnifiedRetriever |
| `index.ts` | **Modify** | Create UnifiedRetriever, pass to tools |
| `tests/unified-retriever.test.ts` | **Create** | Pipeline tests with mock stores |
| `tests/unified-retriever-benchmark.test.ts` | **Create** | Latency + API call count benchmarks |

Files **NOT** modified: `src/memory.ts`, `src/search.ts`, `src/embedder.ts`, `src/retriever.ts` (kept for backward compat).

## Acceptance Criteria

| Criteria | Target |
|----------|--------|
| All existing 398+ tests pass | 0 failures |
| API calls per query (avg) | ≤ 2 |
| Latency p50 (no swap) | < 200ms |
| Model swaps per query (avg) | ≤ 1 |
| Issue #7 ground truth | ≥ 6/8 (from current 4/8) |
| Source diversity | Both sources represented in top-5 when both have results |

---

## Chunk 1: Core Pipeline (Tasks 1-3)

### Task 1: UnifiedRetriever — Types and Skeleton

**Files:**
- Create: `src/unified-retriever.ts`
- Create: `tests/unified-retriever.test.ts`

**Design:** Define the public interface, config type, result type, and a skeleton class with all stage methods stubbed out.

- [ ] **Step 1: Create type definitions and class skeleton**

Create `src/unified-retriever.ts` with:

```typescript
import type { MemoryStore, MemoryEntry, MemorySearchResult } from "./memory.js";
import type { Embedder } from "./embedder.js";

export interface UnifiedRetrieverConfig {
  /** Max results to return (default: 10) */
  limit: number;
  /** Minimum score threshold (default: 0.15) */
  minScore: number;
  /** Source weights for calibrated score merge */
  conversationWeight: number;  // default 0.55
  documentWeight: number;      // default 0.45
  /** Reranker config (null = no reranking) */
  reranker: {
    endpoint: string;
    apiKey: string;
    model: string;
    provider: string;
  } | null;
  /** Enable query expansion via generation model (default: false) */
  queryExpansion: boolean;
  /** Candidate pool size before reranking (default: 15) */
  candidatePoolSize: number;
  /** Confidence gate: skip rerank if top score exceeds this (default: 0.88) */
  confidenceThreshold: number;
  /** Confidence gate: skip rerank if gap between top-1 and top-2 exceeds this (default: 0.15) */
  confidenceGap: number;
}

export interface UnifiedResult {
  id: string;
  text: string;
  score: number;
  source: "conversation" | "document";
  metadata: Record<string, any>;
}

export type SourceRoute = "memory" | "document" | "both";

export class UnifiedRetriever {
  constructor(
    private memoryStore: MemoryStore,
    private documentSearchFn: ((query: string, queryVec: number[], limit: number, collection?: string) => Promise<DocumentCandidate[]>) | null,
    private embedder: Embedder,
    private config: Partial<UnifiedRetrieverConfig>,
  ) {}

  async retrieve(query: string, options?: {
    limit?: number;
    scopeFilter?: string[];
    collection?: string;
    recentlyRecalled?: Set<string>;
  }): Promise<UnifiedResult[]> {
    // Stages implemented in subsequent tasks
    return [];
  }

  routeQuery(query: string): SourceRoute { return "both"; }
}
```

The `documentSearchFn` is a thin wrapper that callers provide — it calls the existing `searchFTS` + `searchVec` from `search.ts` using a pre-computed query vector. This avoids duplicating the search logic.

Also define `DocumentCandidate`:

```typescript
export interface DocumentCandidate {
  filepath: string;
  displayPath: string;
  title: string;
  body: string;
  bestChunk: string;
  bestChunkPos: number;
  score: number;
  docid: string;
  context: string | null;
}
```

- [ ] **Step 2: Write initial tests**

Create `tests/unified-retriever.test.ts` with:
- Construction test (creates instance without error)
- `routeQuery` returns "both" for ambiguous queries
- `retrieve` returns empty array for empty stores
- Type check: result has `id`, `text`, `score`, `source`, `metadata`

- [ ] **Step 3: Run tests**

Run: `node --import jiti/register --test tests/unified-retriever.test.ts`

- [ ] **Step 4: Commit**

---

### Task 2: Source Routing + Parallel Retrieval

**Files:**
- Modify: `src/unified-retriever.ts`
- Modify: `tests/unified-retriever.test.ts`

**Design:** Implement stages 0-3 (skip check, source routing, embed, parallel retrieval). The retrieve method should embed the query once, then fan out to memory and document search based on the route.

- [ ] **Step 1: Write routing tests**

Tests for `routeQuery()`:
- "what's my TTS voice" → "memory"
- "I told you about X" → "memory"
- "what does REQUIREMENTS.md say" → "document"
- "how to deploy" → "both"
- "what did we decide about NetBird" → "both"
- "config file for X" → "document"

- [ ] **Step 2: Implement routeQuery()**

Heuristic regex classifier from the design doc (lines 236-252).

- [ ] **Step 3: Write retrieval tests**

Tests using mock stores:
- Route "memory" → only memory store is queried
- Route "document" → only document search is called
- Route "both" → both are queried
- Query vector is computed once and reused

- [ ] **Step 4: Implement retrieve() stages 0-3**

Stages:
1. Skip check (import `shouldSkipRetrieval` from existing code)
2. Route query
3. Embed query (single call to `embedder.embedQuery`)
4. Fan out to memory vec + BM25 and/or document search based on route

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

---

### Task 3: Fusion + Z-Score Calibration

**Files:**
- Modify: `src/unified-retriever.ts`
- Modify: `tests/unified-retriever.test.ts`

**Design:** Implement stages 4-6 (memory fusion, document candidate collection, z-score calibration). This is where scores from both sources become comparable.

- [ ] **Step 1: Write z-score calibration tests**

Tests:
- Uniform scores [0.5, 0.5, 0.5] → all calibrate to 0.5
- Spread scores [0.1, 0.5, 0.9] → calibrate to [~0.12, 0.5, ~0.88]
- Single result → calibrates to 0.5
- Empty array → returns empty
- Two sources with different score distributions produce comparable calibrated scores

- [ ] **Step 2: Implement calibrate() function**

```typescript
function calibrate(scores: number[]): (score: number) => number {
  const n = scores.length;
  if (n < 2) return () => 0.5;
  const mean = scores.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(scores.reduce((a, s) => a + (s - mean) ** 2, 0) / n);
  const safeStd = Math.max(std, 0.01);
  return (score: number) => 1 / (1 + Math.exp(-(score - mean) / safeStd));
}
```

- [ ] **Step 3: Write fusion tests**

Tests:
- Memory vec + BM25 results fuse correctly (vec score + BM25 boost)
- Document results collected with best chunk
- Fused + calibrated pool has scores in [0, 1]
- Source weights applied (0.55 conv, 0.45 doc)

- [ ] **Step 4: Implement memory fusion (stage 4)**

Same formula as current retriever: `fused = vec_score + bm25_hit * 0.15 * vec_score`

- [ ] **Step 5: Implement pool + calibrate (stage 6)**

Z-score per source → sigmoid → multiply by source weight.

- [ ] **Step 6: Run tests**

- [ ] **Step 7: Run full test suite for regressions**

- [ ] **Step 8: Commit**

---

## Chunk 2: Scoring + Reranking (Tasks 4-5)

### Task 4: Confidence-Gated Reranking

**Files:**
- Modify: `src/unified-retriever.ts`
- Modify: `tests/unified-retriever.test.ts`

**Design:** Implement stage 7 (confidence-gated reranking). The reranker fires only when the top result isn't clearly dominant, saving ~50ms + model swap on ~25-30% of queries.

- [ ] **Step 1: Write confidence gate tests**

Tests for `shouldRerank()`:
- Top score 0.95, second 0.40 → skip (gap > 0.15)
- Top score 0.90 → skip (> 0.88 threshold)
- Top score 0.60, second 0.55 → rerank (close scores, below threshold)
- Single result → skip
- Empty pool → skip

- [ ] **Step 2: Implement shouldRerank()**

- [ ] **Step 3: Write rerank integration tests**

Tests using mock reranker:
- When gate triggers: rerank is called, scores are blended (0.7 rerank + 0.3 calibrated)
- When gate skips: rerank is NOT called, calibrated scores pass through
- Reranker failure: falls back to calibrated scores (no error thrown)

- [ ] **Step 4: Implement rerank stage**

Use `buildRerankRequest` / `parseRerankResponse` from existing `retriever.ts` (already exported). Send mixed memory text + document bestChunk in one batch.

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

---

### Task 5: Post-Merge Modifiers + Floor Guarantee

**Files:**
- Modify: `src/unified-retriever.ts`
- Modify: `tests/unified-retriever.test.ts`

**Design:** Implement stage 8 (temporal decay, importance, length norm, floor guarantee) and stage 9 (source diversity + final selection).

- [ ] **Step 1: Write durability inference tests**

Tests for `inferDurability()`:
- High importance preference → "permanent"
- Low importance fact → "ephemeral" (if text contains temporal markers)
- Default → "transient"

- [ ] **Step 2: Implement inferDurability()**

- [ ] **Step 3: Write time decay tests**

Tests:
- Permanent memory (preference, importance 0.9): no decay regardless of age
- Transient memory (fact, importance 0.6, 30 days old): moderate decay
- Ephemeral memory (fact, importance 0.3, 14 days old): heavy decay
- Document results: no decay applied

- [ ] **Step 4: Implement durability-aware time decay**

- [ ] **Step 5: Write floor guarantee tests**

Tests:
- High calibrated score (0.8) with heavy modifiers → floor at 0.2 (25% of 0.8)
- Low calibrated score (0.2) with no modifiers → no floor needed
- Floor prevents results from dropping below minScore

- [ ] **Step 6: Implement floor guarantee + importance + length norm**

- [ ] **Step 7: Write source diversity tests**

Tests:
- Both sources have results: both appear in final output
- One source has 0 results: only other source appears
- Protected top-1 survives even below minScore

- [ ] **Step 8: Implement source diversity + final selection**

- [ ] **Step 9: Run full test suite**

- [ ] **Step 10: Commit**

---

## Chunk 3: Integration + Validation (Tasks 6-8)

### Task 6: Wire into Tools + Index

**Files:**
- Modify: `src/tools.ts` — use UnifiedRetriever for `memory_recall`
- Modify: `index.ts` — create UnifiedRetriever, pass to tools
- Modify: `tests/unified-retriever.test.ts` — end-to-end with real SQLite

**Design:** Create the UnifiedRetriever in `index.ts`, build the `documentSearchFn` wrapper around existing search functions, and wire `memory_recall` tool to use it instead of the old UnifiedRecall.

- [ ] **Step 1: Create documentSearchFn wrapper in index.ts**

A thin function that takes `(query, queryVec, limit, collection?)` and calls `searchFTS()` + `searchVec()` from the search store, merges results (take best score per filepath), and returns `DocumentCandidate[]`.

- [ ] **Step 2: Create UnifiedRetriever in index.ts register()**

```typescript
const unifiedRetriever = new UnifiedRetriever(
  store,
  documentSearchFn,
  embedder,
  {
    reranker: config.reranker?.enabled !== false ? {
      endpoint: config.reranker.endpoint,
      apiKey: resolveEnvVars(config.reranker.apiKey),
      model: config.reranker.model,
      provider: config.reranker.provider,
    } : null,
    queryExpansion: config.retrieval?.queryExpansion ?? false,
  }
);
```

- [ ] **Step 3: Update memory_recall tool to use UnifiedRetriever**

In `src/tools.ts`, the recall tool currently calls `unifiedRecall.recall()` or `retriever.retrieve()`. Update to call `unifiedRetriever.retrieve()`.

Keep the old code path behind a feature flag for rollback:
```typescript
const useUnifiedRetriever = config.unifiedRetriever !== false; // default true
```

- [ ] **Step 4: Write end-to-end test with real SQLite**

Test that creates a temp SQLite DB, inserts memories + documents, and verifies:
- Single-source query (factoid) returns memory results
- Document query returns doc results
- Mixed query returns both sources
- Scores are in [0, 1] and properly ordered

- [ ] **Step 5: Run full test suite**

- [ ] **Step 6: Commit**

---

### Task 7: Benchmark Tests

**Files:**
- Create: `tests/unified-retriever-benchmark.test.ts`

**Design:** Benchmark the new pipeline against acceptance criteria.

- [ ] **Step 1: Write API call count benchmark**

Test that counts actual API calls (embed + rerank) per query type:
- Factoid lookup → ≤ 1 API call (embed only, rerank skipped)
- Mixed query → ≤ 2 API calls (embed + rerank)
- Average across 10 query types → ≤ 2

- [ ] **Step 2: Write latency benchmark**

Test with mock embedder (instant) and mock reranker (instant):
- Pipeline overhead (excluding API latency) < 10ms
- With simulated API latency (75ms embed, 50ms rerank): total < 200ms

- [ ] **Step 3: Write source diversity benchmark**

Test with equal-quality results from both sources:
- Both sources appear in top-5
- No source has 0 representation when it has results

- [ ] **Step 4: Run benchmarks**

- [ ] **Step 5: Commit**

---

### Task 8: Issue #7 Ground Truth Validation

**Files:**
- Modify: `tests/session-import-quality.test.ts`

**Design:** Test the UnifiedRetriever against the issue #7 ground truth queries using the production database.

- [ ] **Step 1: Add UnifiedRetriever recall tests**

For each issue #7 query, test that the UnifiedRetriever finds the expected result:
- "TTS voice Alice" → memory about Alice in results
- "don't apologize ban sorry" → memory about banning sorry
- "private repos GitHub" → memory about private repos
- "NetBird Tailscale" → memory about NetBird
- "Discord notifications channel" → correct channel ID
- Vault expiry → (skip, extraction gap)

- [ ] **Step 2: Set quality floor**

Assert coverage ≥ 6/8 (up from current 4/8).

- [ ] **Step 3: Run quality tests**

- [ ] **Step 4: Commit**

---

## Chunk 4: Deploy + Cleanup (Tasks 9-10)

### Task 9: Deploy and Production Test

- [ ] **Step 1: Deploy to openclaw plugin**

```bash
rm -rf ~/.openclaw/plugins/memex
cp -r . ~/.openclaw/plugins/memex
rm -rf ~/.openclaw/plugins/memex/.git ~/.openclaw/plugins/memex/.claude
```

- [ ] **Step 2: Restart gateway**

```bash
openclaw gateway restart
```

- [ ] **Step 3: Verify startup logs**

Check for: `documents: enabled`, `initialized successfully`, no errors.

- [ ] **Step 4: Test live queries**

Run the issue #7 queries through `openclaw memex search` and verify results.

- [ ] **Step 5: Monitor for 5 minutes**

Check gateway logs for errors or unexpected behavior.

---

### Task 10: Documentation Update

- [ ] **Step 1: Update CLAUDE.md**

Update architecture section, performance profile, test counts.

- [ ] **Step 2: Update docs/RESILIENCY.md**

Add the new pipeline's failure modes and recovery paths.

- [ ] **Step 3: Commit**

---

## Verification

After all tasks complete:
1. All 398+ existing tests pass
2. New unified-retriever tests pass (30+ tests)
3. Benchmark tests pass (API calls ≤ 2, latency < 200ms)
4. Issue #7 ground truth ≥ 6/8
5. Production deployment working
6. No regressions in live recall quality
